#!/usr/bin/env node
/**
 * Shape C, check C3 — are the credential denies real, and do they cost the browser?
 *
 * Run INSIDE the sidecar's sandbox. `shot.mjs` cannot answer this: it reports the browser's pixels,
 * not whether the renderer could read the host's credentials. Separate process, separate question.
 *
 *   safehouse --workdir="$PWD" --enable=chromium-headless \
 *     --append-profile="$PWD/loopback.sb" --append-profile="$PWD/creds.sb" \
 *     -- node creds-probe.mjs --inside-sandbox
 *
 *   node creds-probe.mjs --control    # no policy; every read succeeds, which is the point
 *
 * Exit: 0 every expectation held, 1 one did not, 2 could not start.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const has = (n) => argv.includes("--" + n);
const mode = has("control") ? "control" : has("inside-sandbox") ? "sandboxed" : undefined;
if (!mode) {
  console.error(["Say which mode this is:", "", "  node creds-probe.mjs --control", "  safehouse ... -- node creds-probe.mjs --inside-sandbox"].join("\n"));
  process.exit(2);
}

// Confirm the mode against reality, the same way shot.mjs does. A --control run that is in fact
// sandboxed would report the policy's behaviour as the host's.
const nest = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "--", "/usr/bin/true"], {
  encoding: "utf8",
});
const canNest = nest.status === 0;
if (mode === "control" && !canNest) {
  console.error("Not a plain environment (C1): " + (nest.stderr || "").trim() + " -- run --control unsandboxed.");
  process.exit(2);
}
if (mode === "sandboxed" && canNest) {
  console.error("--inside-sandbox given but no policy is in force. Refusing: it would report this shell.");
  process.exit(2);
}

const HOME = homedir();
const expectDenied = mode === "sandboxed";
const results = [];
const record = (name, pass, detail) => {
  results.push(pass);
  console.log((pass ? "PASS" : "FAIL") + "  " + name + (detail ? "  -- " + detail : ""));
};
console.log("mode: " + mode + " | HOME=" + HOME);

// Each path is probed the way a renderer would: a plain read. Named falsifiers, because a coverage
// property needs them (C15c) -- these are the four the composed policy actually grants.
const targets = [
  ["~/.npmrc (an npm auth token lives here)", join(HOME, ".npmrc")],
  ["~/.config/gh (the host gh config)", join(HOME, ".config", "gh", "hosts.yml")],
  ["~/.ssh/config (maps the user's hosts)", join(HOME, ".ssh", "config")],
  ["~/.gitconfig (the host git identity)", join(HOME, ".gitconfig")],
];

for (const [label, path] of targets) {
  if (!existsSync(path) && mode === "control") {
    console.log("SKIP  " + label + " -- not present on this machine, so it cannot be a falsifier");
    continue;
  }
  let readable = true;
  let detail = "read";
  try {
    readFileSync(path);
  } catch (error) {
    readable = false;
    detail = error.code || error.message;
  }
  record(
    expectDenied ? label + " is REFUSED" : label + " is readable (baseline)",
    readable !== expectDenied,
    detail,
  );
}

// The unix-socket route to the same place: a file deny does not cover connect() on an agent socket,
// which is why the fragment carries a network deny as well. Measured whenever the variable is set.
const sock = process.env["SSH_AUTH_SOCK"];
if (!sock) {
  console.log("INFO  SSH_AUTH_SOCK is unset in this environment, so the agent route is absent too");
} else {
  console.log("INFO  SSH_AUTH_SOCK=" + sock + " -- if the fragment grants it, that is a finding");
}

const failed = results.filter((r) => !r).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " expectations held (" + mode + ")");
process.exit(failed === 0 ? 0 : 1);
