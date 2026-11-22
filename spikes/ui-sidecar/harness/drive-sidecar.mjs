#!/usr/bin/env node
/**
 * Checkpoint A — talk to the sidecar directly, with no Pi in the way.
 *
 * This drives the four verbs the way Pi will: `initialize`, `tools/list`, then `tools/call`. What it proves
 * is the whole pipeline except Pi's plumbing — the process starts, a browser launches under a policy, a
 * page renders, and bytes come back.
 *
 * **Two modes, and the second is the one that matters:**
 *
 *   node drive-sidecar.mjs --control
 *       No Safehouse. If the browser cannot render here, a sandboxed failure below says nothing.
 *
 *   safehouse --workdir=<private dir> --enable=playwright-chrome \
 *     --append-profile=<rendered fragment> -- node drive-sidecar.mjs --as-spawned
 *       The sidecar as the supervisor will spawn it. Use `renderSidecarFragment` to produce the profile;
 *       the harness prints the exact command rather than taking a path argument, because a wrong fragment
 *       would make this a test of the wrong thing.
 *
 * Exit: 0 every expectation held, 1 one did not, 2 could not run.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const PORT = 4173;
const ORIGIN = `http://localhost:${PORT}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const mode = process.argv.includes("--as-spawned") ? "as-spawned" : process.argv.includes("--control") ? "control" : undefined;
if (mode === undefined) {
  console.error("Say which mode: --control or --as-spawned (see PHASE-0C.md, Checkpoint A)");
  process.exit(2);
}

const results = [];
const record = (name, pass, detail) => {
  results.push(pass);
  console.log((pass ? "PASS" : "FAIL") + "  " + name + (detail ? "  -- " + detail : ""));
};

// --- 1. The dev server the sidecar is allowed to reach. ---------------------------------------
const page = readFileSync(join(REPO, "spikes/ui-sidecar/harness/page.html"));
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise((done, fail) => {
  server.once("error", fail);
  server.listen(PORT, done);
});
console.log(`mode: ${mode} | dev server on ${ORIGIN}\n`);

// --- 2. Spawn the sidecar exactly as the supervisor would: stdio MCP. -------------------------
const privateRoot = mkdtempSync(join(process.env["PI_CENTRAL_TEST_PRIVATE_ROOT"] ?? tmpdir(), "sidecar-drive-"));
process.on("exit", () => rmSync(privateRoot, { recursive: true, force: true }));
const profileDir = join(privateRoot, "profile");
mkdirSync(profileDir, { recursive: true, mode: 0o700 });

const child = spawn(
  process.execPath,
  [
    join(REPO, "packages/orchestrator/src/sidecar.ts"),
    "--executable",
    CHROME,
    "--profile",
    profileDir,
    "--origin",
    ORIGIN,
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

// --- 3. A minimal MCP client over the pipe. ---------------------------------------------------
let nextId = 1;
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(message.id);
    if (waiter === undefined) continue;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  }
});

const call = (method, params = {}) =>
  new Promise((resolve_, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve_, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const stop = async () => {
  child.stdin.end();
  await new Promise((done) => {
    child.once("exit", done);
    setTimeout(() => { child.kill("SIGKILL"); done(); }, 5000);
  });
  server.close();
};

try {
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  record("the sidecar answers initialize", init?.serverInfo?.name === "pi-central-sidecar", JSON.stringify(init?.serverInfo));

  const list = await call("tools/list");
  const names = (list?.tools ?? []).map((tool) => tool.name).sort();
  record("it advertises four verbs", JSON.stringify(names) === JSON.stringify(["act", "capture", "info", "probe"]), names.join(", "));

  const info = await call("tools/call", { name: "info", arguments: {} });
  const infoBody = JSON.parse(info?.content?.[0]?.text ?? "{}");
  record("info reports the origin WITHOUT launching a browser", infoBody.origin === ORIGIN && !existsSync(join(profileDir, "DevToolsActivePort")), infoBody.origin);

  const refused = await call("tools/call", { name: "capture", arguments: { url: "http://localhost:9999/" } });
  const refusedBody = JSON.parse(refused?.content?.[0]?.text ?? "{}");
  record("an unregistered origin is refused", refusedBody.kind === "refused", refusedBody.reason);

  const sm = await call("tools/call", { name: "capture", arguments: { url: ORIGIN, method: "Runtime.evaluate" } });
  const smBody = JSON.parse(sm?.content?.[0]?.text ?? "{}");
  record("a smuggled CDP method is refused", smBody.kind === "refused" && /method/.test(smBody.message ?? ""), smBody.message);

  console.log("\n  (the next call launches a browser, which takes a few seconds)");
  const probe = await call("tools/call", { name: "probe", arguments: { url: ORIGIN, checks: ["overflow"] } });
  const verdict = JSON.parse(probe?.content?.[0]?.text ?? "{}");
  const found = (verdict.problems ?? []).some((problem) => problem.selector === "#wide");
  record("probe finds the deliberate overflow", found, JSON.stringify(verdict.problems));

  const capture = await call("tools/call", { name: "capture", arguments: { url: ORIGIN } });
  const dataUrl = capture?.content?.[0]?.text ?? "";
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const bytes = Buffer.from(base64, "base64");
  record("capture returns PNG bytes", bytes.length > 1000 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), bytes.length + " bytes");
  if (mode === "control") {
    const out = join(HERE, "sidecar-capture.png");
    writeFileSync(out, bytes);
    console.log("  wrote " + out + " -- open it");
  }
} catch (error) {
  record("the sidecar survived the drive", false, String(error));
  console.log("  --- sidecar stderr ---");
  for (const line of stderr.trim().split("\n").slice(-12)) console.log("  " + line);
} finally {
  await stop();
}

const failed = results.filter((pass) => !pass).length;
console.log(`\n${results.length - failed}/${results.length} expectations held (${mode})`);
if (failed !== 0) {
  console.log("  --- sidecar stderr ---");
  for (const line of stderr.trim().split("\n").slice(-12)) console.log("  " + line);
}
process.exit(failed === 0 ? 0 : 1);
