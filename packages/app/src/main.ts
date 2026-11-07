/**
 * The Electron main process (issue #214, ADR-0013).
 *
 * Thin on purpose. Everything interesting — where the package is, where the binaries are, what a child's
 * line means, when to restart — lives in `package-root.ts`, `executables.ts` and `orchestrator-process.ts`
 * and is tested by `node --test` with no Electron and no display. This file is the wiring: spawn, read,
 * `loadURL`, and show a failure that names something.
 *
 * ## Why the failure is HTML rather than a native dialog
 *
 * A native `dialog.showErrorBox` cannot be copied from, cannot be scrolled, and disappears when the
 * reader is halfway through reading the stack trace. The failures this shell reports are all
 * *diagnostic* — a missing binary, a child that printed nothing, a child that crashed — so the surface
 * has to allow selecting the text and trying again. `showFailure` renders that page.
 *
 * ## The sandbox and the window options
 *
 * `sandbox: true` here is Chromium's renderer sandbox and has nothing to do with Safehouse: the
 * *orchestrator* must be unsandboxed (C1, ADR-0001), and it is a separate process this app spawns, not a
 * child of a sandboxed one. `contextIsolation` and `nodeIntegration: false` are the settings that make
 * the window equivalent to a browser tab; #215 asserts them properly, and they are stated here so this
 * slice does not open a window that is already worse than the tab it replaces.
 */
import { BrowserWindow, app, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  loginShellLookup,
  resolveEnvironment,
  type MissingExecutable,
} from "./executables.ts";
import { resolvePackage, type PackageRoot } from "./package-root.ts";
import {
  FAILURE_PAGE_CSP,
  FALLBACK_FAILURE_PAGE,
  auditWindowOptions,
  bundleProblems,
  externalTarget,
  failureDocument,
  failureDocumentProblems,
  navigationDecision,
  permissionDecision,
  requestOrigin,
  windowWebPreferences,
} from "./window-security.ts";
import {
  LineAccumulator,
  URL_TIMEOUT_MS,
  decideAfterExit,
  keepTail,
  parseChildLine,
  planSpawn,
} from "./orchestrator-process.ts";

/** One launch's worth of state. Replaced wholesale on a restart so no stale port can survive it. */
interface Running {
  child: ChildProcess;
  url: string;
  httpUrl: string;
  window: BrowserWindow;
}

/**
 * The port the child announced, which is the ONLY port the window may display (issue #215).
 *
 * Held separately from `Running` because it outlives a failure: when the orchestrator dies the window shows a
 * failure page, `running` becomes `undefined`, and the "Try again" button navigates back — a navigation that
 * must still be refused unless it is the document the shell minted.
 */
let announcedPort: number | undefined;

/**
 * The token of the failure page currently displayed, if any (issue #215).
 *
 * A `data:` URL is the only document the shell shows that is not the loopback UI, and `data:` is reachable
 * from the renderer too — so the exception is this one page, named by a random token, rather than the scheme.
 */
let failureToken: string | undefined;

let running: Running | undefined;
let consecutiveFailures = 0;
let lastStderr = "";
let restartTimer: ReturnType<typeof setTimeout> | undefined;
/** Set while quitting, so a child's exit is not treated as a crash worth restarting. */
let quitting = false;

/** The login shell, from `$SHELL`, falling back to the platform default a GUI launch would have. */
function userShell(): string {
  const shell = process.env["SHELL"];
  if (shell !== undefined && shell !== "") return shell;
  return "/bin/zsh";
}

/**
 * Resolve the package the shell launches.
 *
 * `PI_CENTRAL_PACKAGE` is the escape hatch ADR-0013 §3 implies and `package-root.ts` documents. Without
 * an override, the search starts from `npm root -g`'s usual answers plus the app's own directory, because
 * an app in `~/Applications` has no relationship to a global prefix that a walk-up could discover.
 */
function locatePackage(): { ok: true; package: PackageRoot } | { ok: false; message: string } {
  const override = process.env["PI_CENTRAL_PACKAGE"];
  if (override !== undefined && override !== "") {
    const lookup = resolvePackage({ override });
    return lookup.ok ? { ok: true, package: lookup.package } : { ok: false, message: lookup.message };
  }
  const candidates: string[] = [];
  const shellNodeModules = loginShellLookup(userShell(), "npm");
  if (shellNodeModules !== undefined) candidates.push(join(dirname(shellNodeModules), "..", "lib", "node_modules"));
  candidates.push(join(homedir(), ".npm-global", "lib", "node_modules"), "/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules");
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const lookup = resolvePackage({ from: candidate });
    if (lookup.ok) return { ok: true, package: lookup.package };
  }
  return {
    ok: false,
    message:
      "Pi Central is not installed where this app looks for it. Install it with\n\n" +
      "  npm install -g pi-central\n\n" +
      `then reopen this app. Locations checked: ${candidates.join(", ")}.\n\n` +
      "If it is installed somewhere else, set PI_CENTRAL_PACKAGE to the directory that holds its package.json.",
  };
}

/** A minimal failure page: selectable text, and the two things worth doing next. */
function renderFailure(title: string, detail: string): string {
  const escape = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title>
<meta http-equiv="Content-Security-Policy" content="${FAILURE_PAGE_CSP}">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0e1116; color: #d7dee8; }
  h1 { font: 600 16px/1.3 -apple-system, system-ui, sans-serif; margin: 0 0 16px; color: #fff; }
  pre { white-space: pre-wrap; word-break: break-word; background: #161b23; border: 1px solid #232c38;
        border-radius: 6px; padding: 14px; margin: 0 0 16px; user-select: text; }
  p.hint { color: #8b98a8; margin: 0; }
  button { font: inherit; background: #22303e; color: inherit; border: 1px solid #33465c;
           border-radius: 6px; padding: 7px 14px; cursor: pointer; }
  button:hover { background: #2a3a4b; }
</style></head>
<body><h1>${escape(title)}</h1><pre>${escape(detail)}</pre>
<p class="hint">This text can be selected and copied.</p>
<div style="margin-top:16px"><button onclick="window.location.reload()">Try again</button></div></body></html>`;
}

/**
 * The window, created once and reused.
 *
 * Reused on purpose: a restart replaces the URL, not the window, so the reader keeps their place in the
 * display and does not get a second dashboard window stacking up. The renderer's own state is lost —
 * which is what #213's draft guard is about, and the shell does not get to reload a page with unsent work
 * either.
 */
function createWindow(): BrowserWindow {
  const preferences = windowWebPreferences();
  /*
   * The options are AUDITED before the window exists (issue #215, criterion 1).
   *
   * `windowWebPreferences` is frozen data, so this cannot fail from the inside — but it fails loudly if a later
   * change to that function weakens a setting, which is the change that would otherwise be invisible: an
   * Electron window with `nodeIntegration: true` looks and behaves identically until something exploits it.
   */
  const problems = auditWindowOptions({ ...preferences });
  if (problems.length > 0) {
    throw new Error(`refusing to open an insecure window:\n  ${problems.join("\n  ")}`);
  }
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "Pi Central",
    backgroundColor: "#0e1116",
    show: false,
    // The window is a browser tab, and is kept equivalent to one (issue #215, ADR-0006, C11). The settings
    // live in `window-security.ts` as data so they are asserted rather than merely written down here.
    webPreferences: { ...preferences },
  });
  window.once("ready-to-show", () => window.show());
  hardenWindow(window);
  return window;
}

/**
 * Lock the window to the loopback document, and to no capability beyond displaying it (issue #215).
 *
 * ## Why every hook is here rather than "the renderer is ours"
 *
 * The renderer displays **model output** — transcripts, tool results, file contents, and markdown rendered
 * from all three. ADR-0006 makes that inert in a browser tab through the CSP and DOMPurify, and those still
 * apply. What a browser tab also has, and a dock window does not, is an address bar: in the tab, a navigation
 * the reader did not ask for is visible; here it would silently replace the dashboard with something else.
 *
 * Five hooks, each closing one route out:
 *
 *   - `will-navigate` — a link click or a `location.href` assignment in the top frame.
 *   - `will-redirect` — a server-side redirect, which fires AFTER `will-navigate` and would otherwise be a
 *     navigation nobody asked for. Registering only `will-navigate` is the classic gap.
 *   - `will-attach-webview` — a `<webview>` is a second renderer with its own preferences; prevented at the
 *     attach point as well as by `webviewTag: false`, because the option is a default and this is a gate.
 *   - `setWindowOpenHandler` — `window.open` and `target="_blank"`. Denied; an `http(s)` URL the reader
 *     actually clicked is handed to their browser instead of vanishing.
 *   - `setPermissionRequestHandler` / `setPermissionCheckHandler` — every web permission, refused, including
 *     from the allowed origin. Both are registered: the request handler covers an API asking, the check
 *     handler covers a query made without a prompt (Electron's docs say the pair is what makes handling
 *     complete, and a permission granted through the unimplemented half would never be visible here).
 *
 * ## What this does NOT do, stated rather than implied
 *
 * It does not stop the *renderer* from being compromised by a bug in the app's own code. It stops the window
 * from becoming a browser for somewhere else, which is the privilege a dock icon would otherwise grant
 * quietly. C5 applies: the loopback origin is hygiene, and the real boundary is the orchestrator's logic.
 */
function hardenWindow(window: BrowserWindow): void {
  const contents = window.webContents;

  contents.on("will-navigate", (event) => {
    const decision = navigationDecision(event.url, announcedPort, failureToken);
    if (decision === "allow") return;
    event.preventDefault();
    console.error(`Pi Central: refused a navigation to ${event.url}`);
  });

  contents.on("will-redirect", (event) => {
    const decision = navigationDecision(event.url, announcedPort, failureToken);
    if (decision === "allow") return;
    event.preventDefault();
    console.error(`Pi Central: refused a redirect to ${event.url}`);
  });

  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
    console.error("Pi Central: refused to attach a <webview>; the window is one document");
  });

  contents.setWindowOpenHandler(({ url }) => {
    const external = externalTarget(url);
    if (external !== undefined) {
      // The reader clicked a link whose intent is to leave. Their browser is where that belongs; the app is
      // not. `void` because a failed open is the OS's business, not a reason to break the handler.
      void shell.openExternal(external);
      return { action: "deny" };
    }
    console.error(`Pi Central: refused to open a window for ${url}`);
    return { action: "deny" };
  });

  contents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    // The origin comes from `requestOrigin`, not from an invented `requestingOrigin` field: no permission shape
    // has that key, so reading it reported every refusal against "an unidentified origin".
    const refused = permissionDecision(permission, requestOrigin(details));
    console.error(`Pi Central: ${refused.reason}`);
    callback(false);
  });

  contents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    const refused = permissionDecision(permission, requestingOrigin);
    console.error(`Pi Central: ${refused.reason}`);
    return false;
  });
}

/**
 * Show a failure in whichever window exists, or in a fresh one.
 *
 * The page is minted (`failureDocument`) and then AUDITED (`failureDocumentProblems`) before it is loaded.
 * The audit can only fail if this file changed in a way that dropped the CSP or a doctype, which is exactly
 * the change that would otherwise ship invisibly — a `data:` document has no policy unless it carries one.
 */
function showFailure(title: string, detail: string): void {
  const window = running?.window ?? createWindow();
  const html = renderFailure(title, detail);
  const problems = failureDocumentProblems(html);
  if (problems.length > 0) {
    // The page is REFUSED, not merely reported (issue #215). This used to log "refusing to display" and then
    // load the rendered page anyway, which is enforcement that exists only in the terminal.
    console.error(`Pi Central: refusing to display an unsafe failure page:\n  ${problems.join("\n  ")}`);
    const document = failureDocument(FALLBACK_FAILURE_PAGE);
    failureToken = document.token;
    void window.loadURL(document.url);
    window.show();
    return;
  }
  const document = failureDocument(html);
  failureToken = document.token;
  void window.loadURL(document.url);
  window.show();
}

/**
 * Start the orchestrator, and load its URL.
 *
 * The order is deliberate: resolve everything first, then spawn. A window that opens before the
 * resolvables are known would have to be repainted with a failure, which reads as a flicker and a lie.
 */
function start(): void {
  const located = locatePackage();
  if (!located.ok) {
    showFailure("Pi Central could not find its own package", located.message);
    return;
  }
  const environment = resolveEnvironment({
    env: process.env,
    shell: userShell(),
    runLoginShell: loginShellLookup,
  });
  if (!environment.ok) {
    showFailure(missingTitle(environment.missing), missingDetail(environment.missing));
    return;
  }

  const plan = planSpawn({
    node: environment.environment.node,
    pkg: located.package,
    pi: environment.environment.pi,
    safehouse: environment.environment.safehouse,
    // The shell's own environment — `HOME` above all. Forwarding is an allowlist inside `planSpawn`,
    // and it is the OUTER of the two: a variable not passed here does not exist for any session either,
    // because `env.ts` reads its own PASSTHROUGH list from what it was given.
    sourceEnv: process.env,
  });

  lastStderr = "";
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines = new LineAccumulator();
  let announced = false;
  const timeout = setTimeout(() => {
    if (announced) return;
    // Criterion 4: a child that never reports a URL is killed and reported, not waited on. The window
    // must not sit empty, because an empty window is indistinguishable from a UI bug.
    child.kill("SIGTERM");
    showFailure(
      "Pi Central's orchestrator did not start",
      `It printed no URL within ${Math.round(URL_TIMEOUT_MS / 1000)} seconds, so it was stopped.\n\n` +
        (lastStderr.trim() === "" ? "It printed nothing at all." : `What it printed:\n\n${lastStderr}`),
    );
  }, URL_TIMEOUT_MS);

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of lines.push(chunk)) {
      const parsed = parseChildLine(line);
      if (parsed.kind === "bad-url") {
        // Loud, not silent: a malformed announcement means the two halves disagree about something.
        lastStderr = keepTail(lastStderr, `${parsed.reason}\n`);
        continue;
      }
      if (parsed.kind !== "url" || announced) continue;
      announced = true;
      clearTimeout(timeout);
      consecutiveFailures = 0;
      onAnnounced(child, parsed.url, parsed.httpUrl);
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    lastStderr = keepTail(lastStderr, chunk);
    // Echoed to the terminal the app was launched from, when there is one. Free diagnostics.
    process.stderr.write(chunk);
  });

  child.on("error", (error) => {
    clearTimeout(timeout);
    showFailure("Pi Central's orchestrator could not be started", `${plan.command}\n\n${error.message}`);
  });

  child.on("exit", (code, signal) => {
    clearTimeout(timeout);
    if (quitting) return;
    const window = running?.window;
    running = undefined;
    if (!announced) return; // the timeout or the error handler already reported it
    consecutiveFailures += 1;
    const decision = decideAfterExit(consecutiveFailures);
    if (decision.action === "stop") {
      showFailure("Pi Central's orchestrator stopped", `${decision.reason}\n\nexit code ${code ?? "-"}, signal ${signal ?? "-"}\n\n${lastStderr}`);
      return;
    }
    // Restarted into the SAME window, so the reader's dashboard does not double up. The renderer's
    // `Connection` reconnects on its own and re-fetches every transcript, which is why a bare reload is
    // not needed here and would in fact lose more than it restores.
    restartTimer = setTimeout(() => {
      if (window !== undefined && !window.isDestroyed()) start();
    }, decision.delayMs);
  });
}

function onAnnounced(child: ChildProcess, url: string, httpUrl: string): void {
  /*
   * The port is recorded BEFORE the load (issue #215).
   *
   * `hardenWindow`'s handlers allow exactly one origin, and it is this child's. Setting it after `loadURL`
   * would be a race in which the first navigation is refused by the app's own gate — so the order here is
   * load-bearing, not incidental. `announcedPort` also clears any failure token: the UI is about to be shown,
   * so a failure page from a previous attempt must stop being a navigable target.
   */
  const port = Number.parseInt(new URL(httpUrl).port, 10);
  if (!Number.isInteger(port) || port <= 0) {
    showFailure("Pi Central could not parse the orchestrator's URL", `Expected an http://host:port URL, got ${httpUrl}`);
    return;
  }
  announcedPort = port;
  failureToken = undefined;

  const window = running?.window ?? createWindow();
  running = { child, url, httpUrl, window };
  void window.loadURL(httpUrl);
  console.log(`Pi Central: orchestrator at ${url} (pid ${child.pid ?? "?"}), window loading ${httpUrl}`);
}

function missingTitle(missing: MissingExecutable): string {
  return `Pi Central needs \`${missing.name}\`, and could not find it`;
}

function missingDetail(missing: MissingExecutable): string {
  return `${missing.message}\n\n---\n\nTip: this app was launched from Finder, so it sees a different PATH than your terminal. Launching it from a shell (./Pi\\ Central.app/Contents/MacOS/Pi\\ Central) uses that shell's PATH and shows the same error on stdout.`;
}

/**
 * One window, one orchestrator. A second launch focuses the existing window rather than starting a second
 * orchestrator over the same session files — which is the branch-point hazard C9 describes.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = running?.window;
    if (window === undefined || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(() => {
    start();
    app.on("activate", () => {
      const window = running?.window;
      if (window === undefined || window.isDestroyed()) return;
      window.show();
      window.focus();
    });
  });

  /**
   * Closing the window is not quitting — but this slice does not implement the hide-and-reattach
   * lifecycle (#216), so the honest behaviour is to quit and let the orchestrator stop with its parent.
   * Half of #216's semantics here would be a worse lie than the plain behaviour.
   */
  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", () => {
    quitting = true;
    if (restartTimer !== undefined) clearTimeout(restartTimer);
    // `SIGTERM` rather than `SIGKILL`: the orchestrator handles it (`server.ts` closes the transport and
    // stops every session), so sessions are stopped cleanly rather than orphaned.
    running?.child.kill("SIGTERM");
  });
}
