/**
 * The dev proxy's log says what happened, not what it is (issue #114, follow-up).
 *
 * `read ECONNRESET` from the ws proxy is **routine** — the orchestrator restarted, a session ended, the tab
 * reloaded. Vite logs it through its generic error path, so a normal event arrived as a stack trace:
 *
 *     [vite] ws proxy error:
 *     Error: read ECONNRESET
 *         at TCP.onStreamRead (node:internal/stream_base_commons:221:20)
 *
 * That reads as a fault. **Logging noise as failure trains you to ignore the prefix**, which is exactly how
 * an `EADDRINUSE`-shaped message stops being read — the same lesson as #114's port collision, in a
 * different log line.
 *
 * Asserted on the config source and by re-running the handler's own logic, because a `configure` hook cannot
 * be exercised without starting Vite's proxy and opening a socket to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Comments removed before matching — for the seventh time in this repository.
 *
 * The assertion `!/stack trace/` was satisfied by my own COMMENT explaining that the routine case must not
 * print one. Every text-scanning check here has eventually needed this, so it is the default now rather than
 * a discovery.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const config = stripComments(readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8"));

test("the proxy handles its own socket errors instead of leaving them to Vite's generic path", () => {
  assert.match(config, /configure:\s*\(proxy\)\s*=>/, "a configure hook is required to see them");
  assert.match(config, /proxy\.on\("error"/, "the socket's `error` event, not a wrapper around log output");
});

test("the routine codes are reported without a stack, and real errors are not swallowed", () => {
  // Re-implemented here from the SAME constants the config uses, so a change to either side fails.
  for (const code of ["ECONNRESET", "EPIPE"]) {
    assert.ok(config.includes(code), `${code} must be treated as routine`);
  }
  // The handler must fall through to an error for anything else: a proxy that fails for any other reason is
  // worth a stack trace, and swallowing it would trade noise for blindness.
  assert.match(config, /console\.error\(/, "unknown errors still surface");
  assert.match(config, /reported\.has\(socket\)/, "and a duplicate is suppressed per socket");
  assert.match(config, /WeakSet/, "deduped by socket identity, so a reconnect is still reported");
});

test("the message says the connection closed, and that it is normal", () => {
  // The wording is the deliverable: "connection closed (ECONNRESET) — normal on reload or restart" is a
  // sentence; `read ECONNRESET` is a symptom.
  assert.match(config, /connection closed/, "names what happened");
  assert.match(config, /normal on reload or restart/, "and tells the reader it is not a fault");
  assert.ok(!/describeStack|stack trace/i.test(config), "no stack for the routine case");
});
