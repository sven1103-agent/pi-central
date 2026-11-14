/**
 * One bounded OS action: select a resolved path in the platform file manager (ADR-0014).
 *
 * ## Why this is not `places.ts`, and not a wider `files.ts`
 *
 * `files.ts` confines every path to a session's `cwd`, and that confinement IS the feature (ADR-0007).
 * `places.ts` takes a different boundary: directories inside a fixed set of roots, no file contents.
 * This module takes a third, narrower one: **one path inside a session's `cwd`, acted on**. It reads
 * nothing, writes nothing, and interprets nothing it discovered — it asks the OS to select an item.
 *
 * That is a genuine capability increase over `files.ts` — an orchestrator that has only read files now
 * *acts* — and it is recorded as one rather than as a new case in a switch: ADR-0014, extending
 * ADR-0007 instead of quietly widening it.
 *
 * ## Containment is REUSED, not re-implemented
 *
 * The action takes `(root, relative)` and calls `resolveWithin` exactly as a read does. This is the
 * single most important line in the file: two containment implementations is how the weaker one
 * eventually wins, and `escapes-cwd` and its siblings keep exactly one meaning.
 *
 * ## The path handed to the OS is the RESOLVED one
 *
 * `resolveWithin` returns both the real path and the normalised relative path. The child gets the
 * **resolved** one, so the string given to the launcher is the same string the containment check
 * validated. Passing the client's spelling would hand an unvalidated string to a launcher even when
 * the resolved path was safe — the class of mismatch `own-installation.ts` shipped once (issue #25).
 *
 * ## Why `-R` and nothing else
 *
 * `reveal` (`open -R`) selects the item in Finder and hands the bytes to **no** application. `open`
 * without `-R` delegates to whatever application the OS registered for the extension — dynamic
 * dispatch this app does not control, on a file the model may have written. ADR-0007's guardrail 5
 * (*"nothing discovered by browsing is executed, sourced, or interpreted"*) stays true verbatim.
 *
 * ## What the exit status does NOT say
 *
 * Measured against `/usr/bin/open`: every genuine failure exits **1** with a message, so non-zero is a
 * *confirmed* failure. But `open` also returns **0** after merely handing the request to `launchd`, so
 * 0 means the request was accepted — never that Finder displayed anything. Refusals are therefore
 * decided BEFORE the spawn (`resolveWithin`, `lstat`, platform), a zero exit is never reported as
 * success, and a reveal that silently did nothing is a stated limitation (ADR-0014) rather than a
 * claim this module cannot support.
 */
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { fromErrno } from "./fs-error.ts";
import { resolveWithin, type FileFailure } from "./files.ts";

/** The actions this module performs. One, and a second would be a new decision (ADR-0014). */
export type OsAction = "reveal";

/**
 * Why an OS action was refused.
 *
 * `FileFailure` plus one arm of its own: everything `resolveWithin` can say, and the platform. Closed
 * like `FileFailure` is, so a client must handle each case rather than print whatever prose arrived.
 */
export type OsActionFailure = FileFailure | "unsupported-platform";

/** A refusal, in the shape the file browser already uses — same fields, same meaning, one more reason. */
export interface OsActionError {
  reason: OsActionFailure;
  /** The raw errno, when the OS produced one. Never invented. */
  code?: string | undefined;
  /** A sentence for the UI. Names the code when there is one — never a substituted guess. */
  message: string;
}

export type OsActionResult = { ok: true } | { ok: false; error: OsActionError };

/**
 * The launcher, and the only flags this module will ever pass it.
 *
 * A fixed shape rather than a built-up array, because the shape IS the boundary: `-a` (application),
 * `-b` (bundle id), `-t` (text editor) and `-u` (URL) each turn this into "ask the OS to run something
 * of the caller's choosing". `-g` keeps the reveal from taking focus from a composer the reader is
 * mid-sentence in. `--` is defence in depth: the resolution rule below already makes the argument
 * absolute, so no filename can reach the argv — but a later change to that rule must not be able to
 * turn a filename into an application choice.
 */
const OPEN_PATH = "/usr/bin/open";

/** The argv, in one place, so the test can assert the literal shape rather than a paraphrase of it. */
export function revealArgv(absolute: string): string[] {
  return ["-g", "-R", "--", absolute];
}

export interface RevealOptions {
  /**
   * The launcher, for tests only.
   *
   * A **function parameter** rather than an environment variable, deliberately: a configurable
   * launcher path is a configurable command, and the configuration slice (#223) states that a config
   * file may not widen the sandbox. A test passes a script that records its argv; no production
   * caller passes this.
   */
  openPath?: string;
  /** The platform, for tests only — so the refusal is asserted without needing a Linux machine. */
  platform?: NodeJS.Platform;
  /**
   * Where a failure that can only be known AFTER the spawn is reported.
   *
   * Synchronous `spawn` has no error to return: Node reports `ENOENT`/`EACCES` on an asynchronous
   * `error` event, and a non-zero exit arrives later still. Both are *confirmed* failures and both
   * travel here, so the refusal keeps the same shape as the ones decided before the spawn. Without a
   * listener Node treats an unhandled `error` event as an exception that exits the process, which for
   * a launcher that has gone missing would take the orchestrator — and every session — with it.
   */
  onLaunchError?: (error: OsActionError) => void;
}

/**
 * Select `relative` (inside `root`) in the platform file manager.
 *
 * Order, and the order is the security property:
 *
 *   1. `resolveWithin` — reused verbatim. Every refusal it produces keeps its existing reason,
 *      message and meaning.
 *   2. `lstat` — a file deleted between listing and clicking is `not-found`, stated, rather than a
 *      spawn that answers with the OS's own sentence about a path the reader did not type.
 *   3. The platform check — off Darwin this refuses with a reason instead of an `ENOENT` that reads
 *      as a missing file.
 *   4. The spawn — detached, `stdio: "ignore"`, `unref`ed. Not `spawnSync`: `open` hands off to
 *      `launchd` and returns, and a synchronous spawn inside the transport's handler would stall every
 *      other client for the length of a cold Finder launch.
 */
export function revealInFileManager(
  root: string,
  relative: string,
  options: RevealOptions = {},
): OsActionResult {
  const resolved = resolveWithin(root, relative);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { path: absolute, relPath } = resolved.value;

  // Between the listing and the click the entry may be gone. Reported BEFORE the spawn, so the reader
  // is told what happened instead of receiving `open`'s sentence about a path they never typed.
  //
  // This is a second pair of eyes rather than the primary guard, and saying so is the point: the deleted
  // case is ALREADY answered by `resolveWithin` above, whose `realpathSync` fails with `ENOENT` on a path
  // that is no longer there — measured, and the test for a deleted file passes with or without this call.
  // What `lstat` adds is the window between that `realpath` and this line, which no test can drive
  // deterministically without a seam this module does not want. Kept because ADR-0014 rule 6 names it, and
  // because a future change to `resolveWithin` (a cached realpath, say) would otherwise silently remove the
  // guarantee the record believed it had.
  try {
    lstatSync(absolute);
  } catch (error) {
    return { ok: false, error: fromErrno(error, "cannot reveal", `"${relPath}"`) };
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      ok: false,
      error: {
        reason: "unsupported-platform",
        message: `showing a file in the file manager is a macOS feature, and this orchestrator is running on ${platform} (C10)`,
      },
    };
  }

  const openPath = options.openPath ?? OPEN_PATH;
  const report = options.onLaunchError;
  const child = spawn(openPath, revealArgv(absolute), {
    stdio: "ignore",
    // Detached so the launcher is not a child this process has to reap, and so a slow Finder does not
    // hold the orchestrator open. `unref` below is what actually lets this process exit while it runs.
    detached: true,
  });

  // The child could not be started at all: a missing binary, or one that is not executable.
  child.on("error", (error: NodeJS.ErrnoException) => {
    report?.({
      reason: "unreadable",
      ...(error.code === undefined ? {} : { code: error.code }),
      message: `cannot show "${relPath}" in the file manager: ${openPath} could not be started (${error.code ?? String(error)})`,
    });
  });

  /*
   * A non-zero exit is a CONFIRMED failure and is reported as one.
   *
   * `exit` rather than `close`, because `stdio` is `"ignore"` and there are no streams to drain. The
   * success case attaches no listener and reports nothing, on purpose: this module makes no claim that
   * anything was displayed (ADR-0014, rule 6).
   */
  child.on("exit", (code, signal) => {
    if (code === 0 || code === null) return;
    report?.({
      reason: "unreadable",
      message:
        `${openPath} refused to show "${relPath}" (exit ${code}` +
        `${signal === null ? "" : `, ${signal}`})`,
    });
  });

  child.unref();
  return { ok: true };
}
