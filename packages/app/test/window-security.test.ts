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
 *   2. Navigation is refused off-origin → `navigationDecision`, with an allowed and a refused URL in one run,
 *      and the failure page reachable by token even before any port is announced.
 *   3. New windows are refused, `http(s)` handed to the browser → `windowOpenDecision` / `externalTarget`.
 *   4. Every web permission is denied by default → `permissionDecision`, with the origin taken from
 *      `requestOrigin` because no request shape carries `requestingOrigin`.
 *   5. The CSP is unchanged and still effective → asserted against the real listener in
 *      `window-csp-live.test.ts`, plus `failureDocumentProblems` for the shell's own page and
 *      `FALLBACK_FAILURE_PAGE` for the page shown when that audit fails.
 *   6. `file://` is unreachable → `navigationDecision` refuses it, and `main.ts` never calls `loadFile`.
 *   7. No remote module → `auditWindowOptions` over the options, plus `bundleProblems` over the shell's OWN
 *      assembled output. The first version of that scan read `bin/pi-central.js`, which is the orchestrator's
 *      bundle and contains no window code at all — a guard that read the wrong artifact and reported clean.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FAILURE_PAGE_CSP,
  FALLBACK_FAILURE_PAGE,
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
  reloadDecision,
  requestOrigin,
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

test("the failure page is reachable before any port is announced, and no origin is", () => {
  /*
   * The first-run case, and the one that made "Try again" a dead button. `showFailure` runs when the package is
   * not found or a prerequisite is missing — at which point no orchestrator has announced a port, so
   * `announcedPort` is `undefined`. The handler used to read
   *
   *     announcedPort === undefined ? "deny" : navigationDecision(...)
   *
   * which denies BEFORE consulting the token, so clicking "Try again" on the only page that offers it did
   * nothing, and the terminal logged a refusal of the document the shell had just minted.
   */
  const document = failureDocument("<!doctype html><html><body>boom</body></html>");
  assert.equal(navigationDecision(document.url, undefined, document.token), "allow", "Try again must work");
  // The token is still the only document allowed, and an http origin is still refused while there is no port to
  // trust — "no port yet" must not become "any port will do".
  assert.equal(navigationDecision(`http://127.0.0.1:${PORT}/`, undefined), "deny", "no announced port, no origin");
  assert.equal(navigationDecision("data:text/html,<script>alert(1)</script>", undefined, document.token), "deny");
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
  // An EMPTY origin is reported as unidentified too: `setPermissionCheckHandler` passes `""` for a check made
  // without a document, and "camera to  (issue #215)" is a report of something that is not true.
  assert.match(permissionDecision("camera", "").reason, /unidentified origin/);
});

test("a permission refusal names the real origin, from the field Electron actually sets", () => {
  /*
   * The defect this pins. `main.ts` read `details.requestingOrigin`, which no permission-request shape has — the
   * base `PermissionRequest` carries `requestingUrl` and a `media` request adds `securityOrigin`. Reading a
   * missing key yields `undefined`, so EVERY refusal was logged against "an unidentified origin": the report
   * existed, named nothing, and looked exactly like a bug in the feature that had asked for the camera.
   */
  const origin = `http://127.0.0.1:${PORT}`;
  // A media request's own field wins.
  assert.equal(requestOrigin({ securityOrigin: origin, requestingUrl: "https://example.com/x" }), origin);
  // Without it, the origin of the URL the frame last loaded.
  assert.equal(requestOrigin({ requestingUrl: `${origin}/history?x=1` }), origin);
  // Neither, or an opaque one, names nothing rather than naming something false.
  assert.equal(requestOrigin({}), undefined);
  assert.equal(requestOrigin({ requestingUrl: "data:text/html,x" }), undefined);
  assert.equal(requestOrigin({ securityOrigin: "" }), undefined);
  // And the message the reader sees therefore carries the origin, which is the point of passing it at all.
  assert.match(permissionDecision("camera", requestOrigin({ securityOrigin: origin })).reason, /127\.0\.0\.1/);
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

test("the failure page's Try again reloads into a real retry, not the same text again", () => {
  /*
   * The failure page's only control is `window.location.reload()`. A `data:` document holds no state, so
   * reloading it re-renders the same baked-in HTML — the reader clicks and the identical failure text comes back.
   * The renderer cannot ask the main process to try again (no preload, no IPC in this slice), so the reload ITSELF
   * is the signal: Chromium emits `will-navigate` with the page's own URL for a renderer-initiated reload.
   */
  const document = failureDocument("<!doctype html><html><body>boom</body></html>");
  assert.equal(reloadDecision(document.url, document.url), "retry", "a reload of the shown page is Try again");

  // Everything else is ignored: not a retry, and not a navigation that somehow reached this decision.
  assert.equal(reloadDecision(document.url, undefined), "ignore", "no failure page shown, nothing to retry");
  const other = failureDocument("<!doctype html><html><body>other</body></html>");
  assert.equal(reloadDecision(other.url, document.url), "ignore", "another failure page is not a reload of this one");
  assert.equal(reloadDecision(`http://127.0.0.1:${PORT}/`, document.url), "ignore", "the UI is not a retry");
  // Exact match, not a prefix or `includes`: passing requires already being on that one page.
  assert.equal(reloadDecision(`${document.url}#x`, document.url), "ignore", "a URL merely starting with it is not it");
});

test("a retry is refused while one is running or while quitting", () => {
  /*
   * Source shape, because `retry()` cannot be executed here. Both guards are the C9 orphan/branch-point shapes
   * this file already reasons about: a second orchestrator over the same session files, and one nothing owns
   * because the app is on its way out. The renderer can fire the reload at ANY time, including mid-shutdown.
   */
  assert.ok(/function retry\(\)/.test(mainSource), "retry must exist for the reload to call");
  const body = mainSource.slice(mainSource.indexOf("function retry()"));
  const guarded = body.slice(0, body.indexOf("start();"));
  assert.match(guarded, /isQuitting\(\)/, "a retry during shutdown would orphan an orchestrator");
  assert.match(guarded, /running !== undefined/, "a retry while running would start a second orchestrator (C9)");
  // And the reload path actually calls it, rather than only allowing the navigation.
  assert.ok(
    /reloadDecision\(event\.url, failureUrl\) === "retry"\) retry\(\)/.test(mainSource),
    "the allowed reload must trigger the retry, or Try again stays decorative",
  );
});

test("the fallback page passes the same audit, so a refused report still leaves something to read", () => {
  /*
   * `showFailure` audits the rendered page and now REFUSES it rather than logging and loading anyway. Refusing
   * alone would leave an empty window — which this module already names as indistinguishable from a UI bug — so
   * the fallback must itself be a safe document. If it were not, the audit would be circular: the page shown
   * when the audit fails would fail the audit.
   */
  assert.deepEqual(failureDocumentProblems(FALLBACK_FAILURE_PAGE), [], "the fallback must pass the audit");
  // It interpolates NOTHING: no title, no detail, no child stderr. A template that did would move the trust
  // boundary rather than narrow it.
  assert.equal(/\$\{|\$\}/.test(FALLBACK_FAILURE_PAGE), false, "the fallback must have no interpolation");
  assert.match(FALLBACK_FAILURE_PAGE, /<!doctype html>/i);
  const minted = failureDocument(FALLBACK_FAILURE_PAGE);
  assert.equal(navigationDecision(minted.url, PORT, minted.token), "allow", "and it must be loadable");
});

test("the failure document is minted per call, so a token from one failure does not outlive it", () => {
  const first = failureDocument("<html><body>one</body></html>");
  const second = failureDocument("<html><body>two</body></html>");
  assert.notEqual(first.token, second.token, "a reused token would be a standing key");
  // And the token is embedded where the navigation rule looks for it.
  assert.ok(decodeURIComponent(first.url).includes(`data-failure-token="${first.token}"`));
});

// --- Criterion 7, bundle half -------------------------------------------------------------------

test("the assembled shell bundle references no remote module", async () => {
  /*
   * The options audit cannot see a transitive import; the assembled output can, which is why this reads it.
   *
   * WHAT it reads is the whole point of this test. It used to read `bin/pi-central.js`, which
   * `scripts/build-package.mjs` builds from `packages/orchestrator/src/server.ts` — the ORCHESTRATOR's bundle.
   * That file contains no window code at all, so the scan reported "clean" for an artifact the shell never
   * ships, and would have reported clean for a shell that imported a remote module on its first line. The shell
   * is `private` and publishes nothing (`packaging-shape.test.ts`), so it has no bundle on disk: the honest
   * equivalent is to assemble `main.ts` here, with `electron` external, using the esbuild the repo already has.
   *
   * Assembling rather than globbing the sources is what makes a TRANSITIVE import visible, which is the danger
   * the criterion names.
   */
  const { build } = await import("esbuild");
  const assembled = await build({
    entryPoints: [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    target: "node22",
    format: "esm",
    // Electron is the runtime, not a dependency to inline — and its main export is a PATH STRING, so bundling it
    // would put a binary path in the output rather than the window code this test is about.
    external: ["electron"],
    logLevel: "warning",
  });
  const bundle = assembled.outputFiles[0]?.text ?? "";
  assert.ok(bundle.includes("hardenWindow"), "the assembly must contain the shell, or the scan is vacuous");
  assert.deepEqual(bundleProblems(bundle), [], "the assembled shell must not reference a remote module");
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
  // And the only navigations are the announced http URL and a minted failure document — the fallback is the same
  // document with different content, so the target is `document.url` either way.
  const loads = [...mainSource.matchAll(/loadURL\(([^)]*)\)/g)].map((match) => match[1]!.trim());
  assert.deepEqual(loads.sort(), ["document.url", "document.url", "httpUrl"], `unexpected loadURL targets: ${loads.join(", ")}`);
});

test("the window is created through the audited preferences, not an inline options object", () => {
  // A second `new BrowserWindow` with its own `webPreferences` would bypass criterion 1 entirely.
  const creations = [...mainSource.matchAll(/new BrowserWindow\(/g)].length;
  assert.equal(creations, 1, "exactly one window is created, so exactly one place sets its preferences");
  assert.ok(mainSource.includes("windowWebPreferences()"), "the preferences must come from the audited source");
  assert.ok(mainSource.includes("hardenWindow(window)"), "the window must be hardened where it is created");
});

test("the window is not read out of the child's state, so a crash cannot build a second one", () => {
  /*
   * The defect this pins, found by re-reading the crash path rather than by a failing test. The child's `exit`
   * handler did
   *
   *     const window = running?.window;
   *     running = undefined;
   *     ... showFailure(...)
   *
   * so `showFailure`'s own `running?.window ?? createWindow()` saw `undefined` and built a SECOND window while the
   * first still showed the dashboard. The reader then has two windows, the failure page is in one they were not
   * looking at, and the "one window, reused" premise this file states is false on the one path that matters most.
   *
   * `running` tracks a CHILD (and is cleared when it dies); the window outlives any one orchestrator, so holding
   * it there made a lifetime shorter than the thing it held. The window now lives in its own binding.
   */
  assert.equal(
    /running\?\.window/.test(mainSource),
    false,
    "the window outlives `running`; reading it from there builds a second window on the crash path",
  );
  assert.ok(/function appWindow\(\)/.test(mainSource), "there must be one accessor that creates the window once");
  // The accessor is what `showFailure` uses, and it creates only when there is no usable window.
  const accessor = mainSource.slice(mainSource.indexOf("function appWindow()"));
  assert.match(
    accessor.slice(0, accessor.indexOf("}") + 1),
    /window === undefined \|\| window\.isDestroyed\(\)/,
    "a destroyed window must be replaced, and a live one reused",
  );
});

test("the permission handlers read the fields Electron actually sets", () => {
  /*
   * The request handler's `details` has no `requestingOrigin` — the base `PermissionRequest` carries
   * `requestingUrl`, and a `media` request adds `securityOrigin`. Reading the missing key yields `undefined`,
   * so every refusal was reported against "an unidentified origin". The CHECK handler is the opposite case: its
   * third parameter really is `requestingOrigin` (see `setPermissionCheckHandler` in electron.d.ts), which is
   * why the assertion below targets the request handler rather than the string.
   */
  assert.equal(
    /details\s+as\s+\{[^}]*requestingOrigin/.test(mainSource),
    false,
    "the request handler must not invent a requestingOrigin on details; use requestOrigin(details)",
  );
  assert.ok(mainSource.includes("requestOrigin(details)"), "the request handler must derive the origin");
  const decisions = [...mainSource.matchAll(/permissionDecision\(/g)].length;
  assert.equal(decisions, 2, "both handlers must call permissionDecision, so both report what they refused");
});

test("the failure page is refused when its own audit fails, not logged and loaded anyway", () => {
  /*
   * The defect this pins, in one line: `showFailure` used to `console.error("refusing to display…")` and then
   * fall through to `loadURL` of the page it had just refused. Enforcement that exists only in the terminal is
   * indistinguishable from none, which is this file's whole subject.
   */
  assert.ok(mainSource.includes("failureDocument(FALLBACK_FAILURE_PAGE)"), "the refusal must show the fallback");
  // The audit's result must gate the load: `return` between the report and the rendered page's mint.
  const guarded = /refusing to display an unsafe failure page[\s\S]{0,400}?return;/.test(mainSource);
  assert.ok(guarded, "the refusal must return before the rendered page is loaded");
});

test("a child that exits before announcing is reported, not silently swallowed", () => {
  /*
   * The defect this pins, found by watching a real window do nothing.
   *
   * The child exits in ~87 ms when it refuses to start (the C1 sandbox refusal), which is the commonest failure
   * there is. The `exit` handler read
   *
   *     clearTimeout(timeout);
   *     if (!announced) return;   // "the timeout or the error handler already reported it"
   *
   * and that comment was false twice over: `clearTimeout` cancels the timeout that would have reported it, and
   * the `error` handler fires only for a failed SPAWN, never for an exit. The reader got a blank window, a silent
   * terminal, and no retry (the `return` also skipped `decideAfterExit`).
   *
   * ## Why this is measured, not grepped
   *
   * The first version of this test sliced the source from `if (!announced)` to the next `showFailure(`/`return;`
   * and asserted what it found. Reverting the fix to `if (!announced) return;` did NOT fail it, because the slice
   * still contained this branch's own docstring — which QUOTES both words. A source-shape test whose needles
   * appear in the surrounding prose cannot distinguish code from comment, and a security-relevant guarantee that
   * passes for the wrong reason is the failure mode this whole file exists to avoid.
   *
   * So the branch is measured the way `decideAfterExit` is tested: on the ORDER of statements, with comments
   * removed first.
   */
  const code = mainSource
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const exitHandler = code.slice(code.indexOf('child.on("exit"'));
  const branchStart = exitHandler.indexOf("if (!announced)");
  assert.ok(branchStart > -1, "the pre-announcement case must be handled explicitly");
  // A `return` that ends the branch in ONE statement is the silent-swallow shape. Anything that reports first has
  // more between the condition and the return.
  const oneLiner = /if \(!announced\) return;/.test(exitHandler);
  assert.equal(oneLiner, false, "a child that died before announcing must be REPORTED, not returned from");
  // The report must come before the branch's `return`, and the retry decision must be taken in it.
  const reportAt = exitHandler.indexOf("showFailure(", branchStart);
  const returnAt = exitHandler.indexOf("return;", reportAt);
  assert.ok(reportAt > branchStart, "the pre-announcement branch must call showFailure");
  assert.ok(returnAt > reportAt, "the report must come before the branch returns");
  const branch = exitHandler.slice(branchStart, returnAt);
  assert.match(branch, /decideAfterExit\(/, "the pre-announcement path must still count as a failure");
  assert.match(branch, /lastStderr/, "it must show what the child printed; that is the whole evidence");
});
