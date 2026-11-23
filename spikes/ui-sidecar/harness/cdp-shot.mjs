#!/usr/bin/env node
/**
 * Shape C, check C1 — a pixel and a probe verdict over CDP, without Playwright.
 *
 * The economic claim of shape C is one line: `ws` is already a shipped dependency and is already a
 * WebSocket client, and CDP is JSON over a WebSocket. If that is enough to drive a screenshot and the
 * probe measurements, then the slice ships no new dependency and the Pi extension is unnecessary too.
 *
 * This file is the whole measurement. What it does NOT do is the parity work Playwright buys: no
 * network-idle wait, no console collection, no launch robustness. Those are counted, not implemented, so
 * the cost of dropping Playwright is visible instead of assumed.
 *
 *   node cdp-shot.mjs --control                          # no policy, the baseline
 *   safehouse --workdir="$PWD" --enable=chromium-headless \
 *     --append-profile="$PWD/loopback.sb" -- node cdp-shot.mjs --inside-sandbox --no-sandbox
 *
 * Exit: 0 every expectation held, 1 one did not, 2 could not start.
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:net";
import { existsSync, readFileSync, rmSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4173;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = resolve(HERE, "cdp-out.png");
const PROFILE = resolve(HERE, "cdp-profile");

const argv = process.argv.slice(2);
const has = (n) => argv.includes("--" + n);
const mode = has("control") ? "control" : has("inside-sandbox") ? "sandboxed" : undefined;
if (!mode) {
  console.error("Say which mode: --control or --inside-sandbox (see PHASE-0C.md)");
  process.exit(2);
}

const results = [];
const record = (name, pass, detail) => {
  results.push(pass);
  console.log((pass ? "PASS" : "FAIL") + "  " + name + (detail ? "  -- " + detail : ""));
};

// --- the fixture -------------------------------------------------------------------------
const page = readFileSync(join(HERE, "page.html"));
const server = createHttpServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise((done, fail) => {
  server.once("error", fail);
  server.listen(PORT, done);
});
console.log("mode: " + mode + " | fixture on :" + PORT + " " + server.address().family);

// --- launch the browser ----------------------------------------------------------------
mkdirSync(PROFILE, { recursive: true });
const args = [
  "--headless=new",
  "--user-data-dir=" + PROFILE,
  "--disable-gpu",
  "--disable-crash-reporter",
  "--disable-breakpad",
  "--no-first-run",
  "--remote-debugging-port=0",
  "about:blank",
];
// Mandatory under Safehouse: it cannot permit Chromium's nested Seatbelt sandbox (safehouse --help).
if (has("no-sandbox")) args.unshift("--no-sandbox");

const chrome = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
let chromeErr = "";
chrome.stderr.on("data", (c) => (chromeErr += c));

// --- find the endpoint WITHOUT asking Playwright ---------------------------------------
// Chrome writes the port into <user-data-dir>/DevToolsActivePort. Two lessons from the spike:
// the file lives inside the profile (so the profile must not be in /var/folders, which every
// session can read -- C-adjacent, see the S4 note in PHASE-0.md), and `--remote-debugging-pipe`
// would avoid the file entirely if the pipe path is ever needed.
const portFile = join(PROFILE, "DevToolsActivePort");
let wsUrl;
for (let i = 0; i < 100; i++) {
  if (existsSync(portFile)) {
    const [port, path] = readFileSync(portFile, "utf8").split("\n");
    if (port && path) { wsUrl = "ws://localhost:" + port.trim() + path.trim(); break; }
  }
  await new Promise((r) => setTimeout(r, 100));
}
if (!wsUrl) {
  record("browser exposed a CDP endpoint", false, "no DevToolsActivePort after 10s");
  console.log("  chrome said: " + chromeErr.split("\n").filter(Boolean).slice(-3).join(" | "));
  server.close(); chrome.kill(); process.exit(1);
}
record("browser exposed a CDP endpoint", true, wsUrl.replace(/\/devtools.*/, "/devtools/..."));

// --- a minimal CDP client, the thing this check is actually about ----------------------
const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
let nextId = 1;
const pending = new Map();
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const open = new Promise((done, fail) => { ws.once("open", done); ws.once("error", fail); });
await open;

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

// Attach to a page target.
const { targetInfos } = await send("Target.getTargets");
const pageTarget = targetInfos.find((t) => t.type === "page");
const { sessionId } = await send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
const call = (m, params) => send(m, params, sessionId);

await call("Page.enable");
await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", {
  width: 800, height: 400, deviceScaleFactor: 1, mobile: false,
});

const navigated = new Promise((done) => {
  const onMsg = (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.method === "Page.loadEventFired") { ws.off("message", onMsg); done(); }
  };
  ws.on("message", onMsg);
});
await call("Page.navigate", { url: "http://localhost:" + PORT + "/" });
await Promise.race([navigated, new Promise((r) => setTimeout(r, 8000))]);

// The pixel.
rmSync(OUT, { force: true });
const shot = await call("Page.captureScreenshot", { format: "png" });
writeFileSync(OUT, Buffer.from(shot.data, "base64"));
const png = existsSync(OUT) && statSync(OUT).size > 0;
record("a screenshot came back over CDP", png, png ? statSync(OUT).size + " bytes" : "empty");

// The probe: fixed measurements, computed here, NOT a script supplied by the caller. That
// distinction is the whole of check C2 -- a verb that took a CDP method or an arbitrary
// expression would be browser_evaluate in a different costume.
const measured = await call("Runtime.evaluate", {
  returnByValue: true,
  expression: `(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1) out.push({ selector: el.id ? "#" + el.id : el.tagName.toLowerCase(),
                                       kind: "horizontal-overflow", by: Math.round(r.right - vw) });
      if (r.bottom > vh + 1) out.push({ selector: el.id ? "#" + el.id : el.tagName.toLowerCase(),
                                       kind: "vertical-overflow", by: Math.round(r.bottom - vh) });
    }
    return { viewport: { width: vw, height: vh }, problems: out.slice(0, 10) };
  })()`,
});
const verdict = measured.result?.value ?? {};
const problems = verdict.problems ?? [];
const found = problems.some((x) => x.selector === "#wide" && x.kind === "horizontal-overflow");
record("probe found the deliberate overflow", found, JSON.stringify(problems));
console.log("  verdict JSON: " + JSON.stringify(verdict).slice(0, 200));

ws.close();
chrome.kill();
server.close();
const failed = results.filter((r) => !r).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " expectations held (" + mode + ")");
const self = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").length;
console.log("this file: " + self + " lines, including the fixture, the CDP client and the probe");
process.exit(failed === 0 ? 0 : 1);
