/**
 * Safehouse launch policy — the SINGLE place a session command line is assembled.
 *
 * If a second call site ever appears, the guarantee that every session's grant set is
 * derived from exactly one function is gone (packages/orchestrator/README.md, ADR-0002).
 *
 * Isolation is per session, and the working directory is its only input (ADR-0004). A
 * session's cwd is fixed at spawn and never changes (ADR-0008), so this function has no
 * "update" path by design.
 */
import { accessSync, constants, statSync } from "node:fs";
import type { LaunchSpec } from "./rpc.ts";

export type LaunchMode = "sandboxed" | "direct";

export interface SessionSpec {
  id: string;
  cwd: string;
  mode: LaunchMode;
  /** Extra safehouse `--enable` features. Validated against a denylist. */
  enable?: string[];
  /** Env var names to forward into the session (C4). */
  envPass?: string[];
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
}

/**
 * `--enable` features Pi Central must never pass for a supervised session.
 *
 * `wide-read` grants read across the filesystem, which is exactly the union ADR-0002
 * exists to prevent: one prompt injection would reach every project the user owns.
 *
 * `all-agents` / `all-apps` are refused for the same reason at a coarser grain: they enable
 * broad feature sets rather than one scoped capability, so the resulting grant is not
 * derived from the workdir at all. Verify against `safehouse --help` on upgrade; the
 * supported list is finite and printed there.
 */
const FORBIDDEN_ENABLE = new Set(["wide-read", "all-agents", "all-apps"]);

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

  const args: string[] = ["--workdir", spec.cwd];
  if (enable.length > 0) args.push(`--enable=${enable.join(",")}`);
  for (const name of spec.envPass ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`refusing to pass a malformed env var name: ${JSON.stringify(name)}`);
    }
    args.push(`--env-pass=${name}`);
  }

  for (const bad of FORBIDDEN_FLAGS) {
    // Not merely absent: asserted absent, so a future caller cannot smuggle one in.
    if (args.includes(bad)) throw new Error(`refusing to pass ${bad}`);
  }

  args.push("--", spec.pi, "--mode", "rpc");
  if (spec.name) args.push("--name", spec.name);
  return {
    launch: { command: spec.safehouse, args, cwd: spec.cwd },
    isolation: `Safehouse workdir=${spec.cwd}${enable.length ? ` enable=${enable.join(",")}` : ""}`,
    warnings,
  };
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
