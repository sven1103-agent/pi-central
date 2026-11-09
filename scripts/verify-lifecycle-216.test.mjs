#!/usr/bin/env node
/**
 * The verification script must use the product's identity rule, not a copy of it
 * (issue #216).
 *
 * ## The defect this exists for, which shipped
 *
 * `scripts/verify-lifecycle-216.mjs` compared two readings of one process with `===` to prove a window close had not
 * disturbed it. It reported **FAIL** on a completely healthy orchestrator:
 *
 *     FAIL  1. the orchestrator is untouched by a window close (same PID, still serving)
 *           pid 33559 changed start time or vanished
 *
 * The readings are `Date.now() - etime`, and `etime` is truncated to whole seconds, so two probes taken 300 ms apart
 * can legitimately differ by a full second while describing the same process. The *product* has always been right about
 * this — `identityHolds` allows a two-second tolerance, and `decideAttach` uses it. The script re-implemented the
 * comparison and dropped the tolerance with it.
 *
 * ## Why it shipped, and why this file is the fix
 *
 * The bug was invisible in the environment it was written in: `/bin/ps` is refused inside an agent sandbox (C16), so
 * criterion 1 could only ever reach its `CANNOT` branch there. A checker whose passing branch cannot be executed is a
 * checker that is not tested, and the failure it finally produced was read by someone else.
 *
 * A source assertion is the cheap guard for that class: it cannot prove the script's checks are *correct*, but it can
 * prove the script does not re-derive a rule the product already owns — which is the specific mistake.
 *
 * Run by `npm test` (the `scripts/**\/*.test.mjs` glob), so it fails in CI rather than in someone's terminal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = readFileSync(join(ROOT, "scripts", "verify-lifecycle-216.mjs"), "utf8");

test("the lifecycle script compares process identity with the product's rule, not with `===`", () => {
  /*
   * The exact shape of the bug: `before.marks === after.marks`. Any comparison of two `marks` values by equality is the
   * defect, so the assertion is on the shape rather than on the one line that got it wrong.
   */
  assert.equal(
    /\.marks\s*===\s*\w+\.marks/.test(SCRIPT),
    false,
    "compare process identity with `identityHolds`, which allows for `etime`'s one-second resolution",
  );
  assert.equal(SCRIPT.includes("identityHolds"), true, "the script imports and uses the product's identity rule");
});

test("the lifecycle script drives the app's own decisions rather than re-implementing them", () => {
  // The same reasoning one level up: every decision the script checks must come from the module the app uses, because a
  // second implementation is a second thing to be wrong — and it would agree with itself by construction.
  for (const fn of ["decideAttach", "decideStop", "stopDialog", "askLiveSessions", "writeRuntimeRecord", "readRuntimeRecord"]) {
    assert.equal(SCRIPT.includes(fn), true, `the script must use ${fn} rather than its own version`);
  }
  // And it must not re-derive the stop question's contents: the dialog is data, built once, by `stopDialog`.
  assert.equal(/stopQuestion\s*\(/.test(SCRIPT), false, "the dialog comes from `stopDialog`, not hand-built");
});

test("a check that could not be made is never counted as a pass", () => {
  /*
   * The rule that keeps the script honest. `CANNOT` exists because two criteria need facts a restricted host will not
   * give (C16's probe, C1's nesting), and collapsing those into `PASS` would make the script claim success for a check
   * it did not run — the failure mode that makes a verification script worse than nothing.
   */
  assert.equal(SCRIPT.includes("CANNOT"), true, "the script reports an uncheckable fact as its own outcome");
  // And a CANNOT must not be pushed as a failure either: it is `ok` with `cannot` set, so it neither passes nor fails.
  assert.match(SCRIPT, /cannot: true/, "an uncheckable check is recorded distinctly");
  assert.match(SCRIPT, /const failed = results\.filter\(\(r\) => !r\.ok\)/, "only a real FAIL exits non-zero");
});
