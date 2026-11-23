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
// Cleanup that cannot fail the RUN. The first version threw ENOTEMPTY on exit, after all five checks had
// passed: Chrome was still writing into the profile when rm started, and an exception in an exit handler
// turns a green result into a stack trace. Two things are wrong with reporting a cleanup race as a test
// failure -- it is not a result, and it teaches the reader to ignore exit noise.
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Named, not silenced: the directory is a throwaway under $HOME and a later run will not reuse it.
    console.error("note: could not remove " + root + " (a browser was still writing). Harmless.");
  }
});
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
    // The sidecar runs from source, and a sandboxed process cannot open a script outside its workdir.
    // Without this the process never starts: no output, no exit, nothing (measured — it produced the first
    // silent hang this harness saw).
    "--add-dirs-ro=" + REPO,
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

// A HANG is the failure this harness produced once, and it produced no diagnostics at all: the sidecar could
// not open its own script inside the Sandbox, so it never wrote a byte to stdout and never exited. A drive
// with no deadline turns that into "nothing happens", which is the least useful possible report.
const DEADLINE_MS = 90_000;
const deadline = setTimeout(() => {
  console.error("\nFAIL  the drive exceeded " + DEADLINE_MS / 1000 + "s with no answer.");
  console.error("  --- sidecar stderr --- ");
  for (const line of stderr.trim().split("\n").slice(-15)) console.error("  " + line);
  if (stderr.trim() === "") {
    console.error("  (nothing on stderr: the process never started. A sandboxed sidecar needs READ access to");
    console.error("   its own code -- --add-dirs-ro=<install dir> -- or node cannot open the script.)");
  }
  child.kill("SIGKILL");
  server.close();
  process.exit(1);
}, DEADLINE_MS);
child.once("exit", () => clearTimeout(deadline));

let nextId = 1;
const pending = new Map();

const results = [];
const record = (name, pass, detail) => {
  results.push(pass);
  console.log((pass ? "PASS" : "FAIL") + "  " + name + (detail ? "  -- " + detail : ""));
};
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // A line that is not JSON on the PROTOCOL stream is a defect, not noise: the sidecar writes replies there
      // and its diagnostics go to stderr. The first version of this client did `catch { continue; }` and thereby
      // discarded the one piece of evidence for a real corruption, leaving a later call to fail with something
      // unrelated. Reported with the bytes visible instead.
      record("every stdout line is JSON-RPC", false, JSON.stringify(line.slice(0, 120)));
      continue;
    }
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

// Declared before the stdout handler, which reports a protocol defect with `record`.

try {
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  record("the sidecar starts INSIDE its own Safehouse profile", init?.serverInfo?.name === "pi-central-sidecar");

  const info = await call("tools/call", { name: "info", arguments: {} });
  const infoBody = JSON.parse(info?.content?.[0]?.text ?? "{}");
  record("info answers without launching a browser", infoBody.origin === ORIGIN && !existsSync(join(profileDir, "DevToolsActivePort")));

  console.log("\n  (the next call launches a sandboxed browser)");
  const probe = await call("tools/call", { name: "probe", arguments: { url: ORIGIN, checks: ["overflow"] } });
  // A FAILED verb returns `isError: true` with a human sentence, NOT a verdict. Parsing it blindly made
  // JSON.parse throw with a message quoting the first bytes ("sidecar er..."), and the harness reported that as
  // a protocol corruption -- hiding the real cause, which was in the sidecar's stderr. So: read the error
  // first, and only parse when the sidecar says it succeeded.
  const probeText = probe?.content?.[0]?.text ?? "";
  if (probe?.isError === true) {
    record("probe works under the policy", false, probeText.slice(0, 200));
    throw new Error("probe failed; see the line above and the stderr tail");
  }
  const verdict = JSON.parse(probeText);
  record("probe works under the policy", (verdict.problems ?? []).some((p2) => p2.selector === "#wide"), JSON.stringify(verdict.problems ?? verdict));

  const capture = await call("tools/call", { name: "capture", arguments: { url: ORIGIN } });
  const dataUrl = capture?.isError === true ? "" : (capture?.content?.[0]?.text ?? "");
  if (capture?.isError === true) {
    record("capture returns a PNG under the policy", false, String(capture?.content?.[0]?.text ?? "").slice(0, 200));
    throw new Error("capture failed; see the line above and the stderr tail");
  }
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
