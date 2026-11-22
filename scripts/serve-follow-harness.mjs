#!/usr/bin/env node
/**
 * Serve the follow-scroll harness (ADR-0016) on http://127.0.0.1:5199.
 *
 *   node scripts/serve-follow-harness.mjs
 *
 * ## Why a dev server and not a file
 *
 * Unlike the two static preview pages (`render-calm-preview.mjs`), this must RUN the component: the follow scroll
 * is a runtime behaviour, and a server-rendered string has no scroll handler, no animation frame, and no scroll
 * position. The fade preview shipped that way and the operator could not see the fades it was built to show — the
 * lesson is that a preview of runtime behaviour has to be runtime.
 *
 * ## Why no orchestrator
 *
 * The component takes its transcript as a PROP, so nothing needs a socket. That matters because the orchestrator
 * refuses to start inside a sandbox (C1), and a headless browser aborts under the same profile — but Vite and a
 * browser window the reader opens are unaffected.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UI = join(ROOT, "packages", "ui");

console.log("Follow-scroll harness — ADR-0016");
console.log("");
console.log("  http://127.0.0.1:5199/");
console.log("");
console.log("Watch the SCROLL, not the text:");
console.log("  · 1x steady   the tail should follow continuously, with no visible jump");
console.log("  · bursty      paragraphs arrive whole — this is what the per-frame clamp is for");
console.log("  · slow        a token every few frames; nothing should move for long stretches");
console.log("  · huge        thousands of chars at once; this is routed to an instant settle, not a glide");
console.log("");
console.log("Then: scroll up MID-STREAM. Following must stop and stay stopped, and the Jump to latest pill");
console.log("must appear. That is the #86 property the glide had to preserve to be allowed at all.");
console.log("");
console.log("Ctrl-C to stop.");
console.log("");

const vite = join(ROOT, "node_modules", "vite", "bin", "vite.js");
const child = spawn(process.execPath, [vite, "--config", "harness/vite.config.ts"], {
  stdio: "inherit",
  cwd: UI,
});
child.on("exit", (code) => process.exit(code ?? 0));
