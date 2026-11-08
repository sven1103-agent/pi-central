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
import { BrowserWindow, app, dialog, shell } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  loginShellLookup,
  resolveEnvironment,
  type Environment,
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
  reloadDecision,
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
import {
  DEFAULT_STOP_CHOICE,
  PROBE_TIMEOUT_MS,
  STOP_CHOICES,
  choiceIndex,
  connectionRefused,
  decideAttach,
  decideStop,
  probeCommand,
  readRuntimeRecord,
  rememberedMarks,
  removeRuntimeRecord,
  stopQuestion,
  urlsFor,
  writeRuntimeRecord,
  type ProbeAnswer,
  type RuntimeRecord,
} from "./runtime-record.ts";
import { askLiveSessions, type SocketLike } from "./live-sessions.ts";

/**
 * The name macOS shows, and therefore the directory the runtime record lives in.
 *
 * Set before `app.getPath("userData")` is first read, which is why it is here rather than in `whenReady`: without
 * it Electron derives the data directory from the package name (`@pi-central/app`), and `~/Library/Application
 * Support/Pi Central` — the path this slice names — would be somewhere else.
 */
app.setName("Pi Central");

/**
 * The one window, created on first use and reused for the life of the process.
 *
 * ## Why the window is not held on `Running`
 *
 * `Running` is cleared the moment the child exits, and `showFailure` is called *after* that — so reading the
 * window out of `running` built a SECOND window on the crash path while the first still showed the dashboard,
 * which contradicts this slice's "one window, reused" premise. The window outlives any one orchestrator (a
 * restart reuses it, and a failure page stays until Try again succeeds), so it is held here, where nothing
 * that tracks a child can clear it.
 */
let window: BrowserWindow | undefined;

/**
 * The orchestrator launch this window is showing.
 *
 * ## Why `child` is optional (issue #216)
 *
 * It is absent when the orchestrator was **adopted**: a previous launch started it, it is still running, and it
 * still owns every session in its list. There is no `exit` event to watch and no process handle to reuse, so
 * everything that used to read `running.child` unconditionally now reads `running` and asks what it is. `pid` is
 * kept outside `child` because it is the one identity fact both cases have — and, for an adopted orchestrator, it
 * came from the record and was verified against the process's start time before it was trusted.
 */
interface Running {
  /** Absent when adopted from a previous launch's record. */
  child: ChildProcess | undefined;
  pid: number;
  url: string;
  httpUrl: string;
}

/**
 * Whether a `⌘Q` has already been answered, so it must not be asked again.
 *
 * `before-quit` fires once per `app.quit()`, and this file calls `app.quit()` itself once the question has been
 * answered — so without this the second pass would ask the same question about the same sessions.
 */
let quitDecided = false;

/** Set while the question is on screen, so a second `⌘Q` cannot stack dialogs. */
let askingAboutQuit = false;

/** How long a stopped orchestrator is given to exit before the app stops waiting for it. */
const STOP_GRACE_MS = 5000;

/** Set while a launch is being decided, so a double `Try again` cannot run two decisions at once. */
let launching = false;

/**
 * Whether the answered question was "Keep sessions running".
 *
 * Read by `stopOrchestratorForQuit`, and set only on the `⌘Q` path. It is a field rather than a parameter because
 * `before-quit` has no way to receive one: the answer arrives in a promise, and the handler that acts on it is the
 * *second* pass through `before-quit`.
 */
let detachOnQuit = false;

/**
 * Whether quitting is already under way.
 *
 * Read by `retry`, which the renderer can trigger at any time — including during the shutdown window between
 * `before-quit` and the process actually ending. Spawning an orchestrator there would start something nothing
 * owns, which is the orphan this file's exit handling exists to avoid.
 */
function isQuitting(): boolean {
  return quitting;
}

/**
 * The port the child announced, which is the ONLY port the window may display (issue #215).
 *
 * Held separately from `Running` because it outlives a failure: when the orchestrator dies the window shows a
 * failure page, `running` becomes `undefined`, and the "Try again" button reloads that page — a navigation that
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

/**
 * The full URL of the failure page currently displayed, so a reload of it can be RECOGNISED.
 *
 * `failureToken` answers "is this the document we minted"; this answers "is this that document being reloaded
 * again", which is the signal the failure page's "Try again" produces. The two are kept apart because they lead
 * to different answers: a first load must be allowed, and a reload must be allowed *and* made to retry.
 */
let failureUrl: string | undefined;

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
    if (decision === "allow") {
      // A reload of the failure page we are showing IS the reader pressing "Try again" (see `reloadDecision`).
      // Re-loading the same `data:` document would re-render the same text and look like nothing happened, so
      // the decision to retry is taken here and the reload itself is left alone.
      if (reloadDecision(event.url, failureUrl) === "retry") retry();
      return;
    }
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
 * The window to show something in, creating it on first use.
 *
 * The single accessor for the window, so "exactly one `new BrowserWindow`" stays true and a failure during startup
 * cannot build a second one.
 */
function appWindow(): BrowserWindow {
  if (window === undefined || window.isDestroyed()) window = createWindow();
  return window;
}

/**
 * Try the launch again, from whatever the reader is looking at (issue #215).
 *
 * Guarded rather than blind: a retry during shutdown would spawn an orchestrator nothing owns, which is the
 * orphan this file's exit handling exists to prevent. A retry while one is already running would start a second
 * over the same session files — C9's branch-point hazard, one process down.
 */
function retry(): void {
  if (isQuitting()) {
    console.error("Pi Central: not retrying, because the app is quitting");
    return;
  }
  if (running !== undefined) {
    console.error("Pi Central: not retrying, because an orchestrator is already running");
    return;
  }
  console.log("Pi Central: trying again");
  /*
   * The failure token and URL are deliberately NOT cleared here.
   *
   * `start()` is asynchronous when it gets as far as spawning (it waits for the child to announce a port), and
   * the old failure page stays on screen the whole time. Clearing the token now would make that page stop being
   * reloadable mid-retry, so a reader who clicks "Try again" twice would get a REFUSAL of the page they are
   * looking at. Whichever document replaces it clears them: `showFailure` mints a new one, `onAnnounced` clears
   * both as the UI takes over.
   */
  start();
}

/**
 * Show a failure in whichever window exists, or in a fresh one.
 *
 * The page is minted (`failureDocument`) and then AUDITED (`failureDocumentProblems`) before it is loaded.
 * The audit can only fail if this file changed in a way that dropped the CSP or a doctype, which is exactly
 * the change that would otherwise ship invisibly — a `data:` document has no policy unless it carries one.
 */
function showFailure(title: string, detail: string): void {
  const target = appWindow();
  const html = renderFailure(title, detail);
  const problems = failureDocumentProblems(html);
  if (problems.length > 0) {
    // The page is REFUSED, not merely reported (issue #215). This used to log "refusing to display" and then
    // load the rendered page anyway, which is enforcement that exists only in the terminal.
    console.error(`Pi Central: refusing to display an unsafe failure page:\n  ${problems.join("\n  ")}`);
    const document = failureDocument(FALLBACK_FAILURE_PAGE);
    failureToken = document.token;
    failureUrl = document.url;
    void target.loadURL(document.url);
    target.show();
    return;
  }
  const document = failureDocument(html);
  failureToken = document.token;
  failureUrl = document.url;
  void target.loadURL(document.url);
  target.show();
}

/**
 * Start (or adopt) the orchestrator, and load its URL.
 *
 * The order is deliberate: resolve everything first, then decide, then spawn. A window that opens before the
 * resolvables are known would have to be repainted with a failure, which reads as a flicker and a lie.
 *
 * ## Why this is two functions now (issue #216)
 *
 * `launch` decides *whether* to start one at all. A previous launch may have left an orchestrator running with
 * every session in it, and starting a second over the same session files is the branch point C9 describes — so
 * the decision (adopt, or spawn) comes first and is made from evidence (`decideAttach`), and only a `spawn`
 * verdict reaches `spawnOrchestrator`.
 */
function start(): void {
  if (launching) {
    console.error("Pi Central: not launching again while a launch is under way");
    return;
  }
  launching = true;
  void launch().finally(() => {
    launching = false;
  });
}

async function launch(): Promise<void> {
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

  const { record, note } = readRuntimeRecord(app.getPath("userData"));
  if (note !== undefined) console.error(`Pi Central: ${note}`);
  /*
   * The probe is taken ONCE and reused for both decisions below.
   *
   * An earlier draft called `probeProcess` twice — once for `decideAttach`, once to decide whether the record should
   * be removed — and the two calls are two measurements of a process that can exit between them. The disagreement
   * they can produce is the one that matters: "adopt" followed by "remove the record of the thing just adopted".
   */
  const marks = record === undefined ? undefined : probeProcess(record.pid);
  const decision = decideAttach({
    record,
    marks,
    answer: record === undefined ? undefined : await probePort(record.port),
    expectsNewProcess: expectsNewProcess(),
  });
  console.log(`Pi Central: ${decision.reason}`);

  if (decision.verdict === "attach" && record !== undefined) {
    adopt(record, decision.reason);
    return;
  }

  /*
   * The record is removed only once the process it named is known to be gone or to be somebody else.
   *
   * It is KEPT when the probe could not be run at all: the orchestrator may be alive and holding every session, so the
   * next launch must still be able to adopt it even though this one could not. That is the whole reason `marks` is
   * consulted here rather than the decision's prose.
   */
  if (record !== undefined && marks?.status !== "unknown") {
    const removed = removeRuntimeRecord(app.getPath("userData"));
    if (!removed.ok) console.error(`Pi Central: ${removed.message}`);
  }

  if (decision.delayMs > 0) {
    // Whatever holds the remembered port is not ours and was not asked to stop, and the shell never picks a port
    // (ADR-0013 §4), so the only thing it can do is give that process a moment before binding its own.
    await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
  }
  spawnOrchestrator(located.package, environment.environment);
}

/**
 * Adopt a running orchestrator: no spawn, no record write, and a window that loads its socket.
 *
 * Nothing is written to the record here. The record already names this process and this port, and re-writing it
 * would replace the process's *start time* with the time this launch happened to notice it — destroying the one
 * fact that identifies it, and turning every later launch into a PID-reuse check against the wrong number.
 */
function adopt(record: RuntimeRecord, reason: string): void {
  const { url, httpUrl } = urlsFor(record.port);
  onAnnounced(undefined, record.pid, url, httpUrl);
  console.log(`Pi Central: ${reason}`);
}

/**
 * Read one process's start time, through `sh` (see `probeCommand` for why not `process.kill(pid, 0)`).
 *
 * Asynchronous rather than `spawnSync`: this runs while a window may be open and the app is deciding, and a
 * synchronous `ps` would freeze the window for as long as the probe takes.
 */
function probeProcess(pid: number): ReturnType<typeof rememberedMarks> {
  const [flag, script] = probeCommand(pid);
  const result = spawnSh(flag, script);
  return rememberedMarks(result, Date.now());
}

/**
 * Run the probe synchronously and return its merged output, or `undefined` when the shell could not be run.
 *
 * ## Why `spawnSync` here and `spawn` everywhere else
 *
 * This is the one place where a *blocking* call is the honest one. The probe answers a question the launch cannot
 * proceed without, and the launch happens before there is a window to keep responsive — while the alternative, an
 * `await` on a child whose answer decides whether a second orchestrator is started, opens a window in which a
 * second `⌘Q` or a `Try again` could reach the same decision twice. `PROBE_TIMEOUT_MS` bounds it, so the freeze is
 * two seconds at worst and normally a few milliseconds.
 *
 * `output` is stdout and stderr merged, because `probeCommand` merges them at the shell (`2>&1`): the difference
 * between "no such process" and "I may not look" is exactly what tells a fresh spawn from a second orchestrator
 * over live sessions, and `rememberedMarks` classifies it.
 */
function spawnSh(flag: string | undefined, script: string | undefined): { ok: boolean; output: string } | undefined {
  try {
    const result = spawnSync("/bin/sh", [flag ?? "-c", script ?? ""], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
    });
    if (result.error !== undefined) return undefined;
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
  } catch {
    return undefined;
  }
}

/**
 * Ask the remembered port for `/` and decide whether the answer is the UI this app serves.
 *
 * Unlike the process probe this can be asynchronous without a hazard: it is not a decision that two callers could
 * reach at once with different answers, and it is the slower of the two, so overlapping it with the probe would
 * be the only way to make the launch wait for its slower half for nothing.
 */
async function probePort(port: number): Promise<ProbeAnswer> {
  const seek = async (path: string): Promise<ProbeAnswer> => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: "manual",
        headers: { accept: "text/html" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      // The body is read only for a 200: it is the page's own head that identifies the UI, and an error page's
      // body is not evidence of anything.
      const body = response.status === 200 ? await response.text() : "";
      return { ok: true, status: response.status, location: response.headers.get("location") ?? undefined, body };
    } catch (error) {
      return { ok: false, reason: (error as Error).message, refused: connectionRefused(error) };
    }
  };
  const first = await seek("/");
  if (!first.ok) return first;
  /*
   * One redirect is followed. `/` is served as the document by `static-ui.ts`, but a build that answers `307
   * /index.html` is still the same listener, and refusing a redirect outright would turn a fact about a static
   * handler into a verdict about identity. The markers on the other side are what decide, which is why exactly one
   * hop is followed and not a chain.
   */
  if (first.status >= 300 && first.status < 400 && first.location !== undefined) {
    const target = new URL(first.location, `http://127.0.0.1:${port}`);
    if (target.origin === `http://127.0.0.1:${port}`) return seek(target.pathname);
  }
  return first;
}

/**
 * Whether this launch was told, by its own argv, that a new orchestrator is required.
 *
 * #217's shape: the shell restarts itself after an install, and the process left over from before the install is
 * the OLD version running the OLD code. Inferring this from "the version on disk changed" would be a guess about
 * why the app was started; a flag is a statement.
 */
function expectsNewProcess(): boolean {
  return process.argv.includes("--restart-orchestrator");
}

/** Spawn a fresh orchestrator, watch it, and load what it announces. */
function spawnOrchestrator(pkg: PackageRoot, environment: Environment): void {
  const plan = planSpawn({
    node: environment.node,
    pkg,
    pi: environment.pi,
    safehouse: environment.safehouse,
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
    /*
     * Its own session, so the orchestrator survives this app (issue #216, criterion 4).
     *
     * Without `detached`, the child is in the app's process group and a `SIGTERM` aimed at the group — which is what
     * a `kill` at a shell prompt, or a logout, does — reaches the orchestrator and every session under it. With it,
     * `⌘Q` -> "Keep sessions running" leaves a process whose lifetime is its own, which is the property the whole
     * slice rests on; the app's exit does not take it along.
     */
    detached: true,
  });
  /*
   * `unref()` as well, because detachment alone is about the child's session and not about this process's loop.
   *
   * A referenced child keeps the parent's event loop alive, so an app whose window is closed and whose orchestrator
   * was left running would sit in the dock refusing to finish quitting — the opposite of criterion 1. The pipes are
   * released on the detach path in `stopOrchestratorForQuit`, which covers the handles `unref()` does not.
   */
  child.unref();

  const lines = new LineAccumulator();
  const pid = child.pid;
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
      onAnnounced(child, pid, parsed.url, parsed.httpUrl);
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
    running = undefined;
    if (!announced) {
      /*
       * The child died BEFORE it announced a URL (issue #215).
       *
       * This used to `return` with a comment saying "the timeout or the error handler already reported it", and
       * neither had: `clearTimeout(timeout)` above cancels the timeout that would have, and the `error` handler
       * only fires for a failed SPAWN, not for an exit. So a child that started and then died in 87 ms — which
       * is what the C1 sandbox refusal does — produced no window change, no message, and no log line. The reader
       * saw a window that had simply stopped, which is the exact failure this file's `showFailure` exists to
       * prevent: an empty window is indistinguishable from a UI bug.
       *
       * It is reported here rather than left to the timeout because this is the common shape and it has BETTER
       * evidence: the child has finished printing, so `lastStderr` holds its whole complaint ("this process is
       * inside a sandbox, and Seatbelt does not nest (C1)"), where the timeout path can only say "it printed
       * nothing within N seconds".
       */
      consecutiveFailures += 1;
      const stopped = decideAfterExit(consecutiveFailures);
      const detail =
        `It started but exited after ${code === null ? "a signal" : `code ${code}`}` +
        `${signal === null ? "" : ` (signal ${signal})`} before reporting a URL.` +
        `\n\n${lastStderr.trim() === "" ? "It printed nothing at all." : `What it printed:\n\n${lastStderr.trim()}`}`;
      showFailure("Pi Central's orchestrator could not start", detail);
      // Still retried, because a transient cause (a port stolen mid-start) is worth one more attempt — but the
      // reader is told what happened FIRST, so the window is never blank while the supervisor decides.
      if (stopped.action === "restart") {
        restartTimer = setTimeout(() => {
          if (window !== undefined && !window.isDestroyed()) start();
        }, stopped.delayMs);
      }
      return;
    }
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

function onAnnounced(child: ChildProcess | undefined, pid: number | undefined, url: string, httpUrl: string): void {
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
  failureUrl = undefined;

  const target = appWindow();
  running = { child, pid: pid ?? -1, url, httpUrl };
  void target.loadURL(httpUrl);
  console.log(`Pi Central: orchestrator at ${url} (pid ${pid ?? "?"}), window loading ${httpUrl}`);

  /*
   * The record is written for a process this shell STARTED (issue #216, criterion 5).
   *
   * An adopted orchestrator is not re-recorded: its record already names it, and re-writing would replace the
   * process's real start time with the moment this launch noticed it — destroying the fact every later launch
   * checks identity against.
   *
   * `startedAt` is read back from the operating system rather than taken as "now". The record must hold the
   * same measurement the next launch will compare against (`marksFromEtime`), and `Date.now()` at spawn time is a
   * different quantity: it is when this line ran, not when the process began.
   */
  if (child !== undefined && pid !== undefined) {
    const marks = probeProcess(pid);
    if (marks.status === "present" && marks.marks !== undefined) {
      const written = writeRuntimeRecord(app.getPath("userData"), { pid, port, startedAt: marks.marks });
      if (!written.ok) console.error(`Pi Central: ${written.message}`);
    } else {
      /*
       * The process could not be identified, so no record is written. A record without a true start time would
       * be a record the next launch must refuse (it compares marks), and a record that cannot be trusted is
       * worse than none: it would make every launch take the "discard and spawn" path while looking like a bug.
       * The consequence is stated rather than hidden: this run cannot be reattached — closing the window and
       * reopening starts a fresh orchestrator over the same session files, which #185's `open-sessions.json`
       * restores. That is why the message says what was lost.
       */
      console.error(
        `Pi Central: not recording this orchestrator, because its start time cannot be read (${marks.status === "unknown" ? marks.reason : marks.status}), ` +
          `so a later launch will not be able to reattach to it`,
      );
    }
  }
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
 *
 * ## What quitting means (issue #216)
 *
 * Three separate things, and conflating them was the whole defect this slice answers:
 *
 *   - **Closing the window hides it.** The app stays open and the child keeps running, so the work does not stop
 *     because a window was dismissed. The dock icon re-opens the window that exists (`activate`).
 *   - **`⌘Q` quits, and asks first when sessions are live.** The question names them (asked of the orchestrator,
 *     not counted by the shell), and it offers to leave them running.
 *   - **The next launch reattaches.** `runtime.json` names the orchestrator a previous launch left behind, and a
 *     PID whose start time matches is adopted rather than duplicated.
 *
 * ## Why `before-quit` is a gate rather than a cleanup handler
 *
 * `app.quit()` is the only way out, so `before-quit` is the only place a question can be asked — and it is
 * synchronous, so the answer has to arrive later: `preventDefault` holds the quit, the dialog is shown, and the
 * choice either re-enters `app.quit()` with `quitDecided` set (`detach`/`stop`) or drops the quit (`cancel`).
 * Doing the cleanup unconditionally here — which is what the previous slice did, with a bare `SIGTERM` — is what
 * made "quit" and "stop every session" the same action.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const existing = window;
    if (existing === undefined || existing.isDestroyed()) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });

  app.whenReady().then(() => {
    start();
    app.on("activate", () => {
      /*
       * The dock icon, which after criterion 1 is the only way back to a hidden window.
       *
       * This no longer returns early when there is no window: a close destroys it, and the app is still running by
       * design, so `activate` has to be able to build a new one and load the orchestrator that is still there. If
       * `running` survived the close, the new window loads the same URL through `loadURL` — the orchestrator is not
       * restarted, which is the property criterion 1 asserts from the other side (its PID is unchanged).
       */
      const existing = window;
      if (existing !== undefined && !existing.isDestroyed()) {
        existing.show();
        existing.focus();
        return;
      }
      console.log("Pi Central: reopening the window");
      const current = running;
      if (current !== undefined) {
        const target = appWindow();
        void target.loadURL(current.httpUrl);
        return;
      }
      // No orchestrator either: an earlier launch failed, or the child is being restarted. `start()` is guarded
      // against a second launch, so this cannot double one.
      start();
    });
  });

  /**
   * Closing every window is not quitting (criterion 1).
   *
   * On macOS the app stays in the dock with its orchestrator alive, which is the `⌘Q`-vs-close distinction the
   * platform already teaches. Everywhere else `window-all-closed` is the quit signal, and a dock icon is not the
   * way back — so the platform is asked rather than assumed, and `darwin` is the only platform Safehouse runs on
   * anyway (C10).
   */
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    /*
     * `quitting` is deliberately NOT set here (issue #216).
     *
     * It is what `retry` consults to refuse a spawn nothing would own, and it is read by the child's `exit` handler to
     * tell "we are stopping it" from "it crashed and should be restarted". Setting it on entry would make the whole
     * dialog look like a quit in progress: a reload from the failure page would be refused while the reader is still
     * deciding, and if they chose Cancel the app would already be in a state the rest of the file reads as terminal.
     * It is set by the branches that are actually going to quit.
     */
    if (restartTimer !== undefined) clearTimeout(restartTimer);

    /*
     * Nothing is asked, and nothing is killed, that has already been decided.
     *
     * `quitDecided` is set by the answer below, which then calls `app.quit()` again — so this is the second pass
     * through the same handler, and it must be the one that actually stops things. It holds the quit while the child
     * exits, which is criterion 2's "both gone, no orphan": without the hold, the app would end and leave the
     * orchestrator mid-shutdown, which is the orphan this path exists to avoid. The exit is observed rather than
     * assumed, and `STOP_GRACE_MS` bounds it so a wedged child cannot keep the app on screen for ever.
     */
    if (quitDecided) {
      quitting = true;
      const stopped = stopOrchestratorForQuit();
      if (stopped !== undefined) {
        event.preventDefault();
        void stopped.then(() => app.quit());
      }
      return;
    }

    /*
     * A `second-instance` launch, `activate`, or a restart timer must not survive the quit. The timers are cleared
     * above; `launching` is not cancelled, but `start()`'s only effect after this point would be a spawn that
     * `stopOrchestratorForQuit` then stops, which is why `retry` refuses while quitting.
     */
    if (askingAboutQuit) {
      // A second `⌘Q` while the question is up: hold the quit, do not stack dialogs. The first dialog's answer
      // decides, and it re-enters `app.quit()` itself.
      event.preventDefault();
      return;
    }

    event.preventDefault();
    askingAboutQuit = true;
    void decideAndQuit();
  });
}

/**
 * Ask the orchestrator what is live, decide, and act.
 *
 * Always ends in one of two states: `app.quit()` re-entered with `quitDecided` set, or no quit at all. The dialog
 * is built from `decideStop`'s list, which is the orchestrator's own snapshot (`askLiveSessions`) — see
 * `runtime-record.ts` for why the shell may not count for itself.
 */
async function decideAndQuit(): Promise<void> {
  const current = running;
  const answer =
    current === undefined
      ? { sessions: [], note: undefined }
      : await askLiveSessions(connectSocket, current.url);
  if (answer.note !== undefined) console.error(`Pi Central: ${answer.note}`);

  const decision = decideStop(answer.sessions);
  askingAboutQuit = false;
  if (decision.action === "quit") {
    quitting = true;
    quitDecided = true;
    app.quit();
    return;
  }

  const { message, detail } = stopQuestion(decision.sessions);
  const answerIndex = await showStopQuestion(message, detail);
  const choice = STOP_CHOICES[answerIndex] ?? STOP_CHOICES[0];

  if (choice?.id === "cancel") {
    // The app stays open, and a later `⌘Q` must ask again — so the gate is reset rather than left set.
    quitting = false;
    console.log("Pi Central: quit cancelled; nothing was stopped");
    return;
  }
  /*
   * `detach` and `stop` differ in exactly one place: whether the child is signalled. That difference is carried by
   * `quitDecided`'s companion field rather than by two code paths, so "keep sessions running" cannot accidentally
   * inherit the stop that the other branch performs.
   */
  detachOnQuit = choice?.id === "detach";
  quitting = true;
  quitDecided = true;
  app.quit();
}

/**
 * Ask the question, and return the index of the answer.
 *
 * Order and default come from `STOP_CHOICES` and `DEFAULT_STOP_CHOICE`, not from here: the wording and the
 * default are the interface, so they live where a test can read them (`runtime-record.test.ts`). `cancelId` is the
 * same index as the default for a separate reason — a dismissal is `Escape`, and `Escape` must mean "do not stop
 * anything", which is the default's meaning. Making dismissal mean `Stop` is the one mistake this dialog must not
 * make.
 */
async function showStopQuestion(message: string, detail: string): Promise<number> {
  try {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: STOP_CHOICES.map((choice) => choice.label),
      defaultId: choiceIndex(DEFAULT_STOP_CHOICE),
      // `Escape` maps to Cancel, so a reader who dismisses the dialog keeps their sessions.
      cancelId: choiceIndex("cancel"),
      message,
      detail: `${detail}\n\n${STOP_CHOICES.map((choice) => `${choice.label}: ${choice.detail}`).join("\n")}`,
      noLink: true,
    });
    return response;
  } catch (error) {
    /*
     * A dialog that cannot be shown must not stop sessions. Falling through to `Keep sessions running` is the
     * safe direction and the one `defaultId` already names; the alternative would be a quit that stops work because
     * a window could not be drawn.
     */
    console.error(`Pi Central: could not ask about the running sessions (${(error as Error).message}); keeping them`);
    return choiceIndex(DEFAULT_STOP_CHOICE);
  }
}

/**
 * Stop the orchestrator, or leave it running — the half of the quit that touches the child.
 *
 * Returns how long the caller must wait for the child's exit, or `undefined` when there is nothing to wait for (the
 * keep path, or no orchestrator at all). The quit is held for that long, which is what makes "both gone" true rather
 * than nearly true: `SIGTERM` is a request, and `server.ts` answers it by closing the transport and stopping every
 * session — work with a duration.
 *
 * ## Why `detach` only destroys the pipes
 *
 * Because survival is already guaranteed by `detached: true` at spawn, and adding an `unref()` here would be a claim
 * that this is what keeps the child alive. What is *not* already handled is the pipes: the parent's ends are read
 * handles in this process, and a chatty child writing into a pipe whose reader has exited would eventually see a
 * closed stream. Destroying them is the honest teardown — it says "I am done listening", not "I am done owning".
 *
 * ## Why the record is removed BEFORE the signal
 *
 * A record naming a process that is on its way out is a stale hint, and the tidy path has no reason to leave one. If
 * the app is ended while the child is still shutting down, criterion 6 is what makes that harmless — but the ordering
 * means the tidy case never needs it.
 */
function stopOrchestratorForQuit(): Promise<void> | undefined {
  const current = running;
  if (current === undefined) return undefined;

  if (detachOnQuit) {
    // Criterion 4: the child is left alive, and nothing is sent to it. Only the pipes are released.
    current.child?.stdout?.destroy();
    current.child?.stderr?.destroy();
    console.log(`Pi Central: leaving the orchestrator running (pid ${current.pid}); the next launch will reattach to it`);
    return undefined;
  }

  const removed = removeRuntimeRecord(app.getPath("userData"));
  if (!removed.ok) console.error(`Pi Central: ${removed.message}`);

  /*
   * An adopted orchestrator has no `ChildProcess` handle, so the PID is used. The identity was verified when it was
   * adopted (its start time and its UI), which is what makes signalling it a statement about the right process
   * rather than about whatever now holds the number.
   */
  if (current.child === undefined) {
    try {
      process.kill(current.pid, "SIGTERM");
    } catch (error) {
      console.error(`Pi Central: could not stop the orchestrator (pid ${current.pid}): ${(error as Error).message}`);
      return undefined;
    }
    return waitForPidExit(current.pid);
  }

  const child = current.child;
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    const timer = setTimeout(() => {
      // The grace period is a bound on the app's own patience, not a kill: a wedged child is reported and the app
      // still exits, because a quit that never completes is worse than one that says what it could not stop.
      console.error(`Pi Central: the orchestrator did not stop within ${STOP_GRACE_MS} ms; quitting anyway`);
      finish();
    }, STOP_GRACE_MS);
    // `SIGTERM` rather than `SIGKILL`: the orchestrator handles it (`server.ts` closes the transport and stops every
    // session), so sessions are stopped cleanly rather than orphaned.
    child.kill("SIGTERM");
  });
}

/** Wait for a PID to disappear, bounded by `STOP_GRACE_MS`. Used for an adopted orchestrator, which has no handle. */
function waitForPidExit(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + STOP_GRACE_MS;
    const check = (): void => {
      // The probe is the liveness test (C16): `kill(pid, 0)` cannot distinguish "gone" from "may not signal".
      if (probeProcess(pid).status === "absent" || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

/**
 * The `ws` client, resolved on first use.
 *
 * `ws` arrives with the installed package and is not in the shell's own dependencies (which are asserted to name no Pi
 * Central package — it is the orchestrator's). So it is resolved with `createRequire`, and a failure is deferred rather
 * than fatal: a missing `ws` costs the session list in one dialog, which is a worse sentence in a `⌘Q` and not a reason
 * for the app not to start.
 */
type WebSocketLike = { on(event: string, listener: (argument: never) => void): void; close(): void };
type WebSocketConstructor = new (url: string) => WebSocketLike;

let socketConstructor: WebSocketConstructor | undefined;

function socketClient(): WebSocketConstructor | undefined {
  if (socketConstructor !== undefined) return socketConstructor;
  try {
    const loaded = createRequire(import.meta.url)("ws") as unknown;
    // The package exports the class; whether it arrives bare, as `default` or as `WebSocket` depends on the resolution
    // path, so all three are accepted rather than pinning one.
    const candidate =
      typeof loaded === "function"
        ? loaded
        : ((loaded as { WebSocket?: unknown } | null)?.WebSocket ?? (loaded as { default?: unknown } | null)?.default);
    if (typeof candidate === "function") socketConstructor = candidate as WebSocketConstructor;
  } catch {
    // Left unresolved: `connectSocket` turns this into a socket that never answers.
  }
  return socketConstructor;
}

/**
 * The socket `askLiveSessions` asks through.
 *
 * When `ws` cannot be resolved the returned socket accepts listeners and never speaks, which `askLiveSessions` reports
 * as "the orchestrator did not describe its sessions within N ms" — the honest outcome, and one that still lets `⌘Q`
 * proceed instead of failing.
 */
function connectSocket(url: string): SocketLike {
  const Client = socketClient();
  if (Client === undefined) return { on: () => undefined, close: () => undefined };
  const socket = new Client(url);
  return {
    on: (event: string, listener: (argument: never) => void) => {
      socket.on(event, listener);
    },
    close: () => socket.close(),
  };
}
