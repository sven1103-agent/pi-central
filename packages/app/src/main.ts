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
import { BrowserWindow, app } from "electron";
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
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "Pi Central",
    backgroundColor: "#0e1116",
    show: false,
    webPreferences: {
      // The window is a browser tab, and is kept equivalent to one. #215 asserts these properly; they
      // are set here so this slice cannot create a window that is already worse than the tab it replaces.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  return window;
}

/** Show a failure in whichever window exists, or in a fresh one. */
function showFailure(title: string, detail: string): void {
  const window = running?.window ?? createWindow();
  const html = renderFailure(title, detail);
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
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
