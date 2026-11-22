// Runs INSIDE the sidecar's sandbox (launched by escape-probe.mjs under the REAL composed policy).
// Prints one JSON object: what each attempt did. It decides nothing; the outer script does.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const cfg = JSON.parse(process.argv[2]);
const uid = String(process.getuid());
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
  return { status: r.status, signal: r.signal, error: r.error ? String(r.error.message) : undefined, stderr: (r.stderr ?? "").trim().slice(0, 200) };
};
const curl = (port, path) => ["-sS", "-m", "3", "-o", "/dev/null", "http://127.0.0.1:" + port + path];
const out = {};
out.directAllowed = run("/usr/bin/curl", curl(cfg.okPort, "/direct-allowed"));
out.directBlocked = run("/usr/bin/curl", curl(cfg.blockedPort, "/direct-blocked"));
out.asuserBlocked = run("/bin/launchctl", ["asuser", uid, "/usr/bin/curl", ...curl(cfg.blockedPort, "/asuser-blocked")]);
try { writeFileSync(cfg.markerDirect, "x"); out.directWrite = { status: 0 }; } catch (e) { out.directWrite = { status: 1, error: String(e.message).slice(0, 120) }; }
out.asuserWrite = run("/bin/launchctl", ["asuser", uid, "/usr/bin/touch", cfg.markerAsuser]);
console.log("RESULT " + JSON.stringify(out));
