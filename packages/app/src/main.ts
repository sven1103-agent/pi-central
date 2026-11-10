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
import { BrowserWindow, Menu, app, dialog, nativeImage, shell } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  loginShellLookup,
  diagnoseLoginShellLookup,
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
  choiceIndex,
  connectionRefused,
  decideAttach,
  decideStop,
  probeCommand,
  readRuntimeRecord,
  rememberedMarks,
  removeRuntimeRecord,
  chooseAnswer,
  stopDialog,
  urlsFor,
  writeRuntimeRecord,
  type ProbeAnswer,
  type RuntimeRecord,
  type SessionSummary,
} from "./runtime-record.ts";
import { askLiveSessions, type SocketLike } from "./live-sessions.ts";
import { openLogWriter, teeConsole } from "./app-log.ts";
import { dockIconCandidates } from "./app-icon.ts";
import { describeLaunch, shellSourceRoot } from "./launch-origin.ts";
import {
  INSTALL_TIMEOUT_MS,
  STOP_HARD_DEADLINE_MS,
  STOP_TERM_GRACE_MS,
  UPDATE_PHASES,
  assessAvailableVersion,
  childIsDown,
  chooseUpdateAnswer,
  crashRecovery,
  installCommand,
  latestVersionCommand,
  parseLatestVersion,
  updateDialog,
  updateFailurePage,
  type UpdatePhase,
} from "./update-decide.ts";
import { applyUpdate, checkLatestVersion, type CommandResult, type UpdateEnvironment } from "./updater.ts";
import { decideOwner, findBrew, maySelfUpdate, npmBesideNode, ownerRefusal, readOwnerEvidence } from "./installation-owner.ts";
import { updateNotice, wantsRetry, type UpdateNotice } from "./update-notice.ts";

/**
 * The name macOS shows, and therefore the directory the runtime record lives in.
 *
 * Set before `app.getPath("userData")` is first read, which is why it is here rather than in `whenReady`: without
 * it Electron derives the data directory from the package name (`@pi-central/app`), and `~/Library/Application
 * Support/Pi Central` — the path this slice names — would be somewhere else.
 */
/*
 * A development run is a DIFFERENT app, and it must be impossible for it to touch the installed one.
 *
 * ## The collision this prevents, measured twice
 *
 * Two destructive collisions happened while building this shell, both from a shared identity:
 *
 *   1. `npm run install-app` deleted a Safari PWA, because both target `~/Applications/Pi Central.app`.
 *   2. `npm run app` shares `userData` with the installed app, so a dev run reads and **removes** the stable
 *      installation's `runtime.json` on quit — and can adopt (or be adopted by) its orchestrator. Two builds of one
 *      product, one lock, and no way to tell which is on screen.
 *
 * ## What is isolated, and what is deliberately shared
 *
 * `PI_CENTRAL_DEV=1` (set by `npm run app`) changes the app's NAME, which is what `app.getPath("userData")` derives
 * from — so the record, the update journal and the window title are the dev run's alone. It also points
 * `PI_CENTRAL_STATE` and `PI_CENTRAL_WORKSPACE` at a separate tree, so the policy fragments, the managed agent root and
 * any scratch session cannot land in the stable installation's directories.
 *
 * What stays SHARED is the reader's own Pi installation (`~/.pi`) and their agent root (`~/.agent`): a dev build must
 * test the real thing, and `resolveAgentRoot` treats `~/.agent` as external and read-only, so pointing the state root
 * elsewhere does not create a second credential store. Copying those would make the dev app test a fiction.
 *
 * This must run before any `getPath("userData")`, which is why it is here rather than in `whenReady`.
 */
/*
 * Diagnostics go to a file as well as to the console (issue #218, reported from use).
 *
 * The installed app is launched from Finder, where `stdout` is attached to nothing — so every `console.log` was written
 * into the void. When the reader reported "⌘Q leaves the window open for ever", the line that named the cause
 * (`the orchestrator did not stop within 5000 ms; quitting anyway`) had been written several times, and was unreadable.
 *
 * Asking a reader to launch the `.app` from a shell to see it is asking them to reproduce a DIFFERENT launch path: a
 * Finder launch has launchd's environment, not their shell's, and that difference produced three separate bugs in this
 * increment. So the log is a file, and the app can reveal it.
 *
 * Installed before `setName` because the path is derived from the app's name — and before anything else that might log.
 */
const logWriter = openLogWriter(app.getPath("logs"));
if (logWriter !== undefined) teeConsole(console, logWriter.write);

const development = process.env["PI_CENTRAL_DEV"] === "1";
if (development) {
  /*
   * A distinct name, and therefore a distinct `userData` directory. `Pi Central (dev)` also gives the window a title
   * that cannot be mistaken for the installed app's — the other half of "no way to tell which is on screen".
   */
  app.setName("Pi Central (dev)");
  /*
   * The orchestrator's state, redirected unless the caller already chose one.
   *
   * NOT the workspace: scratch sessions in a separate tree would be a dev-only fiction that behaves differently from the
   * product, and they are already per-session directories under the reader's own home.
   */
  if (process.env["PI_CENTRAL_STATE"] === undefined) {
    process.env["PI_CENTRAL_STATE"] = join(app.getPath("appData"), "pi-central-dev");
  }
  console.log(`Pi Central: development run — state is ${process.env["PI_CENTRAL_STATE"]}, userData is ${app.getPath("userData")}`);
} else {
  app.setName("Pi Central");
}

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

/**
 * Whether the quit has already asked the orchestrator to stop.
 *
 * Read by `before-quit`, which `app.quit()` re-enters: without it the stop is re-attempted on every pass, against a
 * process that has already exited, and the quit never finishes.
 */
let stopRequested = false;

/** How long a stopped orchestrator is given to exit before the app stops waiting for it. */
const STOP_GRACE_MS = 5000;

/** Set while a launch is being decided, so a double `Try again` cannot run two decisions at once. */
let launching = false;

/**
 * Resolvers waiting for the next spawn to announce a port (issue #217).
 *
 * `spawnOrchestrator` returns a promise, and this is how `onAnnounced` — which is called from a stream listener and
 * so cannot return a value — hands it the number. A list rather than a single slot because a restart can be in
 * flight while an update waits; each waiter is resolved with whatever this child reported.
 */
const announceResolvers: ((port: number | undefined) => void)[] = [];

/** The phase of an update in progress, or `idle`. Only one update may be in flight at a time. */
let updatePhase: UpdatePhase = "idle";

/** Set while an update is running, so a second menu invocation cannot start a second install. */
let updating = false;

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
    // The diagnosis is what turns "the login shell did not report it either" into a sentence that names the cause.
    diagnoseLoginShell: diagnoseLoginShellLookup,
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

/**
 * Spawn a fresh orchestrator, watch it, and load what it announces.
 *
 * Returns the port it announced, so the update path (#217, criterion 7) can prove the respawned child is a NEW
 * process rather than the old URL wearing a new label. Resolves with `undefined` when the child never announces —
 * the failure page has already been shown by then, and the update path treats it as a failed respawn.
 */
function spawnOrchestrator(pkg: PackageRoot, environment: Environment): Promise<number | undefined> {
  /*
   * Say which package is being served, before spawning it (issue #244).
   *
   * Reported from use: "when i run install app, i still see the older UI state". Correct and by design — the shell
   * launches the installed npm package (ADR-0013), so a locally built app shows whatever `npm install -g` last put on
   * disk. The trap is that nothing said so, and an unreleased checkout usually carries the SAME version number as the
   * last release, so the two are indistinguishable from the UI.
   *
   * `shellSourceRoot` is only defined for a run from a checkout, so an installed app stays quiet: serving the installed
   * package is the normal case, not a warning.
   */
  const origin = describeLaunch({
    packageRoot: pkg.root,
    shellSourceRoot: shellSourceRoot(process.argv[1]),
    overridden: process.env["PI_CENTRAL_PACKAGE"] !== undefined && process.env["PI_CENTRAL_PACKAGE"] !== "",
  });
  console.log(origin.message);
  if (origin.caveat !== undefined) console.warn(`Pi Central: ${origin.caveat}`);

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
  /** Resolved when this child announces a port. The update path needs the number, not just the URL. */
  const announcedPortPromise = new Promise<number | undefined>((resolve) => {
    announceResolvers.push(resolve);
  });
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
      const announcedPort = Number.parseInt(new URL(parsed.httpUrl).port, 10);
      for (const resolve of announceResolvers.splice(0)) resolve(announcedPort);
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
    /*
     * `running` is cleared FIRST, before the `quitting` early-return (issue #218, reported as: `⌘Q` leaves the window
     * open for ever showing `disconnected`).
     *
     * This line used to sit below the `if (quitting) return;`, so a child stopped BY the quit was never removed from
     * `running`. `stopOrchestratorForQuit` then saw an orchestrator on the next pass, waited on an `exit` event that had
     * already fired, timed out after STOP_GRACE_MS, and called `app.quit()` again — a loop every five seconds that never
     * ended, with the window left on screen because `before-quit` kept calling `preventDefault`.
     *
     * "A child that has exited is not running" is true regardless of why it exited, so it is set before any branch
     * decides what the exit MEANS.
     */
    running = undefined;
    /*
     * A quit is not a crash. This guard stays, AFTER the clear above: it is what stops the supervisor from restarting a
     * child the reader asked to stop, and it is the reason `running` had to move — the two facts are independent.
     */
    if (quitting) return;
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

  /*
   * A child that exits without announcing resolves the promise with `undefined`: the update path must not wait for a
   * port that is never coming, and `assessRespawnedPort` treats it as a failed respawn.
   */
  child.on("exit", () => {
    for (const resolve of announceResolvers.splice(0)) resolve(undefined);
  });

  return announcedPortPromise;
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

// -----------------------------------------------------------------------------------------------------------
// Applying an update (issue #217, ADR-0011 §4).
//
// The decisions live in `update-decide.ts` and the sequence in `updater.ts`; both are tested with no Electron. What is
// here is only the wiring: real subprocesses, the real stop, the real spawn, and the two menu items.
// -----------------------------------------------------------------------------------------------------------

/**
 * How this installation is managed, and therefore whether this app may replace it (issue #217).
 *
 * Probed from the filesystem, not inferred from the version: `npm prefix -g` is `/opt/homebrew` on a Homebrew Node, the
 * package may be a symlink, and the target directory may not be writable — all measured (see `installation-owner.ts`).
 * The `node` used is the one this app already resolved, so `npm` is taken from ITS directory rather than from a login
 * shell that may find a version manager's copy and install into a different prefix.
 */
function installationOwner(): { mayUpdate: boolean; refusal: string; owner: string } {
  const located = locatePackage();
  if (!located.ok) {
    return { mayUpdate: false, refusal: located.message, owner: "undetermined" };
  }
  const environment = resolveEnvironment({ env: process.env, shell: userShell(), runLoginShell: loginShellLookup, diagnoseLoginShell: diagnoseLoginShellLookup });
  const evidence = readOwnerEvidence({
    packageRoot: located.package.root,
    nodePath: environment.ok ? environment.environment.node.path : undefined,
    npmPrefix: readNpmGlobalPrefix(environment.ok ? environment.environment.node.path : undefined),
    env: process.env,
    lstat: (path) => lstatSync(path),
    readlink: (path) => readlinkSync(path),
    isWritable: (path) => isWritableDirectory(path),
    // `brew` is a secondary signal; the Cellar and keg path checks do not need it, which matters because a GUI launch
    // has no `brew` on PATH.
    findBrewFormula: (root) => (isHomebrewNamed(root) ? PACKAGE_NAME_FOR_BREW : undefined),
  });
  const owner = decideOwner(evidence);
  const refusal = ownerRefusal(owner);
  if (maySelfUpdate(owner)) return { mayUpdate: true, refusal: "", owner: owner.kind };
  console.log(`Pi Central: this installation is not self-updatable — ${owner.reason}`);
  return { mayUpdate: false, refusal: refusal.message, owner: refusal.kind };
}

/** The npm package's name, for the `brew` formula lookup. A formula would carry the same name in practice. */
const PACKAGE_NAME_FOR_BREW = "pi-central";

/** Whether `brew` knows a formula whose name matches the package root's directory. Cheap and failure-tolerant. */
function isHomebrewNamed(root: string): boolean {
  const brew = findBrew(process.env, (path) => existsSync(path));
  if (brew === undefined) return false;
  const name = root.split("/").filter((part) => part !== "").at(-1) ?? "";
  if (name === "") return false;
  const probe = spawnSync(brew, ["list", "--formula", name], { encoding: "utf8", timeout: 4000 });
  return probe.status === 0;
}

/** `npm prefix -g`, read through the npm beside the node this app launches. */
function readNpmGlobalPrefix(nodePath: string | undefined): string | undefined {
  const npm = npmBesideNode(nodePath);
  if (npm === undefined) return undefined;
  const probe = spawnSync(npm.path, ["prefix", "-g"], { encoding: "utf8", timeout: 8000 });
  if (probe.status !== 0) return undefined;
  const prefix = probe.stdout.trim();
  return prefix === "" ? undefined : prefix;
}

/** Whether this user can write to a directory. `undefined` when it cannot be determined, which refuses the update. */
function isWritableDirectory(path: string): boolean | undefined {
  try {
    // `fs.accessSync` is the honest test: it asks the OS whether THIS user may create a file, which is the question.
    accessSync(path, constants.W_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return false;
  }
}

/** Where the update journal lives: beside `runtime.json`, in the app's own data directory (never the Pi tree). */
function updateJournalPath(): string {
  return join(app.getPath("userData"), "update-state.json");
}

/**
 * Persist the update phase.
 *
 * Written for the same reason `runtime.json` is: an update spans a window in which the app can die with no child
 * running, and the one interval that matters is **after** the install verified and **before** a child is back — the
 * package on disk is the new version while the sessions that were open are not yet running. `crashRecovery` reads this
 * to decide whether the next launch must ignore `runtime.json` and start a new process.
 *
 * Failures are reported, not thrown: a journal that cannot be written costs the crash-recovery hint, not the update.
 */
function persistUpdatePhase(phase: UpdatePhase, installed: boolean): void {
  updatePhase = phase;
  const path = updateJournalPath();
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ phase, installed, at: Date.now() }, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    console.error(`Pi Central: could not record the update phase: ${(error as Error).message}`);
  }
}

/** Read the journal, tolerating absence and corruption — both mean "no update was in progress". */
function readUpdateJournal(): { phase: UpdatePhase; installed: boolean } {
  try {
    const parsed = JSON.parse(readFileSync(updateJournalPath(), "utf8")) as { phase?: unknown; installed?: unknown };
    const phase = (UPDATE_PHASES as readonly string[]).includes(String(parsed.phase)) ? (parsed.phase as UpdatePhase) : "idle";
    return { phase, installed: parsed.installed === true };
  } catch {
    return { phase: "idle", installed: false };
  }
}

/** Clear the journal, after a completed update or a failure that left things consistent. */
function clearUpdateJournal(): void {
  updatePhase = "idle";
  try {
    rmSync(updateJournalPath(), { force: true });
  } catch {
    // A journal left behind reads as "an update was in progress"; `crashRecovery` then starts the installed version,
    // which is the same thing it would do anyway.
  }
}

/**
 * Run one command to completion and collect its output.
 *
 * `stdio` is piped and both streams are kept, because `npm` prints its diagnosis on stderr and the failure page
 * shows it verbatim. The timeout is a bound on the whole call, so a wedged npm cannot leave the app in
 * `installing` for ever.
 *
 * No `env` is passed: npm inherits this process's environment, which is the behaviour a reader expects from a shell
 * command, and injecting one is how the update path would become a way to hand the app's environment somewhere
 * (C11's rule, one level out).
 */
function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = keepTail(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = keepTail(stderr, chunk);
    });
    const timer = setTimeout(() => {
      // The timeout is a `SIGKILL`: `npm` has no useful partial state to flush, and a `SIGTERM` it ignores would leave
      // the app waiting on the thing this is meant to bound.
      child.kill("SIGKILL");
      finish({ code: null, signal: "SIGKILL", stdout, stderr: `${stderr}\n(timed out after ${timeoutMs} ms)` });
    }, timeoutMs);
    child.on("error", (error) => finish({ code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}` }));
    child.on("exit", (code, signal) => finish({ code, signal, stdout, stderr }));
  });
}

/** Stop the running orchestrator: `SIGTERM`, then `SIGKILL` after the grace period (criterion 5). */
async function stopForUpdate(): Promise<Awaited<ReturnType<UpdateEnvironment["stopChild"]>>> {
  const current = running;
  if (current === undefined) return { stopped: true, signal: "SIGTERM", waitedMs: 0 };
  const started = Date.now();
  const exited = new Promise<void>((resolveExit) => {
    if (current.child === undefined) {
      // An adopted orchestrator has no handle, so its disappearance is observed through the probe (C16).
      const deadline = Date.now() + STOP_HARD_DEADLINE_MS;
      const poll = (): void => {
        if (probeProcess(current.pid).status === "absent" || Date.now() >= deadline) {
          resolveExit();
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
      return;
    }
    current.child.once("exit", () => resolveExit());
  });

  current.child?.kill("SIGTERM");
  if (current.child === undefined) {
    try {
      process.kill(current.pid, "SIGTERM");
    } catch (error) {
      return { stopped: false, reason: `could not signal it: ${(error as Error).message}` };
    }
  }

  const escalated = await Promise.race([
    exited.then(() => "exited" as const),
    new Promise<"grace">((resolveGrace) => setTimeout(() => resolveGrace("grace"), STOP_TERM_GRACE_MS)),
  ]);
  if (escalated === "exited") return { stopped: true, signal: "SIGTERM", waitedMs: Date.now() - started };

  // `SIGKILL`, on the group when there is one, because a session is a process tree.
  if (current.child !== undefined) {
    try {
      process.kill(-current.pid, "SIGKILL");
    } catch {
      current.child.kill("SIGKILL");
    }
  } else {
    try {
      process.kill(current.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  const hardDeadline = Date.now() + (STOP_HARD_DEADLINE_MS - STOP_TERM_GRACE_MS);
  while (Date.now() < hardDeadline) {
    if (probeProcess(current.pid).status === "absent") {
      return { stopped: true, signal: "SIGKILL", waitedMs: Date.now() - started };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  /*
   * Still there. Whether the probe could answer at all is the difference between "it survived SIGKILL" and "this host
   * will not tell me" (C16), and both must refuse the update — installing over a process that may be alive is the one
   * thing criterion 5 forbids.
   */
  return { stopped: false, reason: `it was still there ${STOP_HARD_DEADLINE_MS} ms after SIGTERM and SIGKILL` };
}

/** The real `UpdateEnvironment`, wired to this app's processes and files. */
function updateEnvironment(): UpdateEnvironment {
  return {
    readLatestVersion: () => {
      const { command, args } = latestVersionCommand();
      const environment = resolveEnvironment({ env: process.env, shell: userShell(), runLoginShell: loginShellLookup, diagnoseLoginShell: diagnoseLoginShellLookup });
      const npm = npmBesideNode(environment.ok ? environment.environment.node.path : undefined);
      return runCommand(npm?.path ?? command, args, 30_000);
    },
    runInstall: (version) => {
      const { command, args } = installCommand(version);
      /*
       * The npm beside the node this app launches, not whatever `PATH` finds.
       *
       * Measured: `/opt/homebrew/bin/npm` is a symlink into the same Cellar directory the resolved `node` comes from,
       * and with a version manager in play the two can differ — a login shell's `npm` would install into a prefix
       * belonging to a Node this app is not running, and the verification would then read the wrong tree.
       */
      const environment = resolveEnvironment({ env: process.env, shell: userShell(), runLoginShell: loginShellLookup, diagnoseLoginShell: diagnoseLoginShellLookup });
      const npm = npmBesideNode(environment.ok ? environment.environment.node.path : undefined);
      return runCommand(npm?.path ?? command, args, INSTALL_TIMEOUT_MS);
    },
    readInstalledVersion: async () => {
      // Read back from the artifact, never from npm's output: the manifest is what the next launch will run.
      const located = locatePackage();
      return located.ok ? located.package.version : undefined;
    },
    readCurrentVersion: async () => {
      // Criterion 2: the version of the package this app launches, resolved the same way the spawn resolves it.
      const located = locatePackage();
      return located.ok ? located.package.version : "unknown";
    },
    stopChild: () => stopForUpdate(),
    respawn: async (forceNew) => {
      /*
       * `forceNew` is already expressed by having stopped the child: the adoption path (#216) cannot reach a dead PID.
       * What it rules out is the *record* naming the old process, which `removeRuntimeRecord` does before a respawn that
       * follows an install — otherwise the next launch would adopt a PID whose code has been replaced.
       */
      if (forceNew) removeRuntimeRecord(app.getPath("userData"));
      running = undefined;
      announcedPort = undefined;
      const located = locatePackage();
      if (!located.ok) throw new Error(located.message);
      const environment = resolveEnvironment({ env: process.env, shell: userShell(), runLoginShell: loginShellLookup, diagnoseLoginShell: diagnoseLoginShellLookup });
      if (!environment.ok) throw new Error(missingDetail(environment.missing));
      const port = await spawnOrchestrator(located.package, environment.environment);
      if (port === undefined) throw new Error("the new orchestrator did not report a port");
      return { port };
    },
    onPhase: (phase, detail) => {
      console.log(`Pi Central: update ${phase} — ${detail}`);
    },
    persistPhase: (phase, installed) => persistUpdatePhase(phase, installed),
  };
}

/**
 * Menu → Check for Updates…: asks npm what `latest` is, and installs nothing (criterion 1).
 *
 * Its own action, because ADR-0011 §4 separates detection from application. When a newer version exists the reader is
 * offered the update here — the same dialog `applyUpdateFromMenu` would show — so the two menu items differ only in
 * whether they look first.
 */
async function checkForUpdateFromMenu(): Promise<void> {
  if (updating) return;
  updating = true;
  try {
    /*
     * Checking is offered even when the installation is managed elsewhere — the reader is entitled to know a newer
     * version exists, and the refusal names the command that installs it. Only APPLYING is gated.
     */
    const check = await checkLatestVersion(updateEnvironment());
    console.log(`Pi Central: ${check.verdict.action === "install" ? check.verdict.reason : check.verdict.reason}`);
    if (check.verdict.action !== "install") {
      const notice = updateNotice(check.verdict.kind === "up-to-date" ? "up-to-date" : "nothing-to-apply", {
        runningVersion: check.current,
        ...(check.verdict.kind === "up-to-date" ? {} : { detail: check.verdict.reason }),
      });
      await showNotice(notice);
      return;
    }
    /*
     * A newer version exists. The reader is told what it is and offered the update — the same confirmation
     * `applyUpdateFromMenu` shows — rather than being dropped straight into an install from a "check" action.
     *
     * `updating` is released BEFORE the handoff, because `applyUpdateFromMenu` refuses while an update is already in
     * flight: leaving it set here made "check found a newer version" silently do nothing at all — no dialog, no error,
     * just a check that appeared to succeed.
     */
    updating = false;
    await applyUpdateFromMenu(check.verdict.version);
  } catch (error) {
    /*
     * A failed CHECK is a notice, not a failure page: nothing was changed, the dashboard is fine, and the reader must be
     * able to go on using the app. This was one of the paths that replaced the window and left no way back.
     */
    await showNotice(updateNotice("check-failed", { detail: (error as Error).message }));
  } finally {
    updating = false;
  }
}

/**
 * Menu → Update Pi Central…: stop, install, verify, respawn (the choreography #56 needed).
 *
 * The confirmation names the live sessions first, and **Cancel** installs nothing (criterion 4). That list is the
 * orchestrator's own, asked the same way `⌘Q` asks (#216).
 */
async function applyUpdateFromMenu(knownVersion?: string): Promise<void> {
  if (updating) return;
  updating = true;
  try {
    /*
     * Who owns this installation, BEFORE anything is stopped (issue #217).
     *
     * An npm install is only correct for an npm global install under a writable prefix. Homebrew, a version manager, a
     * linked working copy or a read-only prefix all mean the same thing here: this app must not replace it, and the
     * failure names the command that does. Refusing first also means a reader whose install is managed elsewhere loses
     * nothing by asking — no child is stopped, no session restarted.
     */
    const ownership = installationOwner();
    if (!ownership.mayUpdate) {
      await showNotice(
        updateNotice("managed-elsewhere", {
          runningVersion: readRunningVersion(),
          detail: ownership.refusal,
        }),
      );
      return;
    }

    const env = updateEnvironment();
    const from = await env.readCurrentVersion();
    let to = knownVersion;
    if (to === undefined) {
      const latest = await env.readLatestVersion();
      const verdict = assessAvailableVersion(from, parseLatestVersion(latest.stdout) ?? latest.stdout);
      if (verdict.action === "refuse") {
        await showNotice(updateNotice("nothing-to-apply", { runningVersion: from, detail: verdict.reason }));
        return;
      }
      to = verdict.version;
    }

    const current = running;
    const answer = current === undefined ? { sessions: [], note: undefined } : await askLiveSessions(connectSocket, current.url);
    if (answer.note !== undefined) console.error(`Pi Central: ${answer.note}`);
    const { response } = await dialog.showMessageBox(
      updateDialog(from, to, answer.sessions.map((session) => ({ name: session.name, cwd: session.cwd }))),
    );
    if (chooseUpdateAnswer(response) === "cancel") {
      console.log("Pi Central: update cancelled; nothing was stopped and nothing was installed");
      return;
    }

    const result = await applyUpdate(env, {
      hasChild: current !== undefined,
      previous: current === undefined ? undefined : { port: Number.parseInt(new URL(current.httpUrl).port, 10), spawnedByUs: current.child !== undefined },
    });

    if (result.ok) {
      clearUpdateJournal();
      console.log(`Pi Central: updated ${result.from} → ${result.to} (pid ${running?.pid ?? "?"}, port ${result.port})`);
      const target = window;
      if (target !== undefined && !target.isDestroyed()) target.reload();
      return;
    }

    // A failure that left the previous version running is consistent, so the journal is cleared; one that left the disk
    // in an unknown state keeps it, so the next launch does not adopt a process whose code was replaced.
    if (result.failure.kind !== "version-mismatch") clearUpdateJournal();
    /*
     * The failure is a NOTICE, not a failure page (issue #217).
     *
     * `showFailure` replaces the window's document and its only control restarts the orchestrator — which is alive, so the
     * button does nothing and the dashboard is unreachable. A failed update leaves a working app, so it gets a dialog that
     * closes back onto it. `updateFailurePage` still supplies the wording; the surface is what changed.
     */
    const page = updateFailurePage(result.failure, result.runningVersion);
    const notice = updateNotice("failed", {
      runningVersion: result.runningVersion,
      detail: `${page.title}\n\n${page.detail}`,
      // A retry is offered only when nothing was replaced, because re-running npm over a half-installed package is a
      // different and worse operation than re-running it over an untouched one.
      canRetry: result.failure.kind !== "version-mismatch",
    });
    const retryResponse = await showNotice(notice);
    if (wantsRetry(notice, retryResponse)) {
      console.log("Pi Central: retrying the update");
      // Outside this `finally`, because `updating` is still true here and the retry would refuse itself.
      setTimeout(() => void applyUpdateFromMenu(), 0);
    }
  } finally {
    updating = false;
  }
}

/** The version this app is running, for a notice. Never throws: "unknown" is a reportable answer. */
function readRunningVersion(): string {
  const located = locatePackage();
  return located.ok ? located.package.version : "unknown";
}

/**
 * Show an update outcome, and return which button was pressed.
 *
 * ## Why this is not `showFailure`
 *
 * `showFailure` replaces the window's document with a diagnostic page whose only control is *Try again* → `retry()`,
 * which restarts the **orchestrator**. On the update path the orchestrator is alive, so that button refuses and the
 * dashboard is gone — the dead end reported from a running app. An update outcome belongs in a dialog that closes back
 * onto the dashboard, which is what this is.
 *
 * Errors are swallowed into a log line: a dialog that cannot be shown must not fail the action that produced it, and the
 * terminal already has the outcome.
 */
async function showNotice(notice: UpdateNotice): Promise<number> {
  try {
    const { response } = await dialog.showMessageBox(notice);
    return response;
  } catch (error) {
    console.error(`Pi Central: could not show a dialog (${(error as Error).message}): ${notice.message}`);
    return notice.defaultId;
  }
}

/**
 * Open the log in Console.app, filtered to it.
 *
 * `open -a Console <path>` is the one command that gets a reader to a live, scrollable view of the file — which is what
 * makes "paste me the log" a request they can satisfy. Falls back to revealing the file when Console is unavailable,
 * because a diagnostic path that fails silently is the problem this whole module exists to fix.
 */
function revealLog(): void {
  if (logWriter === undefined) return;
  try {
    // `Console` accepts a file argument and selects it; a failure here is not worth a dialog.
    shell.openPath(logWriter.path).catch(() => revealLogFile());
  } catch {
    revealLogFile();
  }
}

/** Show the log file in Finder, so it can be attached to an issue or dragged into a mail. */
function revealLogFile(): void {
  if (logWriter === undefined) return;
  try {
    shell.showItemInFolder(logWriter.path);
  } catch (error) {
    console.error(`Pi Central: could not reveal ${logWriter.path}: ${(error as Error).message}`);
  }
}

/**
 * Put Pi Central's icon on the dock, so a development run does not advertise Electron's (issue #239).
 *
 * Silently does nothing when the bundle is authoritative (a packaged launch) or when the master PNG is not there, which is
 * a checkout that has never run `npm run build:icon`. A missing dev icon is a cosmetic regression in a dev session; failing
 * the launch over it would make the app unusable for exactly the reader who is about to fix it. The log line is there so
 * "the dock still shows Electron" has an answer other than "works here".
 *
 * `dock` is undefined off macOS, and this app is macOS-only (C10) — but the guard is kept because a test imports this
 * module's siblings under Node, where `app.dock` is a stub at best.
 */
function applyDockIcon(): void {
  const candidates = dockIconCandidates({ packaged: app.isPackaged, entryPath: process.argv[1] });
  if (candidates.length === 0) return;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    // An EMPTY image is the failure `nativeImage` reports for a format it cannot decode (an `.icns`, for instance), and
    // `setIcon` with one leaves the dock tile blank — worse than the wrong icon, because it reads as a crash.
    if (image.isEmpty()) {
      console.warn(`Pi Central: ${candidate} is not an image Electron can decode, so the dock icon is unchanged`);
      continue;
    }
    app.dock?.setIcon(image);
    return;
  }
  console.warn(
    `Pi Central: no app icon found (looked in ${candidates.join(", ")}), so the dock shows Electron's — ` +
      "run npm run build:icon",
  );
}

/**
 * What the About panel says, and with which mark (issue #239).
 *
 * `role: "about"` shows the panel, but everything in it is Electron's default when the app has not said otherwise: the
 * framework's icon, and — in a checkout run — Electron's own version. That is one more surface advertising "Electron" for a
 * product called Pi Central, and it is the one a reader opens to answer *"which version am I actually running?"*.
 *
 * The version comes from the package the shell launches, which is the same source every other version statement in this app
 * uses (`readRunningVersion`). `applicationVersion` rather than `version`: the former is the short version macOS shows,
 * the latter is the build number.
 *
 * `credits` is where the honest sentence goes, because the About panel is the one place a reader looks for "what is this":
 * it names the package the shell launches, so the desktop app and the npm artifact cannot be mistaken for two products.
 */
function applyAboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: readRunningVersion(),
    credits: "Pi Central runs the package you installed with npm, in a window of its own.",
    copyright: "MIT licensed.",
  });
}

/** The menu, which is the only way to reach the update path (criterion 1). */
function buildMenu(): void {
  const template = [
    {
      // The app menu, which macOS requires to be first and to contain Quit — so `⌘Q` keeps working (#216).
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Check for Updates…", click: () => void checkForUpdateFromMenu() },
        { label: "Update Pi Central…", click: () => void applyUpdateFromMenu() },
        { type: "separator" },
        /*
         * The log, one click away. A path in a document is a path nobody finds, and this is the surface that answers
         * "what did it actually do?" for every failure the app can report.
         */
        { label: "Open Log in Console…", click: () => revealLog(), enabled: logWriter !== undefined },
        { label: "Reveal Log in Finder", click: () => revealLogFile(), enabled: logWriter !== undefined },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        // `role: "quit"` is what makes this `⌘Q` and what routes it through `before-quit`, which is the whole of #216.
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template as unknown as Parameters<typeof Menu.buildFromTemplate>[0]));
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
    /*
     * The dock icon, for a development run (issue #239).
     *
     * A packaged launch gets it from the bundle's own `icon.icns`, which macOS reads — so this is deliberately a no-op
     * there (`dockIconCandidates` returns nothing when packaged). What it fixes is `npm run app`: that starts the Electron
     * binary out of `node_modules`, whose bundle icon is Electron's, so the dock showed Electron's logo while a reader was
     * looking straight at Pi Central's window.
     */
    applyDockIcon();
    applyAboutPanel();
    // The menu is the only route to the update path (issue #217, criterion 1). Built once, before the first launch, so
    // a reader can reach it even when the orchestrator failed to start.
    buildMenu();
    /*
     * An update interrupted by a crash (issue #217). `crashRecovery` decides whether the next launch must ignore the
     * runtime record — because the recorded process is the OLD version executing files that have been replaced — and
     * the journal is cleared either way, since this launch is the recovery.
     */
    const journal = readUpdateJournal();
    if (journal.phase !== "idle") {
      const recovery = crashRecovery({
        phase: journal.phase,
        previous: undefined,
        installed: journal.installed,
      });
      console.log(`Pi Central: ${recovery.reason}`);
      if (recovery.forceNew) removeRuntimeRecord(app.getPath("userData"));
      clearUpdateJournal();
    }
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
      /*
       * The stop is performed AT MOST ONCE (issue #218).
       *
       * Each `app.quit()` re-enters this handler, so a handler that stops "whatever is running" on every pass will try
       * to stop an already-dead process, wait for an `exit` that already happened, and call `app.quit()` again — for
       * ever. `stopRequested` makes the second and later passes fall straight through and let the quit complete.
       */
      if (stopRequested) return;
      const stopped = stopOrchestratorForQuit();
      stopRequested = true;
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

  const choice = chooseAnswer(await showStopQuestion(decision.sessions));

  if (choice === "cancel") {
    // The app stays open, and a later `⌘Q` must ask again — so the gate is reset rather than left set.
    quitting = false;
    stopRequested = false;
    console.log("Pi Central: quit cancelled; nothing was stopped");
    return;
  }
  /*
   * `detach` and `stop` differ in exactly one place: whether the child is signalled. That difference is carried by
   * `quitDecided`'s companion field rather than by two code paths, so "keep sessions running" cannot accidentally
   * inherit the stop that the other branch performs.
   */
  detachOnQuit = choice === "detach";
  quitting = true;
  quitDecided = true;
  app.quit();
}

/**
 * Ask the question, and return the index of the answer.
 *
 * The dialog's contents — buttons, order, default, `cancelId`, both sentences — come from `stopDialog`, so they are
 * asserted by `runtime-record.test.ts` rather than existing only inside a click. This function is the part that cannot be
 * tested without Electron: it hands the object over and reads the reply.
 */
async function showStopQuestion(sessions: readonly SessionSummary[]): Promise<number> {
  try {
    const { response } = await dialog.showMessageBox(stopDialog(sessions));
    return response;
  } catch (error) {
    /*
     * A dialog that cannot be shown must not stop sessions. Falling through to `Keep sessions running` is the safe
     * direction and the one `defaultId` already names; the alternative would be a quit that stops work because a window
     * could not be drawn.
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
  /*
   * A child that has already exited will never emit `exit` again, so waiting on it is waiting for ever (or until the
   * grace timer). This is the state the reported bug left the app in, and the guard costs one check.
   */
  if (child.exitCode !== null || child.signalCode !== null) return undefined;
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

/**
 * Resolve `ws`, in a CommonJS bundle that Electron loads from inside `app.asar`.
 *
 * ## Two failed fixes before this one, and what each taught
 *
 * **Attempt 1 — `createRequire(import.meta.url)`.** Correct in an ES module; in the bundle esbuild emits
 * `var import_meta = {}`, so `.url` is `undefined` and `createRequire(undefined)` throws. Silent, because the throw was
 * caught, and the only symptom was `⌘Q` reporting *"the orchestrator did not describe its sessions within 2000 ms"* —
 * which blames the orchestrator for a client fault.
 *
 * **Attempt 2 — `globalThis.require`.** Also wrong, and less obvious: `require` is a **module-scope binding**, not a
 * property of `globalThis`. Measured: in a plain `.cjs` file `typeof require === "function"` while
 * `typeof globalThis.require === "undefined"`. So that route could never fire, and the log said so again.
 *
 * **Attempt 3 — `createRequire` on the asar path.** Also wrong, and this is the one the real machine proved:
 * `createRequire("/…/Resources/app.asar/main.js")("ws")` fails with `ERR_INVALID_PACKAGE_CONFIG`, because **Node does not
 * know how to stat inside an asar** — only Electron's patched module loader does.
 *
 * ## What actually works
 *
 * `require("ws")` **as a bare call**, with `ws` marked `external` in the esbuild invocation. Three facts combine:
 *
 *   - esbuild leaves a bare `require("ws")` untouched when the module is external (verified: the output line is
 *     `return require("ws")`);
 *   - in CommonJS `require` is in scope for the bundle, so the call compiles and runs;
 *   - Electron patches `require` to read inside `app.asar`, which is where `node_modules/ws` sits beside `main.js`.
 *
 * The ESM path (`npm run app`, which runs the TypeScript directly) has no `require`, so `createRequire` anchored on
 * `process.argv[1]` covers it — a real path there, because an unbundled run is on the filesystem rather than in an asar.
 *
 * **The lesson worth keeping:** each attempt was plausible, each failed for a different and specific reason, and the only
 * way any of them was caught was by running the bundle. A source-level test cannot distinguish these.
 */
function resolveWs(): WebSocketConstructor | undefined {
  const accept = (loaded: unknown): WebSocketConstructor | undefined => {
    // The package exports the class; whether it arrives bare, as `default` or as `WebSocket` depends on how it is
    // reached, so all three are accepted rather than pinning one.
    const candidate =
      typeof loaded === "function"
        ? loaded
        : ((loaded as { WebSocket?: unknown } | null)?.WebSocket ?? (loaded as { default?: unknown } | null)?.default);
    return typeof candidate === "function" ? (candidate as WebSocketConstructor) : undefined;
  };

  /*
   * Route 1: the CommonJS `require`, which the bundle has.
   *
   * `require` is in scope in a CommonJS module, and `ws` is `external` in the build so this call is emitted verbatim.
   * Electron patches `require` to read inside `app.asar`, which is the only loader that can find the packaged copy.
   *
   * The `typeof` guard is written against an indirect reference so this file still typechecks and parses as an ES module
   * (where `require` does not exist) — the call is guarded, never evaluated eagerly.
   */
  const commonjsRequire = typeof require === "function" ? (require as (id: string) => unknown) : undefined;
  if (commonjsRequire !== undefined) {
    try {
      const accepted = accept(commonjsRequire("ws"));
      if (accepted !== undefined) return accepted;
    } catch {
      // Not resolvable from here; try the ESM route.
    }
  }

  /*
   * Route 2: an ES-module run (`npm run app`), where `require` does not exist. `process.argv[1]` is the entry script and
   * is a REAL path — unlike `import.meta.url`, it survives being bundled, and unlike the asar case there is no archive to
   * read through because an unbundled run is on the filesystem.
   */
  const entry = process.argv[1];
  if (entry !== undefined && entry !== "") {
    try {
      const accepted = accept(createRequire(entry)("ws"));
      if (accepted !== undefined) return accepted;
    } catch {
      // Try the working directory.
    }
  }

  // Route 3: last resort, resolve from where the app was started.
  try {
    const accepted = accept(createRequire(join(process.cwd(), "noop.js"))("ws"));
    if (accepted !== undefined) return accepted;
  } catch {
    // Nothing left to try.
  }
  return undefined;
}

function socketClient(): WebSocketConstructor | undefined {
  if (socketConstructor !== undefined) return socketConstructor;
  socketConstructor = resolveWs();
  if (socketConstructor === undefined) {
    /*
     * Logged once, and loudly, because the consequence is silent: `⌘Q` will wait its full timeout and report that the
     * orchestrator did not answer. Without this line, that message looks like the orchestrator's fault — which is exactly
     * how two wrong fixes survived.
     */
    console.error(
      "Pi Central: could not resolve `ws`, so asking the orchestrator which sessions are live will time out. " +
        "The quit dialog will not be able to name sessions.",
    );
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
  if (Client === undefined) {
    /*
     * No client. The socket accepts listeners and never speaks, which `askLiveSessions` reports as a timeout — and the
     * timeout is now explained by the log line in `socketClient` rather than looking like an unresponsive orchestrator.
     */
    return { on: () => undefined, close: () => undefined };
  }
  const socket = new Client(url);
  return {
    on: (event: string, listener: (argument: never) => void) => {
      socket.on(event, listener);
    },
    close: () => socket.close(),
  };
}
