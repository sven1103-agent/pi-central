/**
 * Safehouse launch policy — the SINGLE place a session command line is assembled.
 *
 * If a second call site ever appears, the guarantee that every session's grant set is
 * derived from exactly one function is gone (packages/orchestrator/README.md, ADR-0002).
 *
 * Isolation is per session, and the working directory is its only input (ADR-0004). A
 * session's cwd is fixed at spawn and never changes (ADR-0008), so this function has no
 * "update" path by design.
 *
 * Three controls are composed here, and they are independent — each covers a gap the others
 * do not (ADR-0010):
 *
 *   1. the Safehouse argv         — filesystem grants, derived from the workdir
 *   2. the appended fragment      — denies for the host's *credential* paths
 *   3. the spawn environment      — what the session can see at all (C11)
 *
 * On `--env-pass`: it **is** used, and the reason is worth recording because an earlier reading of
 * the same fact caused a defect.
 *
 * The fact: Safehouse's environment handling is add-only. `--env-pass` can introduce a name, and
 * cannot remove one — `SSH_AUTH_SOCK` is on its default list (C4a), so no flag will take it away.
 * That is why *sanitisation* happens in `env.ts`, and that part was always right.
 *
 * What an earlier comment here generalised from it — "so `--env-pass` is deliberately not used" —
 * was wrong, and cost a working feature. Safehouse runs the session as `env -i` plus its own list
 * of names, so a variable that is not requested **by name** is discarded no matter how carefully
 * the spawn environment sets it. Without `--env-pass`, every variable we inject is silently
 * dropped: the agent's `gh` fell back to the host config (denied, so it refused to start) and its
 * git identity was never applied.
 *
 * Removal and delivery are different problems. `env.ts` solves removal; this flag solves delivery.
 */
import { accessSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSessionEnv } from "./env.ts";
import type { LaunchSpec } from "./rpc.ts";

export type LaunchMode = "sandboxed" | "direct";

export interface SessionSpec {
  id: string;
  cwd: string;
  mode: LaunchMode;
  /** Extra safehouse `--enable` features. Validated against a denylist. */
  enable?: string[];
  /**
   * Values injected into the session environment — the trusted channel for the agent's own
   * credentials (ADR-0010). Never sourced from `process.env` by the caller.
   */
  env?: Record<string, string>;
  /**
   * A rendered policy fragment appended after Safehouse's generated rules (ADR-0010 §2).
   * Write it with `renderPolicyFragment` in `fragment.ts`.
   */
  policyFragment?: string;
  /** Directory to write the rendered fragment into. Required when `policyFragment` is set. */
  fragmentDir?: string;
  safehouse: string;
  pi: string;
  /** Optional session display name (`--name`). */
  name?: string;
}

export interface ComposedPolicy {
  launch: LaunchSpec;
  /** Human-readable description of the isolation actually in force. */
  isolation: string;
  warnings: string[];
  /** The rendered fragment's path, when one was applied. Surfaced for verification. */
  fragmentFile?: string;
}

/**
 * `--enable` features Pi Central must never pass for a supervised session.
 *
 * `wide-read` grants read across the filesystem, which is exactly the union ADR-0002 exists
 * to prevent: one prompt injection would reach every project the user owns.
 *
 * `all-agents` / `all-apps` are refused for the same reason at a coarser grain: they enable
 * broad feature sets rather than one scoped capability, so the resulting grant is not derived
 * from the workdir at all. Verify against `safehouse --help` on upgrade; the supported list is
 * finite and printed there.
 *
 * `ssh` and `keychain` re-open the credential boundary this policy exists to close. Both were
 * verified by diffing generated policies (`safehouse --stdout … --enable=ssh`): `ssh` appends
 * an `Integration: SSH` block (1,076 → 1,136 lines) granting agent-socket network access, and
 * `keychain` grants keychain read/write plus `SecurityServer` mach-lookups.
 *
 * Note that refusing `ssh` does **not** by itself close the ssh-agent path: `SSH_AUTH_SOCK` is
 * already in Safehouse's sanitized environment allowlist (C4a). That is closed in the spawn
 * environment (C11) and again in the appended fragment.
 *
 * `cloud-credentials` and `cloud-storage` are refused by the same reasoning: they hand the
 * session the *user's* cloud identity rather than the agent's own (ADR-0010).
 */
const FORBIDDEN_ENABLE = new Set([
  "wide-read",
  "all-agents",
  "all-apps",
  "ssh",
  "keychain",
  "cloud-credentials",
  "cloud-storage",
]);

/**
 * Flags that weaken the profile's own protections. Refused outright rather than warned
 * about, because a warning implies the session still starts.
 *
 * Both are real safehouse flags (verified against `safehouse --help`, 0.12.0).
 */
const FORBIDDEN_FLAGS = ["--allow-workdir-config-writes", "--allow-profile-writes"];

export function composePolicy(spec: SessionSpec): ComposedPolicy {
  const warnings: string[] = [];

  assertLaunchableDirectory(spec.cwd);

  if (spec.mode === "direct") {
    return {
      launch: {
        command: spec.pi,
        args: ["--mode", "rpc", ...(spec.name ? ["--name", spec.name] : [])],
        cwd: spec.cwd,
        env: buildSessionEnv(spec.env ? { set: spec.env } : {}),
      },
      isolation: "NONE — pi runs unsandboxed, inheriting this process's sandbox (if any)",
      warnings: ["Direct mode applies no Safehouse policy. Feasibility testing only."],
    };
  }

  const enable = (spec.enable ?? []).filter((feature) => {
    if (FORBIDDEN_ENABLE.has(feature)) {
      warnings.push(`Refused --enable=${feature}: it grants access beyond the workdir.`);
      return false;
    }
    return true;
  });

  const fragmentFile = materializeFragment(spec);

  const args: string[] = ["--workdir", spec.cwd];
  if (enable.length > 0) args.push(`--enable=${enable.join(",")}`);
  // Emitted after generated rules; SBPL last-match-wins makes these denies authoritative.
  if (fragmentFile !== undefined) args.push(`--append-profile=${fragmentFile}`);

  // Handed to `spawn` directly, replacing the inherited environment entirely (C11).
  const env = buildSessionEnv(spec.env ? { set: spec.env } : {});

  /**
   * Tell Safehouse to forward the variables we injected.
   *
   * **Without this, the values never reach the session.** Safehouse runs the wrapped command as
   * `env -i` followed by its own list of names (verified in the installed script), so a variable
   * that is not on that list is discarded — however carefully we set it in the spawn environment.
   *
   * The names are DERIVED from the environment we just built rather than written out, because a
   * literal list drifts: someone adds a variable to `agentRoutingEnv` and the new one is silently
   * dropped again. Deriving it means the delivery set is exactly the injected set, by
   * construction.
   *
   * Forwarding everything we inject cannot leak anything, because `env.ts` built that object — it
   * is the trusted channel of ADR-0010 §3, never `process.env` (C11).
   *
   * This was a real defect, not a precaution. `GH_CONFIG_DIR` was absent from Safehouse's
   * defaults, so the agent's `gh` fell back to the host's `~/.config/gh/config.yml`, found it
   * denied by our own fragment, and refused to start — while `GIT_CONFIG_GLOBAL` and
   * `GIT_CONFIG_SYSTEM` were dropped in the same way, so the agent's git identity was never in
   * effect either. The deny was working perfectly; the capability next to it was dead.
   */
  // Forward ONLY what we inject, not everything in `env`.
  //
  // Safehouse builds its own `HOME`, `PATH`, `TMPDIR`, `SHELL`, `USER`, `LOGNAME` and forwards a
  // terminal/editor/locale list of its own (verified in the installed script). Naming those here
  // would override values it chose deliberately — `--env-pass` upserts — for no gain. The names
  // that matter are the ones Safehouse cannot know about: the agent's routing variables.
  //
  // Derived from `spec.env` rather than written out, so adding a variable to `agentRoutingEnv`
  // cannot silently reintroduce this defect.
  const injected = Object.keys(spec.env ?? {});
  if (injected.length > 0) args.push(`--env-pass=${injected.join(",")}`);
  // The names must exist in the safehouse process's own environment, and they do: `env`, built
  // from the same values, is handed to `spawn` for exactly that process.

  for (const bad of FORBIDDEN_FLAGS) {
    // Not merely absent: asserted absent, so a future caller cannot smuggle one in.
    if (args.includes(bad)) throw new Error(`refusing to pass ${bad}`);
  }

  args.push("--", spec.pi, "--mode", "rpc");
  if (spec.name) args.push("--name", spec.name);

  const result: ComposedPolicy = {
    launch: { command: spec.safehouse, args, cwd: spec.cwd, env },
    isolation:
      `Safehouse workdir=${spec.cwd}` +
      `${enable.length ? ` enable=${enable.join(",")}` : ""}` +
      `${fragmentFile !== undefined ? " +bespoke-fragment" : ""}`,
    warnings,
  };
  if (fragmentFile !== undefined) result.fragmentFile = fragmentFile;
  return result;
}

/**
 * Write the fragment and return its path, or `undefined` when none was requested.
 *
 * Mode 0600, and in a 0700 directory: Safehouse reads this file as the orchestrator, and a
 * writable policy file would be a policy-injection route. Safehouse additionally emits a
 * terminal `deny file-write*` for every `--append-profile` path, so a session cannot rewrite
 * the rules that confine it — that emitted protection is why appending is safe at all, and
 * `--allow-profile-writes` (refused above) is what would defeat it.
 */
function materializeFragment(spec: SessionSpec): string | undefined {
  if (spec.policyFragment === undefined) {
    if (spec.fragmentDir !== undefined) {
      throw new Error("fragmentDir was given without a policyFragment to write");
    }
    return undefined;
  }
  if (spec.fragmentDir === undefined) {
    throw new Error("a policyFragment needs a fragmentDir to be written into");
  }
  const dir = resolve(spec.fragmentDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${spec.id}.sb`);
  writeFileSync(file, spec.policyFragment, { mode: 0o600 });
  return file;
}

/**
 * A directory is launchable when it exists, is a directory, and is readable. `statSync`
 * would follow a symlink, so this also rejects a path that resolves to a non-directory.
 *
 * Validated here because Pi exits `1` in RPC mode on a missing cwd rather than prompting
 * (C2, US-5), and because safehouse would otherwise be handed a grant for nothing.
 */
function assertLaunchableDirectory(dir: string): void {
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    throw new Error(`working directory does not exist: ${dir}`);
  }
  if (!stats.isDirectory()) throw new Error(`working directory is not a directory: ${dir}`);
  try {
    accessSync(dir, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(`working directory is not readable: ${dir}`);
  }
}

/**
 * Render the equivalent shell command, for display. Displayed, never executed.
 *
 * A note on why there is no metacharacter scan on `cwd`: the supervisor spawns with
 * `child_process.spawn` and no shell, so a path containing `$`, `(`, or a space is passed
 * as a single argv element and cannot be interpreted. Adding a scan would refuse legitimate
 * directories such as `/Users/x/My Project (copy)` while protecting nothing. The real
 * control is that the command is a fixed binary and the argument *shapes* are fixed; the
 * only free values are a validated path and identifier-shaped env names.
 */
export function describe(policy: ComposedPolicy): string {
  return [policy.launch.command, ...policy.launch.args].join(" ");
}
