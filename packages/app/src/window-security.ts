/**
 * What the window is allowed to do, as decisions rather than as event handlers (issue #215, ADR-0013).
 *
 * ## Why this is a separate module from `main.ts`
 *
 * `main.ts` imports `electron`, which cannot be loaded under `node --test` — the package's main export is a
 * *path string* to the binary, so `import { BrowserWindow } from "electron"` fails outside a real Electron
 * process. Every decision that #215 is about is therefore expressed here as a pure function over the facts
 * Electron would hand it, and `main.ts` does nothing but wire these to the real events.
 *
 * That split is the difference between a tested guarantee and a promised one. The alternative — asserting on
 * `main.ts`'s source text — would pass if the handler were registered on the wrong event, or if a second
 * handler were registered after it, which is precisely how these protections get lost.
 *
 * ## What is being protected
 *
 * In a browser tab the UI is inside a sandbox the reader already trusts: the browser's. The CSP
 * (`default-src 'none'`, `connect-src 'self'`, ADR-0006) and the DOMPurify pipeline make model output inert.
 * An Electron window is a **privileged** renderer, so the equivalences have to be re-established here:
 *
 *   - it must display the loopback document it was started for, and nothing else;
 *   - it must not be able to open a second window;
 *   - it must not obtain any web permission, from the allowed origin included.
 *
 * ## Why "deny everything" is the whole answer for permissions
 *
 * Pi Central needs no camera, no microphone, no geolocation, no notifications, no clipboard *read* (the
 * clipboard is written by the OS on a click, and reading it is `navigator.clipboard.readText()` which this UI
 * never calls). A filter that named the ones to refuse would be an allowlist by accident: every permission
 * Electron adds in a future version would be granted because nobody wrote it down. So the rule is inverted —
 * unrecognised is refused — and a future genuine need is a new decision rather than a hole that opened itself.
 */
import { randomBytes } from "node:crypto";

/**
 * The origins the window may display.
 *
 * Loopback only, both spellings of it, and **with the port pinned to the child's actual one**. A rule of
 * "any `127.0.0.1`" would let a page on this machine redirect the window to another local service, which is a
 * different application's UI presented as Pi Central's — the one thing a dock icon makes believable.
 *
 * `localhost` is included because Chromium and macOS resolve both, but only the port matters for the
 * boundary: an attacker-controlled local process would have to be listening on *this* port, which the
 * orchestrator is.
 */
export function allowedOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
}

/**
 * The origin of a URL, or `undefined` when it has none worth comparing.
 *
 * `undefined` for anything unparseable, and for the opaque-origin schemes — `data:`, `blob:`, `file:`,
 * `javascript:` — because each of those is a way to be "not a host" while still being somewhere. Treating
 * them as "no origin, therefore allowed" is how a `data:` URL becomes a document with `origin: null` that
 * inherits nothing and can still render markup.
 */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/**
 * What the shell is currently displaying when it is displaying a failure page rather than the UI.
 *
 * ## Why a nonce, and not "allow `data:text/html`"
 *
 * `renderFailure` shows a diagnostic page when the orchestrator will not start, and a `data:` URL is the only
 * way to display one without a file on disk or a second listener. But `data:` is reachable FROM the renderer
 * too — `location.href = "data:text/html,<script>…</script>"` is a same-origin-ish document with an opaque
 * origin — so "allow data URLs" would be a hole in the middle of the navigation rule.
 *
 * The fix is to name the exact document: the shell mints a random token per failure page and puts it in the
 * URL, and only the URL this shell generated can be navigated to. A page in the renderer cannot guess it, so
 * the rule becomes "this one document, once", which is what it was always meant to be.
 */
export interface FailureDocument {
  /** The `data:` URL `main.ts` loads. Its token is the only thing that may be re-navigated to. */
  url: string;
  /** The random token embedded in `url`. Compared by `navigationDecision`. */
  token: string;
}

/** Mint the URL for one failure page. Called per failure, so a stale token stops being valid immediately. */
export function failureDocument(html: string): FailureDocument {
  const token = randomBytes(16).toString("hex");
  const marked = html.replace("<body>", `<body data-failure-token="${token}">`);
  return { url: `data:text/html;charset=utf-8,${encodeURIComponent(marked)}`, token };
}

/**
 * The one page the window may show, and the one document it may fall back to.
 *
 * ## Why this is not "is it loopback"
 *
 * The failure this prevents is specific: a renderer that renders **model output** must not be able to
 * navigate itself. Markdown is sanitised (ADR-0006) so a transcript cannot contain a working link that
 * navigates the top frame — but a link the reader *clicks* can, and a `location.href` assignment from any
 * script in the page can. In a browser tab the address bar makes that obvious; a dock window makes it
 * invisible, and the address bar is exactly the affordance the reader loses.
 *
 * ## The two exceptions, and why they are narrow
 *
 *   1. **The same origin, any path.** The UI is a single document (`index.html`) — there is no router — but
 *      the app writes `location.reload()`, and a reload is a navigation to the same URL. Refusing it would
 *      break #184/#213's whole recovery.
 *   2. **The current failure page**, identified by its token (see `FailureDocument`). Exactly one document,
 *      and only the one this shell generated.
 *
 * A `file:` URL is NOT among them. `loadFile` is never used (criterion 6), and a `file:` navigation from the
 * renderer would put the reader's filesystem in a window that has a `webSecurity` policy about it.
 */
export function navigationDecision(url: string, port: number, failureToken?: string): "allow" | "deny" {
  const origin = originOf(url);
  if (origin !== undefined) return allowedOrigins(port).includes(origin) ? "allow" : "deny";
  if (failureToken !== undefined && failureToken.length >= 16) {
    // Decoded, because the token travels inside a percent-encoded document.
    let decoded: string;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      return "deny";
    }
    if (decoded.startsWith("data:text/html") && decoded.includes(`data-failure-token="${failureToken}"`)) {
      return "allow";
    }
  }
  return "deny";
}

/**
 * What to do with a request to open a new window.
 *
 * Returns `"deny"` for everything — there is no shape in which a second window is correct here, because the
 * app is one dashboard over one orchestrator (C9's single-instance reasoning, one level down).
 *
 * The companion decision is `externalTarget`: a link that *wants* a new window is a link the reader clicked
 * with the intent to leave, so an `http(s)` URL is handed to the real browser instead of being silently
 * dropped. That is not a widening — the browser is where a link belongs — but it must never carry a scheme
 * the OS will interpret (`file:`, `javascript:`, `smb:`), which is why the allowlist is on the scheme and not
 * on "not our origin".
 */
export function windowOpenDecision(url: string): { action: "deny"; external: string | undefined } {
  return { action: "deny", external: externalTarget(url) };
}

/**
 * The URL to hand to the reader's browser, or `undefined` to drop the request.
 *
 * Only `http:` and `https:`. Everything else is dropped rather than opened: `shell.openExternal` delegates to
 * the OS, and the OS resolves `file:` by opening a document, `mailto:` by starting a mail client, and a
 * custom scheme by whatever application registered it — each of which is an action the reader did not ask the
 * *app* to take. Dropping is reported, not silent; see `main.ts`.
 */
export function externalTarget(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a web permission is granted.
 *
 * `false` for everything, including the permissions a future Electron version adds and including requests
 * from the allowed origin. See the module docstring for why the rule is inverted rather than a denylist.
 *
 * `origin` and `permission` are taken so the refusal can be *reported* (a permission request that vanishes
 * silently is indistinguishable from a bug in the feature that needed it) — not so they can change the answer.
 */
export function permissionDecision(permission: string, origin: string | undefined): { allowed: false; reason: string } {
  const who = origin === undefined ? "an unidentified origin" : origin;
  return { allowed: false, reason: `the window denies ${permission} to ${who} (issue #215)` };
}

/**
 * The `webPreferences` the window is created with, as data so a test can assert the OBJECT Electron receives.
 *
 * ## Why each setting is here
 *
 *   - `contextIsolation: true` — the renderer's JavaScript and any preload run in separate worlds, so page
 *     script cannot reach a privileged context. Without a preload it is defence in depth; with one it is the
 *     setting that makes the preload boundary real. A later slice adding IPC must not turn this off.
 *   - `nodeIntegration: false` — no `require`, no `process`, no filesystem from the renderer (C11).
 *   - `sandbox: true` — Chromium's renderer sandbox. Unrelated to Safehouse (that is the *session* sandbox,
 *     C1); this one confines the page, which in this app displays content derived from model output.
 *   - `webSecurity: true` — same-origin policy on. Disabling it is the classic "so the fetch works" mistake,
 *     and here it would let the page read across origins.
 *   - `allowRunningInsecureContent: false` — no mixed content, which in practice means no `http:` subresource
 *     from a document loaded over `https:`; explicit because a launch-document change could otherwise flip it.
 *   - `nodeIntegrationInWorker`, `nodeIntegrationInSubFrames` — `false`: a worker or an iframe is still the
 *     renderer, and Electron's defaults for these have changed between majors.
 *   - `webviewTag: false` — a `<webview>` is a second renderer with its own settings, which is a bypass of
 *     everything above.
 *   - `enableRemoteModule` is deliberately **absent**, not set to `false`: the module was removed in Electron
 *     14, and passing the key would be a claim that this app targets an Electron old enough to have it.
 *     `main.ts` asserts its absence at startup instead (criterion 7).
 *   - `spellcheck: false` — the renderer would otherwise send typed text to the OS spell-checker. The composer
 *     holds prompts to a coding agent, which is not prose worth sending anywhere.
 *   - No `preload`: nothing needs one yet, and this slice's rule is that a preload arrives with its own
 *     criteria and its own review.
 */
export function windowWebPreferences(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  });
}

/**
 * Strings whose presence in the window options or the built main bundle means a protection was lost.
 *
 * `enableRemoteModule` is the historical one; `@electron/remote` is its successor and is a *package*, so it is
 * found by name in the bundle rather than in the options object. A dependency can reintroduce either without
 * this app's source saying so, which is why the check reads the assembled output.
 */
export const FORBIDDEN_OPTION_KEYS = ["enableRemoteModule"] as const;
export const FORBIDDEN_MODULES = ["@electron/remote", "electron/remote"] as const;

/**
 * Strings that must not appear in the assembled main bundle (issue #215, criterion 7).
 *
 * The window options object is checked at startup, but a **dependency** can reintroduce a remote module without
 * this app's own source mentioning it — `@electron/remote` installs itself from the renderer's side and widens
 * what page script can reach. So the check reads the built output, where a transitive import is visible.
 *
 * Returned as problems rather than a boolean so the failure names the string it found.
 */
export function bundleProblems(bundle: string): string[] {
  return FORBIDDEN_MODULES.filter((module) => bundle.includes(module)).map(
    (module) => `the built main bundle references ${module}, which gives the renderer a privileged channel`,
  );
}

/** Every violation of the rules above, as sentences, so the report names WHAT is wrong. */
export function auditWindowOptions(preferences: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const required: [string, unknown][] = [
    ["contextIsolation", true],
    ["nodeIntegration", false],
    ["sandbox", true],
    ["webSecurity", true],
  ];
  for (const [key, expected] of required) {
    if (preferences[key] !== expected) {
      problems.push(`webPreferences.${key} is ${JSON.stringify(preferences[key])}, expected ${JSON.stringify(expected)}`);
    }
  }
  for (const key of FORBIDDEN_OPTION_KEYS) {
    if (key in preferences) problems.push(`webPreferences.${key} is present, and the option no longer exists`);
  }
  if ("preload" in preferences) {
    problems.push("webPreferences.preload is set; this slice ships no preload (see windowWebPreferences)");
  }
  return problems;
}

/**
 * The policy for the shell's own diagnostic page.
 *
 * ## Why it differs from `UI_CSP`, and why that is not a relaxation of the app's policy
 *
 * The app's policy (`UI_CSP` in the orchestrator's `static-ui.ts`) is sent as a **header** by the listener.
 * A `data:` URL is not served by that listener, so it gets no header at all — the only policy it can have is
 * a meta tag, and criterion 5's rule is that the shell's own HTML must not be less protected than the app's.
 *
 * The one unavoidable difference is `script-src`: `location.reload()` in #214's "Try again" button is an
 * inline handler, and inline handlers need `'unsafe-inline'`. Everything that grants a *capability to reach
 * anything* is still `'none'` — no `connect-src`, no `img-src`, no `font-src`, no `frame-src`, no
 * `frame-ancestors` allowance — so the page cannot load a byte from anywhere, cannot phone home, and cannot
 * be framed. Combined with `escape()` on every interpolation (a child's stderr is the untrusted input here),
 * the relaxation reaches exactly one handler the shell itself wrote.
 *
 * A `file:` policy would have been the alternative and is worse: #215's criterion 6 keeps `file://` out of the
 * renderer entirely.
 */
export const FAILURE_PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Why a failure page is safe to show, expressed as the check rather than as the claim.
 *
 * `renderFailure` builds HTML with `escape()` on every interpolation, and the values it interpolates include a
 * child's stderr — the least trustworthy text in this system. This function is what `main.ts` calls before
 * loading the page, so "the failure page is the shell's own inert document" is enforced rather than asserted.
 *
 * The three checks are the ones whose absence would be invisible: no doctype (quirks mode, different parsing),
 * no CSP meta tag (a `data:` document has no policy whatever), and a CSP that names a network capability.
 */
export function failureDocumentProblems(html: string): string[] {
  const problems: string[] = [];
  if (!/^\s*<!doctype html>/i.test(html)) problems.push("the failure page must declare a doctype");
  // Tolerates either attribute order and either quote style: `index.html` in the UI writes the attributes
  // across two lines with the content SECOND, and a parse that assumed the opposite would report "no policy"
  // on a page that has one. The source check is `FAILURE_PAGE_CSP` either way, so the tolerance is only about
  // reading the value.
  const tag = /<meta[^>]*http-equiv=["']content-security-policy["'][^>]*>/i.exec(html)?.[0];
  // The quote is captured and back-referenced, because the POLICY ITSELF contains single quotes
  // (`default-src 'none'`): a `[^"']+` capture would stop at the first one and report a truncated policy.
  const policy = tag === undefined ? undefined : /content=(["'])([\s\S]*?)\1/i.exec(tag)?.[2];
  if (policy === undefined) {
    problems.push("the failure page must carry a CSP meta tag; a data: URL receives no header");
    return problems;
  }
  if (!/default-src 'none'/.test(policy)) problems.push("the failure page's CSP must default to 'none'");
  // The capability checks: any of these in the policy is a way to reach somewhere the page has no business.
  for (const directive of ["connect-src", "img-src", "font-src", "frame-src", "media-src", "worker-src", "child-src"]) {
    if (policy.includes(directive)) problems.push(`the failure page's CSP grants ${directive}`);
  }
  if (policy !== FAILURE_PAGE_CSP) {
    problems.push(`the failure page's CSP has drifted from FAILURE_PAGE_CSP:\n  found: ${policy}`);
  }
  return problems;
}

