/**
 * The spawn environment for a session — the sanitization boundary (C11, C4a).
 *
 * Why this is not Safehouse's job: **environment variables are not a sandbox concept.** No
 * SBPL grant or deny constrains them, so no policy can keep a variable out of a session.
 * Two verified facts (Safehouse `0.12.0`, `bin/safehouse`) make relying on Safehouse
 * actively wrong:
 *
 *   1. Its sanitized allowlist **already contains `SSH_AUTH_SOCK`** (line 7055), so a session
 *      launched through Safehouse still reaches the host's ssh-agent by default.
 *   2. `--env-pass` / `--env=FILE` merge **append-only** — the merge helper is
 *      `runtime_append_requested_host_env_entries`. They can *add* a variable but never
 *      *remove* one from the sanitized set.
 *
 * So the orchestrator builds the environment and hands it to `spawn`. `LaunchSpec.env` is
 * required, not optional, because omitting it in Node means "inherit `process.env`" — the
 * exact failure this module exists to prevent.
 */
import { homedir } from "node:os";

/**
 * Variables forwarded **only if set** in the source environment.
 *
 * Deliberately an allowlist, not a denylist of secret-shaped names: that set is unbounded and
 * user-defined, so a denylist silently fails open on the next tool that invents one.
 *
 * Notably **absent**, with the reason:
 *   - `SSH_AUTH_SOCK`, `SSH_AGENT_PID` — would let the session sign as the user with any key
 *     in their agent, without reading any key file (the hardening project's F4). Git-over-SSH
 *     uses a dedicated key with `IdentitiesOnly=yes` and needs no agent (ADR-0010 §4).
 *   - every `*_TOKEN`, `*_KEY`, `*_SECRET` — the agent's own credentials are injected per
 *     session from its own store, never inherited (ADR-0010).
 */
export const PASSTHROUGH = [
  // Process basics a CLI needs to behave normally.
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "EDITOR",
  "VISUAL",
  // Pi's own switches (environment-variables.md). These select behaviour, not identity, so
  // passing them preserves user intent without carrying a credential.
  "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK",
  "PI_TIMING",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_PACKAGE_DIR",
  "PI_SUBAGENT_PI_BINARY",
] as const;

/**
 * Variables that must never be *injected*, whoever asks, because they name the **host user's**
 * ssh-agent. Checked case-insensitively.
 *
 * `GH_TOKEN` is deliberately NOT here: injecting the agent's own token under that name is the
 * intended mechanism (ADR-0010 §3). The distinction that matters is **provenance, not name**.
 */
const FORBIDDEN_NAMES = new Set(["ssh_auth_sock", "ssh_agent_pid"]);

export interface SessionEnvOptions {
  /** Source to read {@link PASSTHROUGH} from. Defaults to `process.env`. */
  source?: NodeJS.ProcessEnv;
  /** `PATH` to use when the source has none (e.g. a launchd-started orchestrator). */
  fallbackPath?: string;
  /**
   * Values set explicitly for this session — the **trusted channel** (ADR-0010).
   *
   * This is where the agent's *own* credentials go: a token from the agent store, an
   * agent-scoped `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM=/dev/null`.
   *
   * The caller must not source these from `process.env`. `buildSessionEnv` cannot verify
   * provenance — a value read out of the host environment is the user's secret whatever it is
   * called — so it enforces only the two structurally host-only names above, and the store is
   * responsible for the rest.
   */
  set?: Record<string, string>;
}

/**
 * Build the complete environment for one session.
 *
 * @throws if an injected name is malformed, or names the host ssh-agent. Failing loudly is
 *   the point: a silently dropped credential surfaces much later as a confusing auth error.
 */
export function buildSessionEnv(options: SessionEnvOptions = {}): Record<string, string> {
  const source = options.source ?? process.env;
  const env: Record<string, string> = {};

  for (const name of PASSTHROUGH) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }

  env["PATH"] ??= options.fallbackPath ?? DEFAULT_PATH;

  for (const [name, value] of Object.entries(options.set ?? {})) {
    assertInjectableName(name);
    env[name] = value;
  }

  return env;
}

/** A minimal PATH, so a session is usable even if the orchestrator was launched without one. */
export const DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Whether an environment lets its session reach the host's ssh-agent.
 *
 * Exposed so the isolation claim is *checkable* rather than asserted in a comment, and so a
 * test can prove the boundary holds.
 */
export function leaksSshAgent(env: Record<string, string>): boolean {
  return env["SSH_AUTH_SOCK"] !== undefined || env["SSH_AGENT_PID"] !== undefined;
}

/**
 * The agent-scoped routing variables (ADR-0010 §3).
 *
 * These close the hardening project's F12 route, where the host's global gitconfig invoked
 * `gh auth git-credential` and resolved a token from the login keychain — a path that no file
 * deny on `~/.ssh` would stop. `GIT_CONFIG_SYSTEM=/dev/null` removes the host's system config
 * as an independent route to the same place.
 *
 * `HOME` is intentionally left alone: Pi needs the real home for `~/.pi` (C6), and the
 * credential paths under it are closed by the appended policy fragment instead.
 */
export function agentRoutingEnv(agentRoot: string): Record<string, string> {
  if (!agentRoot.startsWith("/")) {
    throw new Error(`agent root must be an absolute path: ${JSON.stringify(agentRoot)}`);
  }
  return {
    GH_CONFIG_DIR: `${agentRoot}/gh`,
    GIT_CONFIG_GLOBAL: `${agentRoot}/gitconfig`,
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

/** The agent root for an id, under a state root. One directory per agent identity. */
export function agentRootFor(stateRoot: string, agentId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(agentId)) {
    throw new Error(`refusing to build an agent path from an unsafe id: ${JSON.stringify(agentId)}`);
  }
  return `${stateRoot}/agents/${agentId}`;
}

/** Where a fresh agent's store lives when Pi Central owns it (the `managed` mode). */
export function defaultAgentRoot(agentId: string): string {
  return agentRootFor(`${homedir()}/.config/pi-central`, agentId);
}

function assertInjectableName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to inject a malformed env var name: ${JSON.stringify(name)}`);
  }
  if (FORBIDDEN_NAMES.has(name.toLowerCase())) {
    throw new Error(
      `refusing to inject ${name}: it would expose the host user's ssh-agent to the session. ` +
        `An agent that needs SSH uses its own key with IdentitiesOnly=yes (ADR-0010 §4).`,
    );
  }
}
