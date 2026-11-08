/**
 * The CSP the shell's window actually receives (issue #215, criterion 5).
 *
 * ## Why this crosses the package seam
 *
 * The rule is that the shell "does not inject, relax or strip `content-security-policy`". A test of the
 * orchestrator's handler proves the handler sends the header; a test of `main.ts`'s source proves nothing about
 * a header at all. What the criterion is actually about is the pair: a real listener serving the real built UI,
 * read back over HTTP, with the policy compared against the one ADR-0006 decided.
 *
 * This is the same lesson `session-environment-live.test.ts` records for #214: the defect lived in the seam
 * between two packages, and neither side's unit tests could see it.
 *
 * ## Why it starts the handler rather than a whole orchestrator
 *
 * `server.ts` refuses to start inside a sandbox (C1's probe), so a test that ran it would fail on CI and in any
 * agent harness — and a security test that skips is worse than no test. The listener here is the REAL
 * `createUiRequestHandler` from the orchestrator package, mounted on a real HTTP server on port 0, serving the
 * REAL `packages/ui/dist` when it is built and a faithful fixture when it is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiRequestHandler, UI_CSP } from "../../orchestrator/src/static-ui.ts";

/** Serve a directory on port 0 and return its base URL, so nothing depends on a fixed port. */
async function serve(root: string): Promise<{ base: string; close: () => Promise<void> }> {
  const handler = createUiRequestHandler({ root });
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // `close` waits for open connections, and `fetch` keeps them alive — three seconds per test without
        // this. The sockets here are the test's own.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A minimal stand-in for a Vite build: the document plus one asset, nothing else. */
function fixture(root: string): void {
  writeFileSync(
    join(root, "index.html"),
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${UI_CSP}"></head>` +
      `<body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>`,
  );
}

test("the document the window loads carries the CSP as a HEADER, unchanged", async () => {
  /*
   * A header rather than only the meta tag, because a header applies BEFORE the document is parsed: the meta
   * tag is enforced from the point the parser reaches it, which is after `<head>`. A shell that stripped the
   * header would leave the app protected by the later of the two policies only.
   */
  const root = mkdtempSync(join(tmpdir(), "pi-central-app-csp-"));
  try {
    fixture(root);
    const server = await serve(root);
    try {
      const response = await fetch(`${server.base}/`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-security-policy"), UI_CSP, "the header must arrive intact");
      // The properties that make it a policy rather than a string, asserted on the wire.
      const sent = response.headers.get("content-security-policy") ?? "";
      assert.match(sent, /default-src 'none'/);
      assert.match(sent, /connect-src 'self'/);
      assert.match(sent, /frame-ancestors 'none'/);
      // ADR-0006 refuses inline script; if this ever appears, the sanitised insertion point is no longer the
      // only way markup reaches the document.
      assert.equal(/script-src[^;]*unsafe-inline/.test(sent), false, "the UI must not allow inline script");
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every response the window could load carries the policy, including a missing asset", async () => {
  // An error response without the header would be a document with no policy — which is what a `404` for a
  // mis-referenced asset is, and it still renders in the window.
  const root = mkdtempSync(join(tmpdir(), "pi-central-app-csp-"));
  try {
    fixture(root);
    const server = await serve(root);
    try {
      for (const path of ["/assets/index-abc.js", "/assets/does-not-exist.js", "/history", "/../../etc/passwd"]) {
        const response = await fetch(`${server.base}${path}`);
        assert.equal(
          response.headers.get("content-security-policy"),
          UI_CSP,
          `${path} must carry the CSP header (status ${response.status})`,
        );
      }
    } finally {
      await server.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the built UI on disk sends the same policy, when it is built", async () => {
  /*
   * The real artifact, when present. `packages/ui/dist` is absent in a fresh checkout and CI builds it in the
   * `verify` job only AFTER `npm test`, so absence is reported rather than failed — but this is the assertion
   * that would catch a Vite plugin rewriting the document's meta tag while the header stayed correct.
   */
  const dist = new URL("../../ui/dist", import.meta.url).pathname;
  const indexPath = join(dist, "index.html");
  let built: string;
  try {
    built = (await import("node:fs")).readFileSync(indexPath, "utf8");
  } catch {
    console.log(`skip: ${indexPath} is not built (npm run ui:build); nothing to serve`);
    return;
  }
  const server = await serve(dist);
  try {
    const response = await fetch(`${server.base}/`);
    assert.equal(response.headers.get("content-security-policy"), UI_CSP);
    // And the document's own meta policy agrees with the header, which `static-ui.test.ts` pins for the source
    // and this pins for the artifact that is actually served.
    const meta = /<meta[^>]*http-equiv=["']content-security-policy["'][^>]*>/i.exec(built)?.[0] ?? "";
    assert.ok(meta.length > 0, "the built document must carry the CSP meta tag");
    assert.ok(built.includes(UI_CSP), "the built document's meta policy must equal UI_CSP");
  } finally {
    await server.close();
  }
});
