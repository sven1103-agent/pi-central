/**
 * Configuration and the app-owned default workspace (US-3, D-5).
 *
 * The whole point of US-3: "start without a path" must not silently default to `$HOME` or
 * the orchestrator's cwd, because the sandbox grants read/write to the directory it names.
 *
 * D-5 therefore constrains the location. The default workspace must NOT be inside:
 *
 *   - `$HOME` proper        safehouse's base profile grants parts of the home tree
 *   - `/tmp`, `/var/folders` safehouse grants these GLOBALLY (any session can read them)
 *   - `~/.pi`               granted read/write to every session (C6)
 *
 * A scratch directory under any of those would make its "isolation" a fiction: a second
 * session's policy would reach it regardless of the per-session workdir grant.
 *
 * `~/.local/share/pi-central/workspaces/` satisfies D-5: it is under `$HOME` as a path but
 * is not granted by any base profile, and it is not a tmp or agent dir.
 */
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface Config {
  /** Root under which one directory per scratch session is created. */
  workspaceRoot: string;
  /** Where Pi Central keeps its own state (Q7). Never inside ~/.pi. */
  stateRoot: string;
  /** Pi's session store; overridable for tests. */
  sessionsRoot: string;
  /** Safehouse binary. */
  safehouse: string;
  /** Pi binary. */
  pi: string;
  /**
   * The agent identity's credential root (ADR-0010).
   *
   * Holds `gh/` (GH_CONFIG_DIR), `gitconfig` (GIT_CONFIG_GLOBAL), and `ssh/`. Either owned by
   * Pi Central (`managed`) or by an external tree the user maintains (`external`), in which
   * case Pi Central reads and verifies but never writes.
   */
  agentRoot: string;
  /**
   * Where rendered policy fragments are written (ADR-0010 §2).
   *
   * Under the state root, so it is outside `~/.pi` (Q7) and outside every session's workdir.
   */
  fragmentDir: string;
  /**
   * Whether Pi Central owns `agentRoot`. When false, credentials are only ever read, and
   * re-import is an explicit action (ADR-0010 §5).
   */
  agentRootManaged: boolean;
}

export function defaultConfig(): Config {
  const home = homedir();
  const stateRoot = process.env.PI_CENTRAL_STATE ?? join(home, ".config", "pi-central");
  return {
    workspaceRoot:
      process.env.PI_CENTRAL_WORKSPACE ?? join(home, ".local", "share", "pi-central", "workspaces"),
    stateRoot,
    sessionsRoot: process.env.PI_SESSIONS_DIR ?? join(home, ".pi", "agent", "sessions"),
    safehouse: process.env.PI_CENTRAL_SAFEHOUSE ?? "safehouse",
    pi: process.env.PI_CENTRAL_PI ?? "pi",
    // An external tree is adopted by pointing this at it (e.g. the hardening project's
    // ~/.agent), which is what lets one installation be imported rather than duplicated.
    agentRoot: process.env.PI_CENTRAL_AGENT_ROOT ?? join(stateRoot, "agents", "default"),
    fragmentDir: join(stateRoot, "policy"),
    agentRootManaged: process.env.PI_CENTRAL_AGENT_ROOT === undefined,
  };
}

/**
 * Paths the default workspace must not live under (D-5).
 *
 * Two kinds, and conflating them is a bug:
 *
 *   - `exact`   — banned only when the root IS this path. `$HOME` is the case: defaulting
 *                 to `$HOME` itself is the mistake US-3 exists to prevent, but
 *                 `$HOME/.local/share/pi-central` is perfectly fine and is exactly the
 *                 recommended location.
 *   - `subpath` — banned when the root is this path or inside it, because the path is
 *                 recursively readable/writable.
 *
 * Note what is NOT a blanket subpath ban: `$HOME/.local/share`. Safehouse grants it only
 * as a *literal* (directory listing, for traversal) and says so itself:
 *
 *   ;; Intentionally avoid broad RW grants like ~/.cache, ~/Library/Caches,
 *   ;; ~/.local/share, ~/.local/state.
 *
 * The recursive grants that DO exist under `.local/share` are for specific tools (bun, go,
 * uv, gh, …) and are listed individually, because a workspace inside one of those would be
 * reachable by every other session.
 */
const LOCAL_SHARE_TOOLS = [
  "bun", "go", "uv", "gh", "glab-cli", "composer", "pypoetry", "pdm", "hatch",
  "mise", "asdf", "pkgx", "fnm", "pnpm", "aider", "amp", "claude", "cline",
  "cursor-agent", "goose", "kilo", "opencode", "opentui", "containers",
];
const LOCAL_STATE_TOOLS = ["bun", "gh", "uv", "mise", "asdf", "amp", "cline", "kilo", "opencode"];

export function forbiddenWorkspaceRoots(home = homedir()): { exact: string[]; subpath: string[] } {
  return {
    exact: [home],
    subpath: [
      "/tmp",
      "/var/folders",
      "/private/tmp",
      "/private/var/folders",
      join(home, ".pi"), // C6: readable/writable from every session
      join(home, ".cache"),
      join(home, "Library", "Caches"),
      ...LOCAL_SHARE_TOOLS.map((name) => join(home, ".local", "share", name)),
      ...LOCAL_STATE_TOOLS.map((name) => join(home, ".local", "state", name)),
    ],
  };
}

/** True when `child` is `parent` or inside it, compared on resolved paths (not prefixes). */
function contains(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export interface WorkspaceViolation {
  root: string;
  reason: string;
}

/**
 * Validate the workspace root against D-5. Returns violations rather than throwing, so the
 * caller decides whether to refuse or warn.
 *
 * `/tmp` and `/var/folders` are checked as *roots*, but on macOS those are symlinks to
 * `/private/...`, so both spellings are checked.
 */
export function checkWorkspaceRoot(root: string, home = homedir()): WorkspaceViolation[] {
  const resolved = resolve(root);
  const { exact, subpath } = forbiddenWorkspaceRoots(home);
  const violations: WorkspaceViolation[] = [];

  // `$HOME` itself: equality only. `$HOME/.local/share/pi-central` is the recommended
  // location, so a containment test here would reject the very path we suggest.
  for (const path of exact) {
    if (resolve(path) === resolved) {
      violations.push({
        root: path,
        reason: "the default must not be $HOME itself, or a scratch session would hold a policy over the home tree (D-5)",
      });
    }
  }

  for (const path of subpath) {
    if (!contains(path, resolved)) continue;
    const reason =
      path === join(home, ".pi")
        ? "inside ~/.pi, which every sandboxed session can read and write (C6)"
        : contains("/tmp", resolved) || contains("/var/folders", resolved)
          ? `${path} is granted globally by the base safehouse profile (D-5)`
          : `${path} is a recursive read/write grant in the base safehouse profile (D-5)`;
    violations.push({ root: path, reason });
  }
  return violations;
}

/** The directory a scratch session gets. One per session, so two never share a policy. */
export function scratchDirFor(config: Config, sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new Error(`refusing to build a workspace path from an unsafe id: ${JSON.stringify(sessionId)}`);
  }
  return join(config.workspaceRoot, sessionId);
}

/** A session is "scratch" when its cwd is inside the app-owned workspace root. */
export function isScratch(config: Config, cwd: string): boolean {
  return contains(config.workspaceRoot, cwd);
}
