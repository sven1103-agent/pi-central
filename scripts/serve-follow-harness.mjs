#!/usr/bin/env node
/**
 * Serve the follow-scroll harness (ADR-0016).
 *
 *   node scripts/serve-follow-harness.mjs
 *
 * ## Why this prints the URL instead of telling you one
 *
 * The first version hardcoded http://127.0.0.1:5199/ in its own output and configured Vite with
 * strictPort: true. On a machine already running Pi Central that port was taken, so the harness refused
 * to start -- and because the banner was printed BEFORE Vite ran, it advertised a URL nothing was
 * listening on. Both faults are fixed here: the port relocates when it is busy, and the URL is READ from
 * Vite's own output rather than predicted. A launcher that states where to go must be quoting something
 * that is actually there.
 *
 * ## Why the child is killed explicitly
 *
 * Six harness servers were left running on this machine by earlier attempts, holding ports and outliving
 * the shell that started them. pkill and ps are both unavailable under the sandbox this project runs in, so
 * the leftovers were invisible until lsof found them. This launcher cleans up after itself: SIGINT,
 * SIGTERM and a normal exit all take the child down.
 *
 * ## Why no orchestrator
 *
 * The component takes its transcript as a PROP, so nothing needs a socket. That matters because the
 * orchestrator refuses to start inside a sandbox (C1) and a headless browser aborts under the same profile
 * -- while Vite and a browser window the reader opens are unaffected.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UI = join(ROOT, "packages", "ui");
const vite = join(ROOT, "node_modules", "vite", "bin", "vite.js");

console.log("Follow-scroll harness -- ADR-0016");
console.log("");
console.log("Watch the SCROLL, not the text:");
console.log("  - 1x steady   the tail should follow continuously, with no visible jump");
console.log("  - bursty      paragraphs arrive whole; this is what the per-frame clamp is for");
console.log("  - slow        a token every few frames; nothing should move for long stretches");
console.log("  - huge        thousands of chars at once; this is routed to an instant settle, not a glide");
console.log("");
console.log("Then scroll up MID-STREAM. Following must stop and stay stopped, and the Jump to latest pill");
console.log("must appear. That is the #86 property the glide had to preserve to be allowed at all.");
console.log("");

const child = spawn(process.execPath, [vite, "--config", "harness/vite.config.ts"], {
  cwd: UI,
  stdio: ["ignore", "pipe", "inherit"],
});

let announced = false;

/**
 * Report where Vite actually bound.
 *
 * Parsed from Vite's own line rather than computed, because the port may relocate -- and a prediction that
 * is wrong is worse than no URL at all, since the reader concludes the harness is broken.
 */
child.stdout.on("data", (chunk) => {
  const text = String(chunk);
  process.stdout.write(text);
  const match = /Local:\s*(http:\/\/\S+)/.exec(text);
  if (match && !announced) {
    announced = true;
    const base = match[1].replace(/\/$/, "");
    console.log("");
    console.log("  -> open  " + base + "/harness/");
    console.log("");
  }
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error("could not start vite: " + error.message);
  process.exit(1);
});

/** Take the child down with us, or a Ctrl-C leaves a server holding a port. */
function stop() {
  if (!child.killed) child.kill("SIGTERM");
}
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
process.on("exit", stop);
