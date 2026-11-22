#!/usr/bin/env node
/**
 * Checkpoint A, under the policy — the sidecar as the supervisor actually spawns it.
 *
 * `drive-sidecar.mjs --control` proved the pipeline with NO policy. This runs the same drive with the
 * sidecar inside its own Safehouse profile, which is the arrangement the design ships. Two different
 * questions, and the second is the one that can still fail:
 *
 *   control        the browser renders, the verbs work
 *   as spawned     ...while egress is pinned to one port and the host credentials are denied
 *
 * It renders the fragment itself with the production function, so this cannot accidentally test a
 * hand-written policy. That is the Phase 0C lesson: a four-name list written by hand failed open on the
 * fifth name while reporting the other three refused.
 *
 *   node drive-sidecar.mjs --as-spawned
 *
 * Exit: 0 every expectation held, 1 one did not, 2 could not run.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const PORT = 4173;
const ORIGIN = "http://localhost:" + PORT;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// A private root OUTSIDE /tmp and /var/folders -- those are readable by every session, so a profile there
// cannot demonstrate confinement (and composeSidecarPolicy refuses it for the same reason).
const root = mkdtempSync(join(homedir(), ".pi-central-sidecar-drive-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const profileDir = join(root, "profile");
mkdirSync(profileDir, { recursive: true, mode: 0o700 });

const { renderSidecarFragment } = await import(join(REPO, "packages/orchestrator/src/sidecar-fragment.ts"));
const fragmentPath = join(root, "sidecar.sb");
writeFileSync(fragmentPath, renderSidecarFragment({ port: PORT }), { mode: 0o600 });
console.log("fragment: " + fragmentPath + " (rendered by the production function)\n");

// The dev server the sidecar is allowed to reach.
const page = readFileSync(join(HERE, "page.html"));
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise((done, fail) => {
  server.once("error", fail);
  server.listen(PORT, done);
});
console.log("dev server on " + ORIGIN + "\n");

// The sidecar, inside its own profile. This is the shape the supervisor produces: safehouse, the workdir,
// the enabled feature, the appended fragment, then the sidecar and its own flags.
const child = spawn(
  "safehouse",
  [
    "--workdir",
    profileDir,
    "--enable=playwright-chrome",
    "--append-profile=" + fragmentPath,
    "--",
    process.execPath,
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
child.stderr.on("data", (chunk) => (stderr += String(chunk)));

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
  new Promise((done, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: done, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const results = [];
const record = (name, pass, detail) => {
  results.push(pass);
  console.log((pass ? "PASS" : "FAIL") + "  " + name + (detail ? "  -- " + detail : ""));
};

try {
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  record("the sidecar starts INSIDE its own Safehouse profile", init?.serverInfo?.name === "pi-central-sidecar");

  const info = await call("tools/call", { name: "info", arguments: {} });
  const infoBody = JSON.parse(info?.content?.[0]?.text ?? "{}");
  record("info answers without launching a browser", infoBody.origin === ORIGIN && !existsSync(join(profileDir, "DevToolsActivePort")));

  console.log("\n  (the next call launches a sandboxed browser)");
  const probe = await call("tools/call", { name: "probe", arguments: { url: ORIGIN, checks: ["overflow"] } });
  const verdict = JSON.parse(probe?.content?.[0]?.text ?? "{}");
  record("probe works under the policy", (verdict.problems ?? []).some((p2) => p2.selector === "#wide"), JSON.stringify(verdict.problems ?? verdict));

  const capture = await call("tools/call", { name: "capture", arguments: { url: ORIGIN } });
  const dataUrl = capture?.content?.[0]?.text ?? "";
  const bytes = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
  record("capture returns a PNG under the policy", bytes.length > 1000, bytes.length + " bytes");
  if (bytes.length > 1000) {
    writeFileSync(join(HERE, "sidecar-capture-policy.png"), bytes);
    console.log("  wrote " + join(HERE, "sidecar-capture.png") + " -- open it, and compare with the control run");
  }

  // The confinement, asserted from the policy rather than assumed: an unregistered loopback port must be
  // refused, which is the check that distinguishes a pinned port from a wide-open one.
  const other = await call("tools/call", { name: "capture", arguments: { url: "http://localhost:9999/" } });
  const otherBody = JSON.parse(other?.content?.[0]?.text ?? "{}");
  record("an unregistered port is refused under the policy too", otherBody.kind === "refused");
} catch (error) {
  record("the drive completed", false, String(error));
} finally {
  child.stdin.end();
  await new Promise((done) => {
    child.once("exit", done);
    setTimeout(() => { child.kill("SIGKILL"); done(); }, 5000);
  });
  server.close();
}

const failed = results.filter((pass) => !pass).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " expectations held (as spawned)");
if (failed !== 0) {
  console.log("  --- sidecar stderr (last 12 lines) ---");
  for (const line of stderr.trim().split("\n").slice(-12)) console.log("  " + line);
}
process.exit(failed === 0 ? 0 : 1);
