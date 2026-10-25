/**
 * Serving the built UI from the orchestrator (issue #24).
 *
 * Until now the orchestrator spoke WebSocket only: every HTTP request got `426 Upgrade
 * Required`, which meant a Vite dev server was *mandatory* to see anything. That has a cost
 * beyond convenience — Vite watches `packages/ui/src`, so an agent editing a component reloads
 * the interface you are using out from under you, mid-edit, into a syntax-error overlay
 * ([DOGFOODING.md](../../../docs/DOGFOODING.md)). A built UI served by the orchestrator removes
 * the watcher, so editing the UI can no longer disturb the running one.
 *
 * It also makes ADR-0006's CSP *truthful*. The policy says `connect-src 'self'`, which is only
 * meaningful if the socket really is same-origin with the document. Serving both from one
 * listener achieves that by construction, rather than by a dev-server proxy configuration that
 * happens to be correct.
 *
 * ## What this listener is not
 *
 * **It is not a static file server for the filesystem.** It serves exactly one directory, and
 * only paths that resolve inside it. Two failure modes are worth naming because each looks like
 * success from the outside:
 *
 *   1. *Escaping the root.* `%2e%2e%2f` is not decoded by `new URL`, so string-matching a
 *      "normalized" URL is not enough — the decode has to happen here first. Traversal is then
 *      stopped by rejecting a `..` segment outright (a denial, not a 404 — the two are different
 *      facts). Containment-on-the-canonical-path is a backstop for a *different* defect class,
 *      not for traversal: `posix.normalize` clamps `..` at the root, which was established by
 *      removing the ban and watching the suite fail. See `isInside`.
 *   2. *Becoming a filesystem oracle.* A 404 for a path outside the root and a 404 for a
 *      non-existent path inside it are indistinguishable and both fine. A 403 for the former
 *      is deliberate: an escape attempt is worth reporting, not hiding.
 *
 * Loopback is not a boundary (C5): this listener grants whatever it serves to any local process
 * that asks. That is the same grant the WebSocket already carries, which is why it must not be
 * bound beyond `127.0.0.1` — the transport guarantees that, not this module.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Content-Security-Policy, as a header.
 *
 * ADR-0006's policy is also in `<meta http-equiv>` in `packages/ui/index.html`, and the two must
 * agree. They are not redundant: a **header applies before the document is parsed**, so it also
 * constrains the document's own subresource loads; the meta tag is enforced from the point it is
 * reached, which is after the parser has already seen the `<head>`. Sending only the meta tag
 * means the policy arrives late.
 *
 * Two policies that drift are worse than one, so the duplication is guarded by a test that parses
 * the meta tag out of `index.html` and asserts it equals this string
 * (`packages/orchestrator/test/static-ui.test.ts`). Change one without the other and CI fails.
 */
export const UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Content types for the file kinds a Vite build emits. Anything else is refused, not guessed. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Where the built UI lives.
 *
 * Derived from this module's own URL rather than configured, for the same reason issue #25 gives
 * for the installation path: a configured path would be correct for exactly one checkout — the
 * author's. `packages/orchestrator/src/static-ui.ts` → `packages/ui/dist`.
 *
 * `PI_CENTRAL_UI_DIST` overrides, which is what a packaged app (or a test) needs.
 */
export function resolveUiDistDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["PI_CENTRAL_UI_DIST"];
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  return fileURLToPath(new URL("../../ui/dist", import.meta.url));
}

export type StaticResolution =
  | { kind: "file"; path: string }
  | { kind: "denied"; reason: string };

/**
 * Is `candidate` inside `root` (or equal to it)?
 *
 * Exported and tested directly, because it is a **backstop for a different defect class** than the
 * traversal ban, and the difference is not obvious — it was established by falsification, not by
 * reasoning. Removing the `..` ban and re-running the suite showed this check does *not* catch it:
 * `posix.normalize` **clamps** `..` at the root, so `/../../etc/passwd` normalizes to `/etc/passwd`
 * and then resolves *inside* the root to `<root>/etc/passwd`. A rooted path cannot normalize its
 * way out, so containment-on-the-normalized-path is never the thing that stops traversal. The
 * explicit `..` ban is load-bearing, and it is tested as such.
 *
 * What this does guard is the case where a candidate is passed in **absolute** — which is what a
 * refactor that stopped stripping the leading `/` would produce: `resolve(root, "/etc/passwd")` is
 * `/etc/passwd`, not `<root>/etc/passwd`. The `startsWith(root)` form also refuses a sibling whose
 * name merely begins with the root's (`/var/root-ui` against `/var/root`), which a string prefix
 * test would wave through.
 */
export function isInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const target = resolve(candidate);
  if (target === rootPath) return true;
  return target.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep);
}

/**
 * Map a raw request target to a path inside `root`, or refuse it.
 *
 * Pure, and deliberately the whole security decision: the handler below only turns a result into
 * a response. Every branch is a test case rather than a code path someone has to remember.
 *
 * Two checks, and which one carries the weight is worth stating precisely, because the intuitive
 * answer is wrong:
 *
 *   1. Decode exactly once (a `%` that does not decode is a refusal, not a silent literal), then
 *      reject any `..` segment. **This is the check that stops traversal.** `/../package.json` is
 *      *denied* rather than quietly normalized to `/package.json` — an escape attempt and a typo
 *      are different events, and only one of them should be reported.
 *   2. Canonicalize the joined path and require it to still be inside `root` (`isInside`). This is a
 *      backstop for an *absolute* candidate — the shape a refactor produces if the leading-slash
 *      strip below is ever dropped — and for a sibling whose name prefixes the root. It does **not**
 *      substitute for check 1: `posix.normalize` clamps `..` at the root, so it can never produce
 *      an escape from a rooted path. Verified by removing check 1 and watching the suite fail.
 */
export function resolveStaticPath(root: string, requestTarget: string): StaticResolution {
  const rootPath = resolve(root);

  // Strip the query and fragment before anything else: `?x=../..` is not a path.
  const target = requestTarget.split("?")[0]!.split("#")[0]!;

  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // A malformed escape (`%zz`, a truncated `%2`) is a refusal. `decodeURIComponent` throwing is
    // the honest signal that this is not a path we understand.
    return { kind: "denied", reason: "the request target is not valid percent-encoding" };
  }

  if (decoded.includes("\0")) return { kind: "denied", reason: "the request target contains a NUL byte" };
  if (!decoded.startsWith("/")) return { kind: "denied", reason: "the request target is not an absolute path" };

  // Check 1: an explicit traversal segment. Reported, not normalized away.
  if (decoded.split("/").includes("..")) {
    return { kind: "denied", reason: "the request target contains a '..' segment" };
  }

  // `posix.normalize` (not `path.normalize`): the wire format is always slash-separated, even on
  // a platform whose filesystem separator is not. It also collapses `//` and `.` segments.
  //
  // Note that it CLAMPS a leading `..` at the root: `/../../x` becomes `/x`, not an escape. That is
  // why check 1 above cannot be dropped in favour of this one — see the note on `isInside`.
  const relative = posix.normalize(decoded).replace(/^\/+/, "");

  // Check 2: containment, on the canonical path. Guards an absolute candidate and a prefix-named
  // sibling; it is not what stops `..`.
  const candidate = resolve(rootPath, relative);
  if (!isInside(rootPath, candidate)) {
    return { kind: "denied", reason: "the request target resolves outside the served UI root" };
  }
  return { kind: "file", path: candidate };
}

export interface UiServerOptions {
  /** The directory to serve. Usually `resolveUiDistDir()`. */
  root: string;
  /** Overridable only so a test can prove the drift guard fires; production uses `UI_CSP`. */
  csp?: string;
}

/**
 * Build the HTTP request handler for the built UI.
 *
 * Routing rules, and why each one is what it is:
 *
 *   - An existing file is served. That is the whole point.
 *   - A path that looks like a **client-side route** (`/history`, or any path whose last segment
 *     has no dot) falls back to `index.html`, so a reload on a route is not a 404. A path that
 *     looks like an **asset** (`.js`, `.css`, `.png`) does not: falling back there would answer a
 *     missing script with an HTML document, and the browser would report a MIME-type error
 *     instead of the 404 that names the actual problem.
 *   - A missing build is a 500 that names the fix, never a 404 or a blank page. "The UI is not
 *     built" and "that file does not exist" are different facts and must not look the same.
 */
export function createUiRequestHandler(options: UiServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(options.root);
  const csp = options.csp ?? UI_CSP;
  const indexPath = resolve(root, "index.html");

  return (req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, {
        "content-type": "text/plain; charset=utf-8",
        allow: "GET, HEAD",
        "content-security-policy": csp,
      });
      res.end("this listener serves GET and HEAD only\n");
      return;
    }

    const resolution = resolveStaticPath(root, req.url ?? "/");
    if (resolution.kind === "denied") {
      // 403, not 404: the file may well exist, and pretending otherwise hides an attempt to
      // reach outside the served root.
      sendText(res, method, 403, `refused: ${resolution.reason}\n`, csp);
      return;
    }

    const path = resolution.path;
    if (isReadableFile(path)) {
      sendFile(res, method, path, csp);
      return;
    }

    // Not a file. Is this a client-side route, or a missing asset?
    const lastSegment = posix.basename(path);
    const looksLikeRoute = !lastSegment.includes(".") || path === root;
    if (looksLikeRoute) {
      if (isReadableFile(indexPath)) {
        sendFile(res, method, indexPath, csp);
        return;
      }
      sendText(
        res,
        method,
        500,
        "The UI has not been built, so there is nothing to serve.\n\n" +
          "Build it with:\n  npm run ui:build\n\n" +
          `(looked for ${indexPath})\n`,
        csp,
      );
      return;
    }

    sendText(res, method, 404, `no such file under the served UI root: ${posix.basename(path)}\n`, csp);
  };
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sendText(res: ServerResponse, method: string, status: number, body: string, csp: string): void {
  const bytes = Buffer.byteLength(body);
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(bytes),
    "x-content-type-options": "nosniff",
    "content-security-policy": csp,
  });
  // A HEAD response carries the headers and the length, and no body.
  if (method === "HEAD") res.end();
  else res.end(body);
}

function sendFile(res: ServerResponse, method: string, path: string, csp: string): void {
  const info = statSync(path);
  const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  // Vite fingerprints asset filenames, so their contents cannot change under a stable name and
  // they can be cached indefinitely. `index.html` names the current fingerprint set, so caching
  // it is exactly the mistake that serves a stale app after a rebuild.
  const immutable = path.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "content-type": type,
    "content-length": String(info.size),
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  // A stream, not a read into memory: an asset can be large, and a truncated read must surface as
  // a network error rather than a silently shortened body.
  const stream = createReadStream(path);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** Does a built UI exist at `root`? Used by the entry point to say so at startup. */
export function hasBuiltUi(root: string): boolean {
  return existsSync(resolve(root, "index.html"));
}
