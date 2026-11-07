/**
 * Finding `node`, `pi` and `safehouse` from a GUI launch (issue #214, criterion 2).
 *
 * ## The failure this exists for
 *
 * A macOS app launched from Finder or the dock inherits almost nothing. `PATH` is whatever launchd
 * gives a login session — typically `/usr/bin:/bin:/usr/sbin:/sbin` — so a Homebrew-installed
 * `safehouse` in `/opt/homebrew/bin` is **not on it**, and neither is a `node` installed by nvm,
 * asdf or Homebrew. The same commands work in the reader's terminal, where `.zprofile` has already
 * run. So the app either spawns something that does not exist or, worse, spawns an **older system
 * binary** that happens to be in `/usr/bin`.
 *
 * That asymmetry is what makes this worth a module rather than an `existsSync` check: the app must
 * reproduce the shell's view of the world, not its own.
 *
 * ## How
 *
 * `$SHELL -ilc 'command -v NAME'`. The `-i` is load-bearing and is not decoration: without it zsh
 * reads `.zshenv` but skips `.zprofile`, `.zshrc` and `.zlogin`, which is exactly where `nvm` and
 * Homebrew's `eval` live. `-l` alone would skip `.zshrc`, where most people's `PATH` is actually set.
 *
 * Costs and limits, stated because they are real:
 *
 *   - A login shell can be **slow** (0.2–2 s with a heavy `.zshrc`), so every answer is cached for
 *     the process lifetime. It is called once per name per launch, not per spawn.
 *   - The shell may **print to stderr** (a prompt framework, a plugin manager complaining). Only
 *     stdout's last non-empty line is taken, and a non-zero exit is treated as "not found".
 *   - A shell that hangs is bounded by a timeout, because an app that never opens a window while
 *     waiting for `.zshrc` is indistinguishable from one that crashed.
 *
 * ## What is not attempted
 *
 * No interactive prompt answering, no `PATH` rewriting for the whole process, and no attempt to read
 * `.zshrc` ourselves. The shell is the only thing that knows how the user set up their shell, so it is
 * asked — and if it cannot answer, the app says which binary is missing rather than guessing a path.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

/** How long a login shell gets to report one path. Generous, because a cold `.zshrc` is genuinely slow. */
export const LOGIN_SHELL_TIMEOUT_MS = 10_000;

export type LookupSource = "environment" | "login-shell";

export interface FoundExecutable {
  name: string;
  path: string;
  /** Where the answer came from, so the startup log can say how the app saw the machine. */
  source: LookupSource;
}

export interface MissingExecutable {
  name: string;
  /** What the reader should do about it. One sentence, naming the binary. */
  message: string;
}

export type ExecutableResult = { ok: true; executable: FoundExecutable } | { ok: false; missing: MissingExecutable };

/** The slice of `process.env` and the shell runner this module needs, injected so tests drive it. */
export interface LookupContext {
  env: NodeJS.ProcessEnv;
  /** `$SHELL`, or `undefined` when the app was launched without one. */
  shell: string | undefined;
  /** Run a login shell and return its stdout, or `undefined` if it could not run or timed out. */
  runLoginShell: (shell: string, command: string) => string | undefined;
}

/** Is this an absolute path to something that exists and is executable? */
function isExecutableFile(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * A `PATH` search, exactly as a shell would do it.
 *
 * Written out rather than delegating to `which`, because the child's `PATH` is the thing being
 * computed: asking a subprocess to resolve a name against a `PATH` that does not exist yet is circular.
 */
export function searchPath(
  name: string,
  path: string | undefined,
  options: { skipShims?: boolean } = {},
): string | undefined {
  if (path === undefined || path === "") return undefined;
  for (const directory of path.split(":")) {
    // Empty segments are skipped rather than resolved against the cwd. A shell treats a trailing colon
    // as `$PWD`, which is a convenience for an interactive user and a hazard for a spawned child.
    if (directory === "") continue;
    if (options.skipShims === true && isShimDirectory(directory)) continue;
    const candidate = `${directory}/${name}`;
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Ask a login shell where a command is.
 *
 * `command -v` rather than `which`: it is a shell builtin, so it works when `which` is absent, and it
 * reports a function or alias as well — which is how an `nvm`-managed `node` usually appears. A
 * multi-line answer is reduced to the last non-empty line, because a chatty `.zshrc` prints its
 * business to stdout before the command runs.
 */
export function loginShellLookup(shell: string, command: string): string | undefined {
  const result = spawnSync(shell, ["-ilc", `command -v ${command}`], {
    encoding: "utf8",
    timeout: LOGIN_SHELL_TIMEOUT_MS,
    // The shell reads the user's files, which may want a terminal; it does not get one, and that must
    // not turn into a hang. `spawnSync`'s timeout covers the stuck case.
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) return undefined;
  const lines = (result.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const last = lines.at(-1);
  return last === undefined || !isAbsolute(last) ? undefined : last;
}

/**
 * A `PATH` entry that must never be used to run an agent's tooling.
 *
 * `node_modules/.bin` is a **shim directory**: it holds symlinks npm creates for the dependencies of
 * whatever project owns it. Two things are wrong with exec'ing through it here:
 *
 *   1. It is a *project's* `node_modules`, so following it runs that project's pinned version of a tool
 *      rather than the one the reader installed globally — for `pi` that means the version vendored in
 *      Pi Central's own devDependencies, which is not the `pi` a session is meant to use.
 *   2. It is inside a directory a session is often **sandboxed away from**. Safehouse appends its own
 *      paths to the `PATH` it inherits, so a `node_modules/.bin` in the orchestrator's `PATH` reaches
 *      every session — which produced `env: .../node_modules/.bin/pi: Operation not permitted`
 *      (exit 126) for every session started from a launch that had npm's `PATH` prepended.
 *
 * The observed trigger is `npm run app`, which prepends the repo's `node_modules/.bin`. The lesson is
 * wider than that script: a developer's `PATH` and a session's `PATH` are different audiences.
 */
export function isShimDirectory(entry: string): boolean {
  return entry.endsWith("/node_modules/.bin") || entry === "node_modules/.bin";
}

/**
 * Resolve one executable: the inherited `PATH` first, then the login shell.
 *
 * The order matters and is not arbitrary. `PATH` first because it is free (no subprocess), and when it
 * succeeds the app's view already agrees with the shell's. The login shell second, because it is the
 * only thing that can answer when `PATH` is the truncated launchd one.
 *
 * Shim directories are skipped, and a name that only resolves to a shim **falls through to the login
 * shell** rather than being accepted: see {@link isShimDirectory}. That fall-through is what makes this
 * correct under `npm run`, where `node_modules/.bin` comes first and would otherwise win.
 */
export function resolveExecutable(
  name: string,
  context: LookupContext,
  hint: string,
): ExecutableResult {
  const fromPath = searchPath(name, context.env["PATH"], { skipShims: true });
  if (fromPath !== undefined) {
    return { ok: true, executable: { name, path: fromPath, source: "environment" } };
  }
  if (context.shell !== undefined && context.shell !== "") {
    const answered = context.runLoginShell(context.shell, name);
    if (answered !== undefined && isExecutableFile(answered)) {
      return { ok: true, executable: { name, path: answered, source: "login-shell" } };
    }
  }
  return {
    ok: false,
    missing: {
      name,
      // The sentence names the binary, both places it was looked, and what to do. A bare "failed to
      // spawn" is the thing this criterion forbids.
      message:
        `Pi Central could not find \`${name}\`. It is not on this app's PATH ` +
        `(${context.env["PATH"] ?? "which is empty"}) and the login shell did not report it either. ` +
        hint,
    },
  };
}

/** What each missing binary means, in the reader's terms. */
export const EXECUTABLE_HINTS = {
  node:
    "Pi Central runs on the Node you installed it with; install Node, or set PI_CENTRAL_NODE to its path.",
  pi: "Install Pi (see docs/AGENT-SETUP.md), or set PI_CENTRAL_PI to its path.",
  safehouse:
    "Agent Safehouse is required to sandbox sessions (docs/AGENT-SETUP.md). Install it, or start " +
    "with --direct for an unsandboxed session.",
} as const;

export interface Environment {
  node: FoundExecutable;
  pi: FoundExecutable;
  safehouse: FoundExecutable;
}

/** Which of the three could not be found. `partial` is what the others reported, for the log. */
export type EnvironmentResult =
  | { ok: true; environment: Environment }
  /** `partial` is what WAS found, so the failure panel can say how far it got. */
  | { ok: false; missing: MissingExecutable; partial: Partial<Environment> };

/**
 * Resolve the three executables the app needs before it can honestly open a window.
 *
 * One missing binary fails the whole resolution rather than starting and failing later: the failure it
 * prevents is a window that renders `disconnected` for a reason the reader cannot see. #54 is the
 * orchestrator-side version of this check; this is the one that has to happen before the orchestrator
 * exists.
 */
export function resolveEnvironment(context: LookupContext): EnvironmentResult {
  const found: Partial<Environment> = {};
  const node = resolveExecutable("node", context, EXECUTABLE_HINTS.node);
  if (!node.ok) return { ok: false, missing: node.missing, partial: found };
  found.node = node.executable;
  const pi = resolveExecutable("pi", context, EXECUTABLE_HINTS.pi);
  if (!pi.ok) return { ok: false, missing: pi.missing, partial: found };
  found.pi = pi.executable;
  const safehouse = resolveExecutable("safehouse", context, EXECUTABLE_HINTS.safehouse);
  if (!safehouse.ok) return { ok: false, missing: safehouse.missing, partial: found };
  return {
    ok: true,
    environment: { node: node.executable, pi: pi.executable, safehouse: safehouse.executable },
  };
}
