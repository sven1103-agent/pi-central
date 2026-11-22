#!/usr/bin/env node
/**
 * Can a process inside the sidecar's sandbox leave it through launchd?
 *
 * Chrome's updater was seen running `launchctl asuser <uid> … --net-worker`: a process started through launchd
 * is a child of launchd, not of the sandboxed browser. This asks the question directly, with the REAL composed
 * policy and no Chrome: from inside the sidecar's sandbox, run the same trick against a local listener on a port
 * the policy does not allow, and try to write a file outside the profile.
 *
 * Needs a plain terminal (C1). Makes no model call and touches no network beyond 127.0.0.1.
 *
 *   node escape-probe.mjs
 */
import { spawn } from "node:child_process";

// ASYNC on purpose. The listeners live in this process, and a blocking spawnSync froze them: the first run of this
// probe timed out on the allowed port and the listeners saw nothing, so both controls failed and proved nothing.
const run = (command, args, options = {}) =>
  new Promise((done) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
    child.on("error", (error) => { clearTimeout(timer); done({ status: null, stdout, stderr: String(error) }); });
  });
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const { composeSidecarPolicy } = await import(join(REPO, "packages/orchestrator/src/sidecar-policy.ts"));

const OK_PORT = 47998;
const BLOCKED_PORT = 47999;
const root = mkdtempSync(join(homedir(), ".pi-central-escape-"));
const hits = [];
const listen = (port) =>
  new Promise((done, fail) => {
    const server = createServer((req, res) => { hits.push(port + req.url); res.end("ok"); });
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done(server));
  });

const servers = [await listen(OK_PORT), await listen(BLOCKED_PORT)];
const markerDirect = join(root, "written-directly");
const markerAsuser = join(root, "written-via-launchd");
const cfg = { okPort: OK_PORT, blockedPort: BLOCKED_PORT, markerDirect, markerAsuser };

const composed = composeSidecarPolicy({
  id: "escape", port: OK_PORT, listenPort: 47890, token: "unused",
  profileDir: join(root, "profile"), fragmentDir: join(root, "policy"),
  safehouse: "safehouse", sidecar: process.execPath,
  sidecarArgs: [join(HERE, "escape-inner.mjs"), JSON.stringify(cfg)],
  sidecarCodeDir: HERE, browser: "/usr/bin/true",
});
// Control, UNSANDBOXED: the same launchctl trick must work from here, or "refused" below proves nothing.
const uid = String(process.getuid());
await run("/bin/launchctl", ["asuser", uid, "/usr/bin/curl", "-sS", "-m", "3", "-o", "/dev/null", "http://127.0.0.1:" + BLOCKED_PORT + "/control-asuser"]);
const r = await run(composed.launch.command, composed.launch.args, { cwd: composed.launch.cwd, env: composed.launch.env });
for (const s of servers) s.close();

const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
if (!line) {
  console.log("The inner probe printed no RESULT. Not a finding about the policy -- the probe did not run.");
  console.log("exit=" + r.status + " stderr=" + (r.stderr ?? "").trim().slice(0, 600));
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}
const got = JSON.parse(line.slice(7));
const ok = (name, pass, detail) => { console.log((pass ? "PASS  " : "FAIL  ") + name + (detail ? "  -- " + detail : "")); return pass; };
const seen = (path) => hits.includes(path);

console.log("what the sandboxed process did:");
for (const [k, v] of Object.entries(got)) console.log("  " + k + ": " + JSON.stringify(v));
console.log("what the listeners saw: " + JSON.stringify(hits) + "\n");

const results = [
  ok("control: launchctl asuser works from OUTSIDE the sandbox (so a refusal inside is the policy)", seen(BLOCKED_PORT + "/control-asuser")),
  ok("control: the allowed port is reachable (so 'blocked' below means the policy, not a broken curl)", seen(OK_PORT + "/direct-allowed")),
  ok("a direct connection to a port outside the policy is refused", !seen(BLOCKED_PORT + "/direct-blocked")),
  ok("the same connection started THROUGH launchd (launchctl asuser) is also refused", !seen(BLOCKED_PORT + "/asuser-blocked"), seen(BLOCKED_PORT + "/asuser-blocked") ? "ESCAPE: launchd ran it outside the sandbox" : "launchd did not run it, or it was refused"),
  ok("a direct write outside the profile is refused", !existsSync(markerDirect)),
  ok("a write started THROUGH launchd outside the profile is also refused", !existsSync(markerAsuser), existsSync(markerAsuser) ? "ESCAPE: launchd wrote outside the sandbox" : ""),
];
rmSync(root, { recursive: true, force: true });
const failed = results.filter((p) => !p).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " held");
process.exit(failed === 0 ? 0 : 1);
