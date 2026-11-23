// Runs INSIDE the sidecar's sandbox under the REAL composed policy (see escape-probe.mjs).
// Prints one JSON object of what each attempt did. Decides nothing; the outer script does.
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
// THE INTERNET, which is the question the Chrome updater raised: it tried update.googleapis.com and then started a
// helper through launchd. A connection to a real host on 443 is what "egress escaped" would look like.
out.internet = run("/usr/bin/curl", ["-sS", "-m", "5", "-o", "/dev/null", "https://update.googleapis.com/service/update2/json"]);
// And a DNS lookup, because resolution is the unix-socket route the fragment denies separately.
out.dns = run("/usr/bin/dscacheutil", ["-q", "host", "-a", "name", "update.googleapis.com"]);
try { writeFileSync(cfg.markerDirect, "x"); out.directWrite = { status: 0 }; } catch (e) { out.directWrite = { status: 1, error: String(e.message).slice(0, 120) }; }
out.asuserWrite = run("/bin/launchctl", ["asuser", uid, "/usr/bin/touch", cfg.markerAsuser]);
console.log("RESULT " + JSON.stringify(out));
