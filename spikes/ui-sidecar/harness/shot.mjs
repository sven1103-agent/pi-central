#!/usr/bin/env node
/**
 * Phase 0 in one process — a pixel, and both directions of the loopback question, in one run.
 *
 * Why one process: two runs cannot tell "denied" from "not attempted". That is C15c's lesson,
 * applied to a network check instead of a file check.
 *
 * Node builtins only, deliberately. The claim under test is about Seatbelt and Chromium; a package
 * manager in the middle would make a failure ambiguous.
 *
 * THREE WAYS TO RUN IT, and the mode is required so a bare run cannot be mistaken for a result:
 *
 *   node shot.mjs --control
 *       No policy at all. The baseline: if the browser cannot render here either, the defect is
 *       Chromium, not the profile, and every sandboxed result below means nothing.
 *
 *   safehouse --workdir=$PWD --enable=playwright-chrome -- node shot.mjs --inside-sandbox
 *       The sidecar's profile as Safehouse composes it. Expect all three egress checks to FAIL
 *       to be denied — this is the "before" of the fragment.
 *
 *   safehouse --workdir=$PWD --enable=playwright-chrome --append-profile=$PWD/loopback.sb \
 *       -- node shot.mjs --inside-sandbox
 *       Same, with the loopback fragment. Now non-loopback and DNS must be REFUSED.
 *
 * Exit: 0 every expectation held, 1 one did not, 2 could not start.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4173;
const CHROME_APP = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const argv = process.argv.slice(2);
const has = (name) => argv.includes("--" + name);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith("--" + name + "="));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const mode = has("control") ? "control" : has("inside-sandbox") ? "sandboxed" : undefined;
if (mode === undefined) {
  console.error([
    "Say which mode this is, so a bare run is never read as a result.",
    "",
    "  node shot.mjs --control           # no policy; the baseline",
    "  safehouse ... -- node shot.mjs --inside-sandbox   # under the sidecar's profile",
    "",
    "See spikes/ui-sidecar/PHASE-0.md.",
  ].join("\n"));
  process.exit(2);
}

// Confirm the mode matches reality. A --control run that is in fact sandboxed would report the
// sandbox's behaviour as Chromium's, which is the one mistake this file exists to prevent.
const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "--", "/usr/bin/true"], {
  encoding: "utf8",
});
const canNest = probe.status === 0;
if (mode === "control" && !canNest) {
  console.error([
    "This is not a plain environment: a Seatbelt policy cannot be applied here (C1).",
    "",
    "  sandbox-exec: " + ((probe.stderr || "").trim() || "exited " + probe.status),
    "",
    "A --control run must be unsandboxed, or its results describe an outer sandbox rather than",
    "Chromium. Run it from a plain terminal.",
  ].join("\n"));
  process.exit(2);
}
if (mode === "sandboxed" && canNest) {
  console.error([
    "--inside-sandbox was given, but no policy is in force here (nesting still works).",
    "",
    "Refusing: the checks below would report this shell's network, not the sidecar's profile.",
    "Wrap the run: safehouse --workdir=$PWD --enable=playwright-chrome -- node shot.mjs --inside-sandbox",
  ].join("\n"));
  process.exit(2);
}

const expectDenied = mode === "sandboxed";
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log((pass ? "PASS" : "FAIL") + "  " + name + (detail ? "  -- " + detail : ""));
};

// 1. The fixture, on a pinned port.
const page = readFileSync(join(HERE, "page.html"));
const server = createHttpServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
});
const bound = await new Promise((done) => {
  server.once("error", (error) => done({ error }));
  server.listen(PORT, () => done({ address: server.address() }));
});
if (bound.error) {
  console.error("could not bind :" + PORT + " -- " + bound.error.message);
  process.exit(2);
}
const fam = bound.address.family;
const boundV4 = fam === "IPv4" || fam === 4;
console.log("mode: " + mode + " | fixture on :" + PORT + " bound " + fam + " " + bound.address.address);
if (boundV4) {
  // Measured elsewhere: Playwright's MCP server answers on ::1 and refuses 127.0.0.1, so a
  // spelling that resolves to ::1 first can produce a navigation timeout that looks like C1.
  console.log("note: bound v4 only; if navigation times out, the browser may have tried ::1 first.");
}

// A second listener on a different loopback port, so "the port is the unit" is measured rather
// than assumed. This decides whether a confined renderer can still reach the orchestrator's
// control socket, which is on loopback too and performs no Origin, Host or token check.
const PEER_PORT = Number(opt("peer-port", String(PORT + 1)));
const peer = createHttpServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("peer\n");
});
const peerBound = await new Promise((done) => {
  peer.once("error", (error) => done({ error }));
  peer.listen(PEER_PORT, () => done({ address: peer.address() }));
});
if (peerBound.error) {
  console.error("could not bind :" + PEER_PORT + " for the peer check -- " + peerBound.error.message);
  process.exit(2);
}

// 2. Three directions, from this one process.
const tcp = (host, port, timeout = 4000) =>
  new Promise((done) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done({ ok, detail });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true, "connected"));
    socket.once("timeout", () => finish(false, "timed out"));
    socket.once("error", (error) => finish(false, error.code || error.message));
  });

const loop = await tcp("localhost", PORT);
record("loopback :" + PORT + " is reachable", loop.ok, loop.detail);

const peerHit = await tcp("localhost", PEER_PORT);
record(
  expectDenied
    ? "a second loopback port (:" + PEER_PORT + ") is REFUSED -- the PORT is pinned, not the address"
    : "a second loopback port (:" + PEER_PORT + ") is reachable (baseline)",
  peerHit.ok !== expectDenied,
  peerHit.detail + (expectDenied ? "" : " -- this is what an unconfined renderer can dial"),
);

const ext = await tcp("1.1.1.1", 443);
record(
  expectDenied ? "a non-loopback host is REFUSED" : "a non-loopback host is reachable (baseline)",
  ext.ok !== expectDenied,
  ext.detail,
);

const dns = spawnSync("/usr/bin/dscacheutil", ["-q", "host", "-a", "name", "example.com"], { encoding: "utf8" });
const resolved = dns.status === 0 && /ip_address/.test(dns.stdout || "");
record(
  expectDenied ? "name resolution is REFUSED" : "name resolution works (baseline)",
  resolved !== expectDenied,
  resolved ? "resolved example.com" : "no answer",
);

// 3. The pixel.
const browserArgs = [
  "--headless=new",
  "--user-data-dir=" + resolve(HERE, "profile"),
  "--disable-gpu",
  "--disable-crash-reporter",
  "--disable-breakpad",
  "--screenshot=" + resolve(HERE, "out.png"),
  "--window-size=800,400",
  "--virtual-time-budget=5000",
  opt("url", "http://localhost:" + PORT + "/"),
];
// Mandatory under Safehouse: it cannot permit Chromium's nested Seatbelt sandbox (safehouse
// --help says so, and chromium-full.sb explains why). Passed by the caller so both variants are
// recorded rather than assumed.
if (has("no-sandbox")) browserArgs.unshift("--no-sandbox");

const channel = opt("channel", "app");
const command = channel === "app" ? CHROME_APP : "chromium";
if (channel === "app" && !existsSync(CHROME_APP)) {
  console.error(CHROME_APP + " is not installed; try --channel=bundled");
  process.exit(2);
}

const outPng = resolve(HERE, "out.png");
rmSync(outPng, { force: true });
const launched = await new Promise((done) => {
  const child = spawn(command, browserArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.once("error", (error) => done({ error: error.message, stderr }));
  child.once("exit", (code, signal) => done({ code, signal, stderr }));
});

if (launched.error) {
  record("browser launched", false, launched.error);
} else {
  const png = existsSync(outPng) && statSync(outPng).size > 0;
  record("browser launched and produced a PNG", png, "exit=" + (launched.code ?? launched.signal));
  if (!png) {
    const interesting = /SEGV|crashpad|SingletonSocket|database is required|Operation not permitted|Failed to/i;
    for (const line of (launched.stderr || "").split("\n")) {
      if (interesting.test(line)) console.log("  " + line.trim());
    }
    console.log("  record the lines above VERBATIM -- they are the result of this check");
  } else {
    const dims = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", outPng], { encoding: "utf8" });
    const w = /pixelWidth: (\d+)/.exec(dims.stdout || "");
    const h = /pixelHeight: (\d+)/.exec(dims.stdout || "");
    record(
      "the PNG matches the window",
      !!w && !!h && w[1] === "800" && h[1] === "400",
      (w ? w[1] : "?") + "x" + (h ? h[1] : "?"),
    );
    console.log("  wrote " + outPng);
    console.log("  OPEN IT. A blank frame or a page of tofu is a FAIL even though a file exists.");
  }
}

server.close();
peer.close();
const failed = results.filter((r) => !r.pass).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " expectations held (" + mode + ")");
process.exit(failed === 0 ? 0 : 1);
