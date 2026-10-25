/**
 * Session launch policy.
 *
 * This is the single place where a session's command line is assembled
 * (docs/STACK.md: `composePolicy` must be one function).
 *
 * Two modes, and the difference is the whole architecture (ADR-0002):
 *
 *   sandboxed  safehouse --workdir <cwd> [--enable=...] -- pi --mode rpc
 *   direct     pi --mode rpc            (no isolation; for feasibility only)
 *
 * The sandboxed mode is the product. The direct mode exists because this
 * prototype is developed from inside a Safehouse sandbox itself, where
 * sandbox-exec cannot nest (C1) and would fail with
 * `sandbox_apply: Operation not permitted`. It is clearly labelled in the UI
 * as NOT SANDBOXED so it cannot be mistaken for the real thing.
 */
import { accessSync, constants } from "node:fs";
import type { LaunchSpec } from "./rpc.ts";

export type LaunchMode = "sandboxed" | "direct";

export interface SessionSpec {
  id: string;
  name: string;
  cwd: string;
  mode: LaunchMode;
  enable?: string[];
  envPass?: string[];
}

export interface ComposedPolicy {
  launch: LaunchSpec;
  /** Human-readable description of the isolation actually in force. */
  isolation: string;
  warnings: string[];
}

const SAFEHOUSE = "safehouse";
const PI = "pi";

/** Options Pi Central must never pass for a supervised session (docs/SANDBOX.md). */
const FORBIDDEN_ENABLE = new Set(["wide-read"]);
const FORBIDDEN_FLAGS = ["--allow-workdir-config-writes", "--allow-profile-writes"];

export function composePolicy(spec: SessionSpec): ComposedPolicy {
  const warnings: string[] = [];

  assertDirectory(spec.cwd);

  if (spec.mode === "direct") {
    return {
      launch: {
        command: PI,
        args: ["--mode", "rpc", "--no-session"],
        cwd: spec.cwd,
      },
      isolation: "NONE — pi runs unsandboxed, inheriting this process's sandbox (if any)",
      warnings: ["Direct mode does not apply a Safehouse policy. Feasibility testing only."],
    };
  }

  const enable = (spec.enable ?? []).filter((f) => {
    if (FORBIDDEN_ENABLE.has(f)) {
      warnings.push(`Refused --enable=${f}: grants read access across the filesystem.`);
      return false;
    }
    return true;
  });

  const args: string[] = [`--workdir`, spec.cwd];
  if (enable.length > 0) args.push(`--enable=${enable.join(",")}`);
  for (const name of spec.envPass ?? []) args.push(`--env-pass=${name}`);

  for (const bad of FORBIDDEN_FLAGS) {
    if (args.includes(bad)) throw new Error(`refusing to pass ${bad}`);
  }

  args.push("--", PI, "--mode", "rpc", "--no-session");

  return {
    launch: { command: SAFEHOUSE, args, cwd: spec.cwd },
    isolation: `Safehouse workdir=${spec.cwd}${enable.length ? ` enable=${enable.join(",")}` : ""}`,
    warnings,
  };
}

function assertDirectory(dir: string): void {
  try {
    accessSync(dir, constants.R_OK);
  } catch {
    throw new Error(`working directory is not readable: ${dir}`);
  }
}

/** Render the equivalent shell command, for display in the UI. */
export function describe(policy: ComposedPolicy): string {
  return [policy.launch.command, ...policy.launch.args].join(" ");
}
