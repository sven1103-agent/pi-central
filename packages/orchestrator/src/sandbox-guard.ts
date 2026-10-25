/**
 * Refuse to run unsandboxed work inside a sandbox (C1).
 *
 * Seatbelt does not nest: `sandbox-exec` inside an already-sandboxed process fails with
 * EPERM. Every session Pi Central spawns would therefore fail, and the failures would look
 * like ordinary spawn errors rather than a misinvocation. Phase 0 and `verify-three.ts`
 * both hit this, and both solve it by probing rather than by inspecting the environment.
 *
 * The probe is a **dry run of the real operation** — `sandbox-exec -p '(version 1)' -- true`
 * — rather than an environment check, because the environment has no reliable marker. A
 * harness that inferred "am I sandboxed?" from a variable would be asserting its own
 * assumption.
 *
 * There is one false negative worth naming: a sandbox that permits `sandbox-exec` would let
 * the probe succeed even though nesting is unwise. That direction is the safe one — the
 * cost is a confusing failure later, never a silently unsandboxed session.
 */
import { spawnSync } from "node:child_process";

/** The exit code used when Pi Central refuses to start because it is itself sandboxed. */
export const SANDBOX_REFUSAL_CODE = 2;

export interface SandboxProbe {
  /** True when `sandbox-exec` can apply a trivial policy here, i.e. nesting works. */
  canNest: boolean;
  /** Diagnostic detail for the failure message. */
  detail: string;
}

/**
 * Probe whether a policy can be applied in this environment.
 *
 * Exported separately from the message so tests can exercise it directly. Callers that only
 * want to fail should use `assertNotSandboxed`.
 */
export function probeSandbox(execPath = "/usr/bin/sandbox-exec"): SandboxProbe {
  const result = spawnSync(execPath, ["-p", "(version 1)(allow default)", "--", "/usr/bin/true"], {
    encoding: "utf8",
    timeout: 10_000,
  });

  // A spawn failure (ENOENT) means no `sandbox-exec` at all: on a non-Darwin host, or in a
  // sanitized PATH. That is its own condition (C10) and not a nesting problem.
  if (result.error) {
    return { canNest: false, detail: `cannot run ${execPath}: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    return {
      canNest: false,
      detail: stderr.length > 0 ? stderr : `exited ${result.status ?? "on a signal"}`,
    };
  }
  return { canNest: true, detail: "ok" };
}

/** Thrown so callers can distinguish "refused to run" from "crashed while running". */
export class SandboxedEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxedEnvironmentError";
  }
}

/**
 * Refuse to proceed when a policy cannot be applied, with a message that says what to do.
 *
 * The message names the cause rather than the symptom: the previous, less specific failure
 * ("spawn EPERM") sent a reader looking for a bug in the launcher.
 */
export function assertNotSandboxed(execPath = "/usr/bin/sandbox-exec"): SandboxProbe {
  const probe = probeSandbox(execPath);
  if (probe.canNest) return probe;

  throw new SandboxedEnvironmentError(
    [
      "Pi Central cannot start: this process is inside a sandbox, and Seatbelt does not nest (C1).",
      "",
      `  probe: ${execPath} -p '(version 1)(allow default)' -- /usr/bin/true`,
      `  result: ${probe.detail}`,
      "",
      "Every session would be spawned through `safehouse`, which applies a policy with",
      "`sandbox-exec` -- and that fails with EPERM here, so every session would fail for a",
      "reason that looks like a launcher bug.",
      "",
      "Run Pi Central from a plain shell (not a sandboxed terminal, editor task, or agent",
      "harness). The orchestrator is intentionally unsandboxed at the user's UID (ADR-0002).",
    ].join("\n"),
  );
}
