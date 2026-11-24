#!/usr/bin/env node
/**
 * Two launches, two ports, one set of preferences (issue #285).
 *
 * ## Why this exists as a script rather than a test
 *
 * The defect is about the PROCESS LIFECYCLE: the desktop shell starts the orchestrator with `--port 0`, the OS picks a
 * port, the window loads that origin, and the next launch gets a different one. A unit test can model that (see
 * `packages/ui/test/prefs-store.test.ts`, which runs two stores with different seeds against one installation), but
 * it cannot produce two restarts of a real server on two real ports with a real file between them.
 *
 * The issue records the relaunch case as `verified/manual` for exactly this reason. This script is that measurement
 * made repeatable: it starts the orchestrator twice, writes a preference in the first, reads it in the second, and
 * asserts the two ports differ — which is the fact the whole defect rests on.
 *
 * It does NOT open the desktop app. That step stays manual, and is the one the issue's acceptance criteria name.
 *
 * ## Usage
 *
 *     node scripts/verify-prefs-285.mjs
 *
 * Exits 0 when both launches agree, 1 with a diagnosis otherwise. Never touches the reader's own state: it runs with
 * `PI_CENTRAL_STATE` pointed at a temporary directory it removes afterwards.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "packages", "orchestrator", "src", "server.ts");
const state = mkdtempSync(join(tmpdir(), "pi-central-285-"));
const MODEL_SCOPE = "pi-central.model-scope";
const SCOPE = JSON.stringify({ models: [{ provider: "openai", id: "gpt-5" }, { provider: "anthropic", id: "claude-x" }] });

/** Start the orchestrator on an EPHEMERAL port — `--port 0`, which is the shell's rule, not a default. */
function launch() {
  const child = spawn(process.execPath, [server, "--port", "0", "--no-ui", "--allow-unsandboxed-host"], {
    cwd: root,
    env: { ...process.env, PI_CENTRAL_STATE: state, PI_CENTRAL_WORKSPACE: join(state, "workspaces") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  child.stderr.on("data", (chunk) => void (buffer += String(chunk)));
  return new Promise((resolveUri, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no URL within 15s; stderr: ${buffer}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const match = /PI_CENTRAL_URL=ws:\/\/127\.0\.0\.1:(\d+)/.exec(buffer);
      if (match === null) return;
      clearTimeout(timer);
      resolveUri({ child, port: Number(match[1]), url: match[0].slice("PI_CENTRAL_URL=".length) });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited (code=${code}) before announcing a URL; stderr: ${buffer}`));
    });
  });
}

/** One request/response over the socket, in the shape the UI uses. */
async function ask(url, control, expectKind) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  const answer = new Promise((resolveAnswer, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expectKind}`)), 5000);
    socket.on("message", (data) => {
      const payload = JSON.parse(String(data)).payload;
      if (payload.kind !== expectKind) return;
      clearTimeout(timer);
      resolveAnswer(payload);
    });
  });
  socket.send(JSON.stringify({ dir: "client\u2192orchestrator", protocol: 13, payload: control }));
  const payload = await answer;
  socket.close();
  return payload;
}

async function stop(child) {
  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    child.once("exit", resolveExit);
    setTimeout(() => child.kill("SIGKILL"), 3000);
  });
}

const failures = [];
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push(`${label}: ${detail}`);
  console.log(`  FAIL ${label} — ${detail}`);
}

let first;
let second;
try {
  console.log("launch A");
  first = await launch();
  console.log(`  port ${first.port}`);
  const written = await ask(first.url, { kind: "setPrefs", prefs: { [MODEL_SCOPE]: SCOPE } }, "prefs");
  check("A stored the list it was given", written.prefs[MODEL_SCOPE] === SCOPE, JSON.stringify(written.prefs));
  await stop(first.child);
  first = undefined;

  console.log("launch B");
  second = await launch();
  console.log(`  port ${second.port}`);

  /*
   * THE assertion. Two consecutive launches binding different ports is the condition the defect needs; if the OS
   * happened to hand out the same port twice, this run would prove nothing and the script must say so rather than
   * pass on a coincidence.
   */
  check("the two launches bound DIFFERENT ports", first?.port !== second.port, "the same port twice, which proves nothing");

  const read = await ask(second.url, { kind: "getPrefs" }, "prefs");
  check("B read the list A wrote", read.prefs[MODEL_SCOPE] === SCOPE, JSON.stringify(read.prefs));

  // And the file is where the installation keeps it, not inside an origin's storage.
  const onDisk = JSON.parse(readFileSync(join(state, "preferences.json"), "utf8"));
  check("the list is in the installation's state root", onDisk.prefs?.[MODEL_SCOPE] === SCOPE, JSON.stringify(onDisk));
} catch (error) {
  failures.push(String(error.message ?? error));
  console.log(`  FAIL ${String(error.message ?? error)}`);
} finally {
  if (first !== undefined) await stop(first.child).catch(() => {});
  if (second !== undefined) await stop(second.child).catch(() => {});
  rmSync(state, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nverify-prefs-285: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nverify-prefs-285: a preference written in one launch is there in the next, on a different port");
