/**
 * Tests for serving the built UI from the orchestrator (issue #24).
 *
 * The acceptance criteria split into two kinds, and the split is deliberate:
 *
 *   - **Security properties** — traversal denied, the CSP present as a *header*, unknown paths
 *     under the root refused, the served root never escaping. These are tested against a real
 *     HTTP listener, because the thing being asserted is a property of the response.
 *   - **Drift guards** — the CSP header equals the `<meta>` policy in `index.html`; the missing-build
 *     message names the build command. These are the checks that keep two copies of a fact honest.
 *
 * A traversal attempt is asserted to be a **403**, not a 404. That is not pedantry: the two are
 * different facts — "you may not" versus "it is not here" — and a security test that accepts
 * either cannot tell a working guard from a directory that happens to be empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import {
  UI_CSP,
  createUiRequestHandler,
  hasBuiltUi,
  isInside,
  resolveStaticPath,
  resolveUiDistDir,
} from "../src/static-ui.ts";

const root = mkdtempSync(join(tmpdir(), "pi-central-static-ui-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// A miniature build: the shape a Vite build produces, which is all the handler reasons about.
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>\n");
writeFileSync(join(root, "assets", "index-abc123.js"), "console.log('ui');\n");
writeFileSync(join(root, "assets", "index-abc123.css"), ":root{}\n");
mkdirSync(join(root, "nested"), { recursive: true });
writeFileSync(join(root, "nested", "note.txt"), "nested\n");
// A file OUTSIDE the served root, as the traversal target. It must never be reachable.
const outside = mkdtempSync(join(tmpdir(), "pi-central-outside-"));
writeFileSync(join(outside, "package.json"), '{"name":"must-not-be-served"}\n');
process.on("exit", () => rmSync(outside, { recursive: true, force: true }));

// --- resolveStaticPath: the security decision, as a pure function ---------------------------

test("a normal path resolves inside the root", () => {
  const result = resolveStaticPath(root, "/assets/index-abc123.js");
  assert.equal(result.kind, "file");
  assert.equal(result.kind === "file" && result.path, join(root, "assets", "index-abc123.js"));
});

test("the bare root resolves to the root itself", () => {
  const result = resolveStaticPath(root, "/");
  assert.equal(result.kind, "file");
  assert.equal(result.kind === "file" && result.path, resolve(root));
});

test("a '..' segment is DENIED, not silently normalized away", () => {
  // `/../package.json` would normalize cleanly to `/package.json` — and that mutation is exactly
  // what hides an escape attempt. Each spelling is a separate case because each reached the
  // parser differently.
  for (const target of [
    "/../package.json",
    "/../../etc/passwd",
    "/assets/../../package.json",
    "/..%2f..%2fetc/passwd", // %2f survives `new URL` as a literal, so it MUST be decoded here
    "/%2e%2e/%2e%2e/etc/passwd",
    "/%2e%2e%2fsecret",
    "/a/../../b",
  ]) {
    const result = resolveStaticPath(root, target);
    assert.equal(result.kind, "denied", `expected a refusal for ${target}`);
  }
});

test("a query string cannot smuggle a traversal, because it is not a path", () => {
  const result = resolveStaticPath(root, "/index.html?next=/../../etc/passwd");
  assert.equal(result.kind, "file");
  assert.equal(result.kind === "file" && result.path, join(root, "index.html"));
});

test("a NUL byte and malformed percent-encoding are refusals, not guesses", () => {
  for (const target of ["/%00", "/%zz", "/%2"]) {
    assert.equal(resolveStaticPath(root, target).kind, "denied", `expected a refusal for ${target}`);
  }
});

test("a repeated slash is collapsed, not treated as an escape", () => {
  const result = resolveStaticPath(root, "//assets//index-abc123.js");
  assert.equal(result.kind, "file");
  assert.equal(result.kind === "file" && result.path, join(root, "assets", "index-abc123.js"));
});

test("the '..' ban is load-bearing: normalize alone would clamp the escape into the root", () => {
  // The finding that falsified an earlier claim in this file. `posix.normalize` CLAMPS a leading
  // `..` at the root, so `/../package.json` becomes `/package.json` and resolves to
  // `<root>/package.json` — inside the root. Containment-on-the-normalized-path therefore cannot
  // stop traversal; the explicit `..` ban does. Asserting the clamping behavior pins the reason, so
  // if a future Node changes it, this fails instead of the guard quietly becoming redundant.
  assert.equal(posix.normalize("/../package.json"), "/package.json");
  assert.equal(resolve(root, "package.json"), join(root, "package.json"), "normalization lands inside the root");
});

test("the containment backstop refuses a sibling whose name is a prefix of the root", () => {
  // Tested DIRECTLY, because this is what `isInside` actually guards — not traversal. Two cases it
  // covers and one it does not:
  //   - an ABSOLUTE candidate, which is what a refactor that dropped the leading-slash strip would
  //     produce (`resolve(root, "/etc/passwd")` is `/etc/passwd`, not `<root>/etc/passwd`);
  //   - a sibling whose name merely begins with the root's, which a `startsWith(root)` string test
  //     waves through (`/var/root-ui` against `/var/root`);
  //   - NOT `..`, which normalization clamps (see the test above).
  assert.equal(isInside(root, "/etc/passwd"), false, "an absolute candidate outside the root must be refused");
  assert.equal(isInside(root, `${root}-sibling`), false, "a prefix-named sibling must be refused");
  assert.equal(isInside(root, join(root, "a", "b")), true, "a descendant must be allowed");
  assert.equal(isInside(root, root), true, "the root itself must be allowed");
});

// --- The handler, over a real HTTP listener --------------------------------------------------

async function serve(overrides: { root?: string; csp?: string } = {}): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const handler = createUiRequestHandler({ root: overrides.root ?? root, ...(overrides.csp ? { csp: overrides.csp } : {}) });
  const server: Server = createServer(handler);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unexpected address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done) => {
        // `fetch` keeps its connection alive, and `server.close()` waits for open connections —
        // so without this, every test that made a successful request sat for ~3s in teardown
        // (12s across the suite) with the handler itself answering in about a millisecond. The
        // delay was entirely the harness, which is worth stating so it is not mistaken for
        // slow serving.
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

test("the root serves index.html, with the CSP as a HEADER", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(`${url}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    // The header, not the meta tag: a header applies before the document is parsed.
    assert.equal(response.headers.get("content-security-policy"), UI_CSP);
    assert.match(await response.text(), /id="root"/);
  } finally {
    await close();
  }
});

test("every response carries the CSP header, including error responses", async () => {
  // A policy that only guards the happy path is not a policy: the 403 and the 404 below are the
  // responses an attacker most controls the trigger for.
  const { url, close } = await serve();
  try {
    for (const path of ["/assets/index-abc123.js", "/../package.json", "/missing.js", "/history"]) {
      const response = await fetch(`${url}${path}`);
      assert.equal(
        response.headers.get("content-security-policy"),
        UI_CSP,
        `${path} must carry the CSP header`,
      );
      await response.text();
    }
  } finally {
    await close();
  }
});

test("a static asset is served with its content type and a long-lived cache", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(`${url}/assets/index-abc123.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    // Fingerprinted assets are immutable, so caching them is correct. index.html is not.
    assert.match(response.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(await response.text(), "console.log('ui');\n");
  } finally {
    await close();
  }
});

test("index.html is NOT cached, so a rebuild is visible", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(`${url}/index.html`);
    assert.equal(response.headers.get("cache-control"), "no-cache");
  } finally {
    await close();
  }
});

test("a client-side route falls back to index.html, so a reload is not a 404", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(`${url}/history`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /id="root"/);
  } finally {
    await close();
  }
});

test("a missing ASSET is a 404, not an HTML fallback", async () => {
  // Falling back here would answer a missing script with a document, and the browser would report
  // a MIME-type error instead of the 404 that names the real problem.
  const { url, close } = await serve();
  try {
    const response = await fetch(`${url}/assets/gone-999.js`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  } finally {
    await close();
  }
});

/**
 * Send a request with the path sent **verbatim** on the wire.
 *
 * `fetch` cannot be used for the traversal tests, and the reason is a finding worth writing down:
 * WHATWG `fetch` normalizes `..` segments before sending, so `fetch(url + "/../package.json")`
 * arrives at the server as `/package.json` — the guard is never exercised, and the test passes for
 * the wrong reason (or fails confusingly, as this one first did). A raw `http.request` sends
 * `req.url` exactly as given, which is what a malicious or hand-written client does.
 */
async function rawGet(url: string, path: string): Promise<{ status: number; body: string; headers: Headers }> {
  const parsed = new URL(url);
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest(
      { host: parsed.hostname, port: parsed.port, method: "GET", path },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(key, value);
            else if (Array.isArray(value)) headers.set(key, value.join(", "));
          }
          resolveRequest({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers });
        });
      },
    );
    req.on("error", rejectRequest);
    req.end();
  });
}

test("a traversal attempt is refused with 403 and a reason, over the wire", async () => {
  const { url, close } = await serve();
  try {
    for (const path of ["/../package.json", "/..%2f..%2fetc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/../../package.json"]) {
      const response = await rawGet(url, path);
      assert.equal(response.status, 403, `${path} must be refused`);
      assert.match(response.body, /refused/);
      assert.ok(!response.body.includes("must-not-be-served"), "the file outside the root must never be served");
      assert.equal(response.headers.get("content-security-policy"), UI_CSP);
    }
  } finally {
    await close();
  }
});

test("fetch() normalizes '..' before sending, which is why the test above uses a raw request", async () => {
  // Documents the trap rather than leaving it implicit. If a future edit "simplifies" the traversal
  // test back to `fetch`, this test still passes while the guard goes untested — so the assertion
  // is on the OBSERVED difference, not on the absence of `fetch`.
  const { url, close } = await serve();
  try {
    const normalized = await fetch(`${url}/../package.json`, { redirect: "manual" });
    const raw = await rawGet(url, "/../package.json");
    assert.equal(raw.status, 403, "the raw request is the one that reaches the guard");
    assert.notEqual(
      normalized.status,
      403,
      "fetch() normalizes client-side; if this ever becomes 403, the raw client above is what still tests the guard",
    );
    await normalized.text();
  } finally {
    await close();
  }
});

test("no traversal spelling reaches the file outside the root", async () => {
  // The decisive check: the outside file's CONTENT exists and is known, so "not served" is
  // falsifiable rather than implied by a status code.
  const { url, close } = await serve();
  try {
    const name = resolve(outside).split("/").pop();
    const attempts = [
      `/../${name}/package.json`,
      `/%2e%2e/${name}/package.json`,
      `/assets/..%2f..%2f${name}/package.json`,
    ];
    for (const attempt of attempts) {
      const response = await rawGet(url, attempt);
      assert.ok(!response.body.includes("must-not-be-served"), `leak via ${attempt}: ${response.body.slice(0, 120)}`);
    }
  } finally {
    await close();
  }
});

test("a nested file inside the root IS served (the guard is containment, not a blocklist)", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(`${url}/nested/note.txt`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "nested\n");
  } finally {
    await close();
  }
});

test("HEAD returns the headers and no body", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(`${url}/index.html`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    assert.ok(Number(response.headers.get("content-length")) > 0);
  } finally {
    await close();
  }
});

test("a method other than GET/HEAD is refused with 405 and an Allow header", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(`${url}/index.html`, { method: "POST", body: "x" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    await response.text();
  } finally {
    await close();
  }
});

// --- A missing build names the fix ------------------------------------------------------------

test("a missing build is a 500 that names the build command, never a 404 or a blank page", async () => {
  const empty = mkdtempSync(join(tmpdir(), "pi-central-unbuilt-"));
  process.on("exit", () => rmSync(empty, { recursive: true, force: true }));
  const { url, close } = await serve({ root: empty });
  try {
    const response = await fetch(`${url}/`);
    assert.equal(response.status, 500, "a missing build is a server-side condition, not a 404");
    const body = await response.text();
    assert.match(body, /npm run ui:build/, "the message must name the fix");
  } finally {
    await close();
  }
});

// --- Drift guards -----------------------------------------------------------------------------

test("the CSP header equals the meta policy in index.html", () => {
  // Two copies of a security policy that can drift silently is worse than one. The header is the
  // authoritative copy (it applies before parsing); the meta tag is what ships in the document.
  // Change either alone and this fails.
  const html = readFileSync(new URL("../../ui/index.html", import.meta.url), "utf8");
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(match, "index.html must carry a CSP meta tag");
  assert.equal(
    match[1],
    UI_CSP,
    "the meta CSP and the header CSP have drifted; the header applies before the document is parsed",
  );
});

test("connect-src is 'self', which is only truthful because the UI is served same-origin", () => {
  // The whole reason serving from the orchestrator matters for ADR-0006. A hardcoded
  // ws://127.0.0.1:<port> would force this directive open.
  assert.match(UI_CSP, /connect-src 'self'/);
  assert.ok(!/ws:\/\//.test(UI_CSP), "the CSP must not name an absolute socket origin");
});

test("the UI directory is derived from this module's URL, not configured", () => {
  // A configured path would be correct for exactly one checkout (the same reasoning as issue #25).
  const derived = resolveUiDistDir({});
  assert.ok(derived.endsWith(join("packages", "ui", "dist")), derived);
  assert.equal(resolveUiDistDir({ PI_CENTRAL_UI_DIST: "/tmp/somewhere" }), "/tmp/somewhere");
});

test("hasBuiltUi distinguishes a built tree from an unbuilt one", () => {
  assert.equal(hasBuiltUi(root), true);
  assert.equal(hasBuiltUi(join(root, "nope")), false);
});

test("the test's own root is a fixture, so the guard is not accidentally testing the real dist", () => {
  // If this ever equaled packages/ui/dist, the traversal tests above could pass for the wrong reason.
  assert.ok(!resolve(root).includes(`${join("packages", "ui")}`), root);
});
