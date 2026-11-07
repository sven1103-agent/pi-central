/**
 * The window's security decisions (issue #215, ADR-0013).
 *
 * ## Why these are tested as functions rather than through a real window
 *
 * `main.ts` cannot be loaded under `node --test`: `electron`'s main export is a *path string* to the binary,
 * so `import { BrowserWindow } from "electron"` only works inside a real Electron process. A test that needed
 * one would skip on CI, and a skipped security test reads as a passing one — this repository has already been
 * bitten by that reasoning (see the SBPL policy-parse note in `.github/workflows/ci.yml`).
 *
 * So every decision lives in `window-security.ts` as a pure function over the facts Electron supplies, and the
 * assertions here are about the DECISION: which URL is allowed, which permission is refused, which option is
 * required. `main.ts` only wires them to real events, which is the part that could still be wired to the wrong
 * event — and that is what the source-shape test at the bottom of this file is for.
 *
 * ## What each criterion maps to
 *
 *   1. `webPreferences` is minimal and pinned → `windowWebPreferences` + `auditWindowOptions`.
 *   2. Navigation is refused off-origin → `navigationDecision`, with an allowed and a refused URL in one run.
 *   3. New windows are refused, `http(s)` handed to the browser → `windowOpenDecision` / `externalTarget`.
 *   4. Every web permission is denied by default → `permissionDecision`.
 *   5. The CSP is unchanged and still effective → asserted against the real listener in
 *      `window-csp-live.test.ts`, plus `failureDocumentProblems` for the shell's own page.
 *   6. `file://` is unreachable → `navigationDecision` refuses it, and `main.ts` never calls `loadFile`.
 *   7. No remote module → `auditWindowOptions` + `bundleProblems`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FAILURE_PAGE_CSP,
  FORBIDDEN_MODULES,
  allowedOrigins,
  auditWindowOptions,
  bundleProblems,
  externalTarget,
  failureDocument,
  failureDocumentProblems,
  navigationDecision,
  originOf,
  permissionDecision,
  windowOpenDecision,
  windowWebPreferences,
} from "../src/window-security.ts";

const PORT = 51234;

// --- Criterion 1: the options are minimal and pinned ---------------------------------------------

test("the window options are the pinned set, and the audit passes on them", () => {
  const preferences = windowWebPreferences();
  assert.deepEqual(auditWindowOptions({ ...preferences }), [], "the shipped options must satisfy the audit");
  // Asserted as VALUES, not as presence: a helper that flipped one back on must fail here.
  assert.equal(preferences["contextIsolation"], true);
  assert.equal(preferences["nodeIntegration"], false);
  assert.equal(preferences["sandbox"], true);
  assert.equal(preferences["webSecurity"], true);
  assert.equal(preferences["nodeIntegrationInWorker"], false);
  assert.equal(preferences["nodeIntegrationInSubFrames"], false);
  assert.equal(preferences["allowRunningInsecureContent"], false);
  assert.equal(preferences["webviewTag"], false);
  // No preload, because nothing needs one yet: a preload is a privileged bridge and arrives with its own
  // criteria. Its absence is a decision, so it is pinned.
  assert.equal("preload" in preferences, false, "this slice ships no preload");
});

test("the audit fails on each weakened option, naming it", () => {
  // Each of these is a one-line change that would otherwise be invisible at runtime.
  const cases: [string, unknown][] = [
    ["contextIsolation", false],
    ["nodeIntegration", true],
    ["sandbox", false],
    ["webSecurity", false],
  ];
  for (const [key, bad] of cases) {
    const preferences = { ...windowWebPreferences(), [key]: bad };
    const problems = auditWindowOptions(preferences);
    assert.equal(problems.length, 1, `${key} must be reported`);
    assert.match(problems[0]!, new RegExp(key), `the report must name ${key}`);
  }
});

test("the audit reports a preload and a remote module, because either widens the renderer", () => {
  assert.match(auditWindowOptions({ ...windowWebPreferences(), preload: "/tmp/x.js" })[0] ?? "", /preload/);
  assert.match(
    auditWindowOptions({ ...windowWebPreferences(), enableRemoteModule: true })[0] ?? "",
    /enableRemoteModule/,
  );
});

// --- Criterion 2: navigation is refused off-origin -----------------------------------------------

test("the allowed origins are loopback, on the announced port only", () => {
  assert.deepEqual(allowedOrigins(PORT), [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `http://[::1]:${PORT}`,
  ]);
  // The port is the boundary. "Any loopback" would let another local service's UI present itself as this one.
  assert.equal(navigationDecision(`http://127.0.0.1:${PORT + 1}/`, PORT), "deny");
});

test("a navigation to the app's own origin is allowed, off-origin is refused, in the same run", () => {
  // Both directions asserted together, so a handler that cancels everything by accident is visible: the
  // "safest" possible implementation would break every reload (#184/#213) and pass a deny-only test.
  const allowed = [
    `http://127.0.0.1:${PORT}/`,
    `http://127.0.0.1:${PORT}/history`,
    `http://localhost:${PORT}/?x=1`,
  ];
  for (const url of allowed) assert.equal(navigationDecision(url, PORT), "allow", `${url} must load`);
  const refused = [
    "https://example.com/",
    "http://127.0.0.1:1/",
    `http://127.0.0.1:${PORT}.evil.com/`,
    `https://127.0.0.1:${PORT}/`,
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:http://127.0.0.1/abc",
    "about:blank",
    "not a url at all",
  ];
  for (const url of refused) assert.equal(navigationDecision(url, PORT), "deny", `${url} must be refused`);
});

test("a data: URL is refused unless it is the failure page the shell just minted, by token", () => {
  /*
   * The gap this closes. `data:` is reachable FROM the renderer, so "allow data URLs" would let a page navigate
   * itself to a document it wrote. The exception is therefore one document, named by a random token that page
   * script cannot guess — and a token from a PREVIOUS failure must stop working, or it is a standing key.
   */
  const document = failureDocument("<!doctype html><html><body>boom</body></html>");
  assert.equal(document.token.length, 32);
  assert.equal(navigationDecision(document.url, PORT, document.token), "allow", "the shell's own page loads");

  // A different document, and the same document with no token, are both refused.
  assert.equal(navigationDecision("data:text/html,<script>alert(1)</script>", PORT, document.token), "deny");
  assert.equal(navigationDecision(document.url, PORT), "deny", "no token, no exception");
  assert.equal(navigationDecision(document.url, PORT, "0".repeat(32)), "deny", "a wrong token is not a match");
  // And a page that merely CONTAINS the token as text is not the page: the token is in an attribute.
  assert.equal(
    navigationDecision(`data:text/html,${encodeURIComponent(`<p>${document.token}</p>`)}`, PORT, document.token),
    "deny",
  );
});

test("`file:` is refused for every shape, so the renderer cannot reach the filesystem", () => {
  // Criterion 6. `loadFile` is never used for app content, and a `file:` navigation from the renderer would be
  // the reader's home directory in a window that claims to be a dashboard.
  for (const url of ["file:///etc/passwd", "file://localhost/etc/passwd", "FILE:///etc/passwd", "file:///Users/"]) {
    assert.equal(navigationDecision(url, PORT), "deny", `${url} must be refused`);
  }
});

test("an origin is only ever a real http(s) origin, never an opaque one", () => {
  // The helper the rules above depend on. `undefined` for everything without a host: treating an opaque origin
  // as "no origin, therefore fine" is how a `data:` document becomes trusted.
  assert.equal(originOf(`http://127.0.0.1:${PORT}/x`), `http://127.0.0.1:${PORT}`);
  assert.equal(originOf("https://example.com/x"), "https://example.com");
  for (const url of ["data:text/html,x", "file:///x", "javascript:1", "blob:http://a/b", "about:blank", "", "::"]) {
    assert.equal(originOf(url), undefined, `${url} has no usable origin`);
  }
});

// --- Criterion 3: new windows are refused, http(s) goes to the browser ---------------------------

test("a new window is always denied, and an http(s) target is handed to the browser", () => {
  // Denied AND external in one answer, because the two are one decision: the app never opens a second window,
  // and a link the reader clicked with the intent to leave opens where links belong.
  const https = windowOpenDecision("https://example.com/issue/215");
  assert.equal(https.action, "deny");
  assert.equal(https.external, "https://example.com/issue/215");

  const http = windowOpenDecision("http://example.com/");
  assert.equal(http.action, "deny");
  assert.equal(http.external, "http://example.com/");
});

test("a target the OS would interpret is dropped, not opened", () => {
  /*
   * `shell.openExternal` delegates to the OS, so the scheme decides what happens: `file:` opens a document,
   * `mailto:` starts a mail client, a custom scheme starts whatever registered it. Each is an action the reader
   * did not ask the app to take, so the allowlist is on the scheme rather than on "not our origin".
   */
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "mailto:someone@example.com",
    "smb://server/share",
    "vscode://file/tmp/x",
    "ftp://example.com/",
    "not a url",
  ]) {
    assert.equal(windowOpenDecision(url).action, "deny", `${url}: the window is still denied`);
    assert.equal(windowOpenDecision(url).external, undefined, `${url} must not reach the OS`);
    assert.equal(externalTarget(url), undefined, `${url} has no external target`);
  }
});

test("the window's own origin is refused as a new window too, because one window is the rule", () => {
  // A "same origin is fine" shortcut would let the app open a second dashboard over one orchestrator — C9's
  // single-instance reasoning applied to a window rather than a process.
  const sameOrigin = windowOpenDecision(`http://127.0.0.1:${PORT}/`);
  assert.equal(sameOrigin.action, "deny");
});

// --- Criterion 4: every permission is denied ----------------------------------------------------

test("every permission is refused, from the allowed origin included", () => {
  const origin = `http://127.0.0.1:${PORT}`;
  const named = [
    "camera",
    "microphone",
    "geolocation",
    "notifications",
    "clipboard-read",
    "media",
    "midi",
    "hid",
    "serial",
    "usb",
    "display-capture",
    "openExternal",
  ];
  for (const permission of named) {
    const decision = permissionDecision(permission, origin);
    assert.equal(decision.allowed, false, `${permission} must be refused`);
    // The refusal names the permission, because a request that vanishes is indistinguishable from a bug.
    assert.match(decision.reason, new RegExp(permission === "openExternal" ? "openExternal" : permission));
  }
});

test("an unrecognised permission is refused, which is what stops a future one opening itself", () => {
  // The rule is inverted on purpose. A denylist would grant every permission Electron adds later, because
  // nobody wrote the new name down — and the grant would be invisible.
  for (const permission of ["something-new-in-electron-46", "", "unknown", "fullscreen"]) {
    assert.equal(permissionDecision(permission, `http://127.0.0.1:${PORT}`).allowed, false);
  }
  // And with no origin at all, which is what an opaque-origin document reports.
  assert.equal(permissionDecision("camera", undefined).allowed, false);
  assert.match(permissionDecision("camera", undefined).reason, /unidentified origin/);
});

// --- Criterion 5, shell half: the failure page carries a real policy ------------------------------

test("the failure page's own policy is default-src none, with no capability at all", () => {
  /*
   * A `data:` URL gets no CSP header, so the meta tag is the only policy its document has. The one relaxation
   * is `'unsafe-inline'` for the "Try again" handler the shell itself writes; every directive that grants a way
   * to reach somewhere is absent.
   */
  assert.match(FAILURE_PAGE_CSP, /default-src 'none'/);
  for (const capability of ["connect-src", "img-src", "font-src", "frame-src", "media-src"]) {
    assert.equal(FAILURE_PAGE_CSP.includes(capability), false, `the failure page must not grant ${capability}`);
  }
  assert.match(FAILURE_PAGE_CSP, /frame-ancestors 'none'/, "the page must not be frameable");
  assert.match(FAILURE_PAGE_CSP, /form-action 'none'/, "the page must not post anywhere");
});

test("the audit rejects a failure page that lost its doctype, its policy, or gained a capability", () => {
  const good = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${FAILURE_PAGE_CSP}"></head><body>x</body></html>`;
  assert.deepEqual(failureDocumentProblems(good), []);

  assert.match(failureDocumentProblems(good.replace("<!doctype html>", ""))[0] ?? "", /doctype/);
  assert.match(
    failureDocumentProblems(good.replace(/<meta http-equiv[^>]*>/, ""))[0] ?? "",
    /CSP meta tag/,
  );
  // The mutations that matter: a policy that can reach the network.
  const leaky = good.replace(FAILURE_PAGE_CSP, `${FAILURE_PAGE_CSP}; connect-src https://example.com`);
  assert.ok(
    failureDocumentProblems(leaky).some((problem) => /connect-src|drifted/.test(problem)),
    "a policy granting connect-src must be reported",
  );
});

test("the failure document is minted per call, so a token from one failure does not outlive it", () => {
  const first = failureDocument("<html><body>one</body></html>");
  const second = failureDocument("<html><body>two</body></html>");
  assert.notEqual(first.token, second.token, "a reused token would be a standing key");
  // And the token is embedded where the navigation rule looks for it.
  assert.ok(decodeURIComponent(first.url).includes(`data-failure-token="${first.token}"`));
});

// --- Criterion 7, bundle half -------------------------------------------------------------------

test("the built main bundle references no remote module", () => {
  // The options audit cannot see a transitive import; the assembled output can, which is why this reads it. The
  // bundle is built by `npm run build:package` (CI's `package` job) and is legitimately absent in a fresh
  // checkout, so absence is reported rather than failed — a skipped guarantee that looks like a passing one is
  // exactly what this file's header warns about.
  const path = new URL("../../../bin/pi-central.js", import.meta.url);
  let bundle: string;
  try {
    bundle = readFileSync(path, "utf8");
  } catch {
    console.log(`skip: ${path.pathname} is not built (npm run build:package); no bundle to scan`);
    return;
  }
  assert.deepEqual(bundleProblems(bundle), [], "the shipped bundle must not reference a remote module");
  // The scan must be able to find something, or it is vacuous.
  assert.ok(bundleProblems(`require("${FORBIDDEN_MODULES[0]}")`).length > 0, "the scan must have teeth");
});

// --- Wiring: the handlers are registered at all -------------------------------------------------

/**
 * `main.ts` cannot be executed here, so the WIRING is checked as source shape.
 *
 * This is weaker than a behavioural test and is labelled as such: it cannot prove a handler behaves, only that
 * it is registered on the event it names. It still catches the failure that matters most — a hook that is
 * simply never registered — which no amount of unit-testing the decisions would notice.
 */
const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("every hardening hook is registered in main.ts, on the event or setter it names", () => {
  for (const hook of [
    'contents.on("will-navigate"',
    'contents.on("will-redirect"',
    'contents.on("will-attach-webview"',
    "contents.setWindowOpenHandler(",
    "setPermissionRequestHandler(",
    "setPermissionCheckHandler(",
  ]) {
    assert.ok(mainSource.includes(hook), `${hook} must be registered; without it that route is open`);
  }
});

test("main.ts never loads a file or a URL it was not given by the child", () => {
  // Criterion 6's other half: `loadFile` is the one call that would put the filesystem in the window.
  assert.equal(/loadFile\s*\(/.test(mainSource), false, "loadFile must not be used for app content");
  // And the only navigations are the announced http URL and the minted failure document.
  const loads = [...mainSource.matchAll(/loadURL\(([^)]*)\)/g)].map((match) => match[1]!.trim());
  assert.deepEqual(loads.sort(), ["document.url", "httpUrl"], `unexpected loadURL targets: ${loads.join(", ")}`);
});

test("the window is created through the audited preferences, not an inline options object", () => {
  // A second `new BrowserWindow` with its own `webPreferences` would bypass criterion 1 entirely.
  const creations = [...mainSource.matchAll(/new BrowserWindow\(/g)].length;
  assert.equal(creations, 1, "exactly one window is created, so exactly one place sets its preferences");
  assert.ok(mainSource.includes("windowWebPreferences()"), "the preferences must come from the audited source");
  assert.ok(mainSource.includes("hardenWindow(window)"), "the window must be hardened where it is created");
});
