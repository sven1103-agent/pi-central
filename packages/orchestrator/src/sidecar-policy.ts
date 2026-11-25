/**
 * Launching the UI sidecar: the SECOND place Safehouse argv is assembled (ADR-0018).
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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

/** A minimal PATH, so the launcher resolves even when the orchestrator was started without one. */
const DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** What the sidecar's interpreter comes from: the plan's executable, plus the PATH it may be resolved through. */
export type InterpreterPlan = Pick<SidecarSpec, "sidecar" | "interpreter" | "path">;

/** The directories that make up a `PATH` string, in order, with empty entries dropped. */
function pathDirs(path: string): string[] {
  return path.split(":").filter((dir) => dir !== "");
}

/**
 * The `PATH` an interpreter is looked for in.
 *
 * One function rather than the same `??` chain three times: the resolution and the child's environment must agree on
 * it, or a bare `node` is found through one PATH and looked for through another.
 */
function searchPath(plan: InterpreterPlan): string {
  return plan.path ?? process.env["PATH"] ?? DEFAULT_PATH;
}

/**
 * An interpreter that exists, out of the one on record and the bare name behind it — or nothing.
 *
 * ## Why the first candidate is not simply `process.execPath`
 *
 * The orchestrator's own binary is captured when the process STARTS and is never re-resolved. Measured: an
 * orchestrator that outlived a Homebrew node revision bump (`26.13.1_3` → `_4`, the old Cellar directory
 * deleted) handed every new sidecar a path that no longer existed, and the session browser failed with `env:
 * …/node: No such file or directory`, exit 127, under a warning about the browser executable.
 *
 * So the resolved path is confirmed before it is used, and the answer when it is gone is the BARE NAME — which
 * `env` finds through the `PATH` the launch already carries. That is why this returns a name rather than
 * insisting on a path: `execvp` searches `PATH` for an entry with no slash, and the entry a bare `node` finds is
 * a current one.
 *
 * ## Why it is checked here and not at launch
 *
 * `process.execPath` is the orchestrator's, so nothing else records whether it is still on disk; and the fallback
 * needs the `PATH` composed for the sidecar, which exists only in this module (ADR-0018: one assembler).
 */
export function resolveInterpreterPath(
  plan: InterpreterPlan,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const candidates = [plan.interpreter, "node"];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    if (!candidate.includes("/")) {
      if (pathDirs(searchPath(plan)).some((dir) => exists(join(dir, candidate)))) return candidate;
      continue;
    }
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The executable the launch names first on the sidecar's command line.
 *
 * Throws, rather than falling back to an interpreter that is not there: a launch spec naming a missing file is a
 * child that dies with `ENOENT` and nothing that says why, which is the failure this whole resolution exists to
 * replace. The message names the interpreter AND the path that went missing, and it becomes the sidecar's failure
 * warning (`sidecarFailureWarning`).
 */
export function resolveInterpreter(plan: InterpreterPlan): string {
  if (plan.interpreter === undefined) return plan.sidecar;
  const resolved = resolveInterpreterPath(plan);
  if (resolved !== undefined) return resolved;
  const searched = pathDirs(searchPath(plan)).join(", ");
  throw new Error(
    `no interpreter for the sidecar: ${plan.interpreter} does not exist` +
      `${plan.interpreter === process.execPath ? " (the orchestrator's own node, replaced under it by an upgrade)" : ""}` +
      `, and no \`node\` was found on the sidecar's PATH (${searched})`,
  );
}

export interface SidecarSpec {
  /**
   * The `PATH` this launch may use. Defaults to the orchestrator's own, then to a minimal one.
   *
   * Exists because an empty environment cannot resolve a bare command name -- measured: the sidecar failed to
   * spawn with `spawn safehouse ENOENT` while every other part of the wiring was correct.
   */
  path?: string | undefined;
  /** Identifier for the fragment file name. Identifier-shaped, validated like a session id. */
  id: string;
  /** The dev-server port egress is pinned to. Per session, because a fleet has more than one. */
  port: number;
  /**
   * The loopback port the sidecar LISTENS on for MCP.
   *
   * Distinct from `port`, which is the dev server it may reach. Two different ports because they are two
   * different things, and conflating them would either expose the dev server as an MCP endpoint or pin egress to
   * the sidecar's own listener.
   */
  listenPort: number;
  /**
   * The bearer token, delivered through the ENVIRONMENT rather than the argv.
   *
   * `ps` shows another process's arguments to the same user, so a token on the command line is readable by
   * anything that can list processes. The environment is not private either (C5), but it is strictly less
   * visible, and it matches how the token already reaches Pi.
   */
  token: string;
  /** Where the sidecar keeps its profile. Must not be `/tmp` or `/var/folders` — every session can read those. */
  profileDir: string;
  /** Directory to write the rendered fragment into. Created if absent, mode 0700. */
  fragmentDir: string;
  safehouse: string;
  /** The sidecar executable: a fixed binary driven by the four verbs (ADR-0018 §2). */
  sidecar: string;
  /**
   * The binary `sidecar` is, when `sidecar` is a script rather than an executable — i.e. an interpreter.
   *
   * Not the same field, and the difference is a defect that shipped. `sidecar` was `process.execPath`, captured
   * when the orchestrator started and never re-resolved, so a Homebrew node revision bump (`_3` → `_4`) that
   * deleted the old Cellar directory under a running orchestrator left every new session browser launching an
   * interpreter that no longer existed: `env: …/node: No such file or directory`, exit 127.
   *
   * It belongs HERE, in the one place the sidecar's argv is assembled (ADR-0018), rather than at the caller: the
   * resolution has to sit beside the `PATH` it may use, and `options.sidecar` keeps naming the script so the
   * failure still says which file could not be started.
   *
   * Undefined means `sidecar` is its own executable and nothing is resolved — the common case gains no lookup.
   */
  interpreter?: string;
  /**
   * The directory the sidecar's own code lives in, granted READ-ONLY.
   *
   * Required because the sidecar is started from source in Phase 2 (`node <install>/sidecar.ts`), and a
   * sandboxed process cannot read a file outside its workdir. Measured: without this grant the process never
   * starts — no error, no output, no exit — because the interpreter cannot open the script it was asked to
   * run. A silent hang is the worst failure shape available, so the grant is part of the launch spec rather
   * than a caller's afterthought.
   *
   * Narrow on purpose: a directory, read-only, no execute-through-write. The sidecar's workdir remains its
   * profile, which is the only thing it may write.
   */
  sidecarCodeDir: string;
  /**
   * Arguments placed before the sidecar's own flags, e.g. the script path when `sidecar` is `node`.
   *
   * Exists because Phase 2 runs the sidecar from source, and the argv shape must still be fixed: binary,
   * then its own flags. A test uses it to substitute a stand-in that exercises the lifetime without a
   * browser. It is NOT caller-controlled — the supervisor resolves it from configuration, like `pi`.
   */
  sidecarArgs?: string[];
  /**
   * The browser executable the sidecar drives.
   *
   * Passed through the argv rather than the environment because the environment is deliberately minimal (a
   * `PATH` and nothing else), and because a fixed argv is easier to read in the Inspector.
   */
  browser: string;
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

  // The profile directory is created here, not by the browser launcher.
  //
  // It is the launch's `cwd` as well as Chrome's `--user-data-dir`, so a missing one makes `spawn` fail with
  // ENOENT naming the BINARY — a misleading error that points at the wrong file. Creating it beside the
  // fragment means the launch spec is satisfiable by construction.
  mkdirSync(resolve(spec.profileDir), { recursive: true, mode: 0o700 });

  const dir = resolve(spec.fragmentDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fragmentFile = join(dir, `${spec.id}.sb`);
  // 0600 in a 0700 directory: Safehouse reads this as the orchestrator, and a writable policy file is a
  // policy-injection route. Safehouse additionally emits a terminal deny-write for --append-profile paths,
  // so the sidecar cannot rewrite the rules that confine it.
  writeFileSync(fragmentFile, renderSidecarFragment({ port: spec.port }), { mode: 0o600 });

  if (!spec.sidecarCodeDir.startsWith("/")) {
    throw new Error(`sidecarCodeDir must be absolute: ${JSON.stringify(spec.sidecarCodeDir)}`);
  }
  assertPrivateLocation(spec.sidecarCodeDir, "code");

  const path = searchPath(spec);
  /*
   * The interpreter is resolved HERE, at launch, and not remembered from the orchestrator's start.
   *
   * Measured (issue #299): `process.execPath` was handed to every sidecar unchanged, and a Homebrew node revision
   * bump that deleted the old Cellar directory under a running orchestrator left each new session browser
   * launching a path that no longer existed. A refusal from here throws before anything is spawned, so it reaches
   * the reader as the sidecar's failure warning instead of as exit 127 with nothing said.
   */
  const command = resolveInterpreter(spec);

  const args: string[] = [
    "--workdir",
    resolve(spec.profileDir),
    // The code, read-only. Without it a source-launched sidecar never starts: the interpreter cannot open a
    // script outside the workdir, and the failure is a silent hang rather than an error.
    `--add-dirs-ro=${resolve(spec.sidecarCodeDir)}`,
    `--enable=${SIDECAR_ENABLE}`,
    `--append-profile=${fragmentFile}`,
    // A SAFEHOUSE flag, so it goes BEFORE the separator. Placed after, it became an argument to the
    // sidecar own command line: node forwarded it and the sidecar rejected it as unknown, printing its
    // usage line while Pi reported "Nothing is listening" -- a bind-failure message for a misplaced
    // argument. This is C15 one level down.
    "--env-pass=PI_CENTRAL_SIDECAR_TOKEN",
    "--",
    command,
    ...(spec.sidecarArgs ?? []),
    // The sidecar's own arguments, which mirror its entry point exactly:
    //   --executable  the browser it drives
    //   --profile     its writable directory (the workdir, so the sandbox already grants it)
    //   --origin      the ONE origin it serves; egress is pinned to that port in the fragment above
    //
    // These were written as `--port 0 --no-sandbox` before `sidecar.ts` existed, and they are not flags it
    // takes: the sidecar would have exited on an unknown argument even once its interpreter was right.
    "--executable",
    spec.browser,
    "--profile",
    resolve(spec.profileDir),
    "--origin",
    `http://localhost:${spec.port}`,
    // The sidecar reads its own listening port and token. Both were added to the entry point and NOT to this
    // argv, so the sidecar exited on its own usage message — a failure that looks like a missing server rather
    // than a wrong argument list.
    "--port",
    String(spec.listenPort),

  ];

  return {
    launch: {
      command: spec.safehouse,
      args,
      cwd: resolve(spec.profileDir),
      // Deliberately NOT `buildSessionEnv`: the sidecar is not an agent, and the session allowlist carries
      /**
       * Deliberately NOT `buildSessionEnv`: the sidecar is not an agent, and the session allowlist carries names
       * a renderer has no use for (C11). An explicit object also means `spawn` cannot inherit `process.env` (C4a).
       *
       * But it cannot be EMPTY either, and that was a real defect: with no `PATH`, a bare command name is not
       * resolvable, so spawning `safehouse` failed with ENOENT and the sidecar never started. Sessions never hit
       * this because `buildSessionEnv` supplies a `PATH`. The sidecar gets the minimum a process needs to resolve
       * its own binary, and nothing else -- no HOME, no credentials, no inherited secrets.
       */
      env: {
        PATH: path,
        /**
         * `HOME`, and only because Node will not start without it.
         *
         * Measured, twice: with `PATH` alone the child printed "HOME is not set; set HOME in the environment
         * before running this script" and exited — the sidecar never started, and Pi reported only "Connection
         * closed". It is the sidecar's OWN profile directory, not the user's home: nothing here reads `~/.ssh`
         * or `~/.config`, and the profile is a directory the fragment already confines it to.
         */
        HOME: resolve(spec.profileDir),
        /**
         * The bearer token, delivered here rather than on the argv.
         *
         * `ps` shows another process's arguments to the same user, so a token in the command line is readable by
         * anything that can list processes. The environment is not private either (C5) — but it is strictly less
         * visible, and it is already the channel this token travels on to reach Pi.
         */
        PI_CENTRAL_SIDECAR_TOKEN: spec.token,
      },
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
