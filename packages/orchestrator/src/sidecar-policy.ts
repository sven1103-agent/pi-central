/**
 * Launching the UI sidecar: the SECOND place Safehouse argv is assembled (ADR-0015).
 *
 * `policy.ts` says it is the single place a session command line is built, and that guarantee exists so
 * every session's grant set derives from one function. This module adds a second assembler, so the
 * guarantee has to be restated rather than quietly weakened:
 *
 *   - **Sessions can never emit a Chromium feature.** `composePolicy` filters `FORBIDDEN_ENABLE`, but
 *     `playwright-chrome` is not on that list — the only thing keeping it out of a session today is that
 *     no caller passes it. That is a property of the call sites, not of the type, which is why
 *     `sidecar-policy.test.ts` asserts the negative directly.
 *   - **The sidecar can never emit a workdir grant.** This function takes no `cwd`, so there is no
 *     parameter through which one could arrive. The absence is the control, not a check.
 *   - **Neither assembler can produce the other's argv shape.** They share only the Safehouse binary
 *     name and the argv conventions, and there is deliberately no common helper that would let one
 *     inherit the other's grants.
 *
 * Why `--no-sandbox` is here and not a caller's choice: Safehouse cannot permit Chromium's nested
 * Seatbelt sandbox (`safehouse --help`; `chromium-full.sb` explains the re-init failure), so a browser
 * launched without it does not start. That makes the appended fragment the renderer's ONLY confinement,
 * which is why the fragment is required rather than optional.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LaunchSpec } from "./rpc.ts";
import { renderSidecarFragment } from "./sidecar-fragment.ts";

/**
 * The one Safehouse feature set the sidecar may use.
 *
 * A constant, not an option, so there is no `enable` parameter to smuggle a larger set through. Measured
 * (Phase 0C): `chromium-headless` is not sufficient on its own — its mach grants are necessary but the
 * app-bundle `file-read` lives in `chromium-full` — so this is the smallest set that renders with the
 * Chrome the design ships against. The narrow muzzle is the appended fragment, not the feature name.
 */
export const SIDECAR_ENABLE = "playwright-chrome";

/**
 * Roots every sandboxed process can read and write, so nothing private may live there.
 *
 * Measured: Safehouse's base profile grants `(subpath "/tmp")` and `(subpath "/var/folders")` read/write
 * (base policy lines 193–196), and `config.ts` records the same fact for the default workspace (D-5).
 *
 * Exported so a test can *choose* a private root rather than being unable to exercise the happy path
 * where `$HOME` is not writable — a guard nothing can satisfy is a guard nobody can test.
 */
export const SHARED_TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"] as const;

export interface SidecarSpec {
  /** Identifier for the fragment file name. Identifier-shaped, validated like a session id. */
  id: string;
  /** The dev-server port egress is pinned to. Per session, because a fleet has more than one. */
  port: number;
  /** Where the sidecar keeps its profile. Must not be `/tmp` or `/var/folders` — every session can read those. */
  profileDir: string;
  /** Directory to write the rendered fragment into. Created if absent, mode 0700. */
  fragmentDir: string;
  safehouse: string;
  /** The sidecar executable: a fixed binary driven by the four verbs (ADR-0015 §2). */
  sidecar: string;
}

export interface ComposedSidecar {
  launch: LaunchSpec;
  isolation: string;
  /** The rendered fragment's path, surfaced for the Inspector and for verification. */
  fragmentFile: string;
}

/**
 * Compose the sidecar's launch spec.
 *
 * @throws if the id is not identifier-shaped, or the profile sits in a world-readable temp root. Both are
 *   launch-time refusals rather than warnings: each one defeats a stated property (the fragment name is
 *   derived from the id; the profile holds the renderer's only writable state).
 */
export function composeSidecarPolicy(spec: SidecarSpec): ComposedSidecar {
  if (!/^[A-Za-z0-9._-]+$/.test(spec.id)) {
    throw new Error(`refusing to build a sidecar from an unsafe id: ${JSON.stringify(spec.id)}`);
  }
  assertPrivateLocation(spec.profileDir, "profile");
  assertPrivateLocation(spec.fragmentDir, "fragment");

  const dir = resolve(spec.fragmentDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fragmentFile = join(dir, `${spec.id}.sb`);
  // 0600 in a 0700 directory: Safehouse reads this as the orchestrator, and a writable policy file is a
  // policy-injection route. Safehouse additionally emits a terminal deny-write for --append-profile paths,
  // so the sidecar cannot rewrite the rules that confine it.
  writeFileSync(fragmentFile, renderSidecarFragment({ port: spec.port }), { mode: 0o600 });

  const args: string[] = [
    "--workdir",
    resolve(spec.profileDir),
    `--enable=${SIDECAR_ENABLE}`,
    `--append-profile=${fragmentFile}`,
    "--",
    spec.sidecar,
    "--port",
    "0",
    "--no-sandbox",
  ];

  return {
    launch: {
      command: spec.safehouse,
      args,
      cwd: resolve(spec.profileDir),
      // Deliberately NOT `buildSessionEnv`: the sidecar is not an agent, and the session allowlist carries
      // names a renderer has no use for (C11). An empty environment plus what Safehouse computes is the
      // smallest honest answer, and an explicit object means `spawn` cannot inherit `process.env` (C4a).
      env: {},
    },
    isolation: `Safehouse sidecar profile=${spec.profileDir} enable=${SIDECAR_ENABLE} egress=localhost:${spec.port}`,
    fragmentFile,
  };
}

/**
 * Refuse a location every session can read.
 *
 * Measured, not assumed: Safehouse's base profile grants `(subpath "/tmp")` and `(subpath "/var/folders")`
 * read/write to every sandboxed process, and `config.ts` records the same fact for the default workspace
 * (D-5). A profile there would be readable — and writable — by the sessions it is supposed to be isolated
 * from, which is the whole point of loading it.
 */
function assertPrivateLocation(dir: string, what: string): void {
  const resolved = resolve(dir);
  for (const root of SHARED_TEMP_ROOTS) {
    if (resolved === root || resolved.startsWith(`${root}/`)) {
      throw new Error(
        `refusing a sidecar ${what} under ${root}: every session can read and write there ` +
          `(${resolved}). Use the state root.`,
      );
    }
  }
}
