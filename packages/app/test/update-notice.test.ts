/**
 * The update outcome must not take the window (issue #217).
 *
 * ## The defect, reported from a running app
 *
 * > The check for updates renders the dialog, the Update Pi Central path brings users into a dead end of the
 * > app, they cannot return from unless to restart the app.
 *
 * The screenshot showed a "There is no update to apply" failure page — a full-window `data:` document — with a
 * modal "Pi Central is up to date" dialog on top of it. Every update outcome had been routed through `showFailure`,
 * the page built for "the orchestrator could not start". That function:
 *
 *   - **replaces the window's document**, so the dashboard is destroyed even though the orchestrator is alive;
 *   - offers exactly one control, *Try again*, which calls `retry()` — and `retry()` refuses when an orchestrator is
 *     already running, so the button does nothing;
 *   - shows *"This text can be selected and copied"* and a failure heading for what is often a normal answer.
 *
 * The only way out was to quit the app. Three mistakes, each independently sufficient:
 *
 *   1. the wrong surface (a page that takes the window, for a message about an action);
 *   2. the wrong control (restart the orchestrator, for a failed update);
 *   3. a refusal painted as a failure ("there is no update because you are current" is a successful check).
 *
 * This file asserts the surface rule and the notices; `update-wiring.test.ts` asserts that no update path calls
 * `showFailure`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RETRY_UPDATE_BUTTON, mayReplaceWindow, updateNotice, wantsRetry } from "../src/update-notice.ts";

const MAIN = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

// -----------------------------------------------------------------------------------------------------------
// The surface rule, which is the whole defect.
// -----------------------------------------------------------------------------------------------------------

test("an update outcome may never replace the window, because the orchestrator is still running", () => {
  // The rule as a function, so the two cases cannot be conflated again by a future edit that reaches for the only
  // failure surface the file already has.
  assert.equal(mayReplaceWindow("launch-failure"), true, "a launch failure is what that page is for");
  assert.equal(mayReplaceWindow("update-outcome"), false, "an update outcome leaves a working app behind");
});

test("no update path calls showFailure, which is the dead end that was reported", () => {
  /*
   * The assertion is on the CALLS in the update region of `main.ts`, not on the whole file: `showFailure` remains
   * correct for the launch paths (a missing package, a child that died before announcing).
   *
   * The region is taken from the update section's banner comment to the menu builder, which contains every update
   * handler. A `showFailure(` in there is the reported bug returning.
   */
  const from = MAIN.indexOf("// Applying an update (issue #217");
  const to = MAIN.indexOf("/** The menu, which is the only way to reach the update path");
  assert.ok(from !== -1 && to > from, "the update section is still identifiable");
  const updateSection = MAIN.slice(from, to);

  // Comments explain why `showFailure` is wrong here and legitimately mention it; only invocations are failures.
  const calls = [...updateSection.matchAll(/showFailure\s*\(/g)].length;
  assert.equal(calls, 0, `an update outcome reached showFailure, which takes the window: ${calls} call(s)`);
  // And the notice surface is what it uses instead.
  assert.equal(updateSection.includes("showNotice("), true, "update outcomes go through the dialog surface");
});

test("the update path never calls `retry()`, which restarts the ORCHESTRATOR", () => {
  // The other half of the dead end: `Try again` on the failure page calls `retry()`, which refuses while an
  // orchestrator is running. An update retry must re-run the UPDATE, never the launch.
  const from = MAIN.indexOf("// Applying an update (issue #217");
  const to = MAIN.indexOf("/** The menu, which is the only way to reach the update path");
  const updateSection = MAIN.slice(from, to);
  /*
   * Comments are stripped before the check, because the section legitimately *mentions* `retry()` in the explanation of
   * why the failure page was the wrong surface. Asserting on raw text would fail on the documentation of the fix — the
   * same trap `update-safety.test.ts` hit when it matched `http://host:port` in an error message.
   */
  const codeOnly = updateSection
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.equal(/[^a-zA-Z._]retry\(\)/.test(codeOnly), false, "an update must not restart the orchestrator");
});

// -----------------------------------------------------------------------------------------------------------
// The notices themselves.
// -----------------------------------------------------------------------------------------------------------

test("every notice is dismissible with OK, and never defaults to a destructive or re-running action", () => {
  const kinds = ["update-available", "up-to-date", "nothing-to-apply", "managed-elsewhere", "failed", "check-failed"] as const;
  for (const kind of kinds) {
    const notice = updateNotice(kind, { runningVersion: "0.10.0", canRetry: true });
    assert.equal(notice.buttons[0], "OK", `${kind}: the first button is OK`);
    assert.equal(notice.buttons[notice.defaultId], "OK", `${kind}: Return is OK`);
    assert.equal(notice.buttons[notice.cancelId], "OK", `${kind}: a dismissal is OK, so the dashboard comes back`);
    assert.equal(notice.noLink, true);
  }
});

test("a failed update offers a retry, and the retry is NOT the default", () => {
  // An accidental Return must not re-run `npm`, so the retry is the second button and `defaultId` stays 0.
  const notice = updateNotice("failed", { runningVersion: "0.10.0", detail: "npm exited 1", canRetry: true });
  assert.deepEqual(notice.buttons, ["OK", RETRY_UPDATE_BUTTON]);
  assert.equal(notice.defaultId, 0);
  assert.equal(wantsRetry(notice, 0), false, "OK does not retry");
  assert.equal(wantsRetry(notice, 1), true, "the second button does");
  // An out-of-range response must never be read as a retry.
  assert.equal(wantsRetry(notice, 7), false);
});

test("a version mismatch offers NO retry, because re-running npm over a half-install is worse", () => {
  // `canRetry` is false for a mismatch: the package on disk is already the wrong version, and re-running the install
  // is a different operation from re-running it over an untouched tree.
  const notice = updateNotice("failed", { runningVersion: "0.10.0", detail: "landed 0.10.0", canRetry: false });
  assert.deepEqual(notice.buttons, ["OK"]);
  assert.equal(wantsRetry(notice, 1), false);
});

test("every notice says what is still running and that nothing was changed", () => {
  // The two facts a reader needs after an update they asked for did not happen. Their absence is what makes a message
  // feel like a crash report.
  for (const kind of ["nothing-to-apply", "managed-elsewhere", "failed"] as const) {
    const notice = updateNotice(kind, { runningVersion: "0.10.0", detail: "a reason" });
    assert.equal(notice.detail.includes("0.10.0"), true, `${kind}: names the running version`);
    assert.match(notice.detail, /Nothing was changed/, `${kind}: says nothing was changed`);
  }
});

test("a current installation is an INFO notice, not a failure", () => {
  // Mistake 3: "there is no update because you are current" is a successful check. Painting it as an error trains
  // the reader to read a normal answer as a fault.
  const notice = updateNotice("up-to-date", { runningVersion: "0.10.0" });
  assert.equal(notice.type, "info");
  assert.equal(notice.message, "Pi Central is up to date");
  assert.equal(/fail|error|could not/i.test(notice.message + notice.detail), false);
});

test("a refusal that is not 'up to date' is a WARNING with its reason, not a false 'up to date'", () => {
  // A downgrade refused, or a malformed registry answer: neither is "you are current", and neither is a fault. The
  // reason travels verbatim so the reader can act on it.
  const notice = updateNotice("nothing-to-apply", { runningVersion: "0.12.0", detail: "0.11.0 is older than the 0.12.0 that is running" });
  assert.equal(notice.type, "warning");
  assert.equal(notice.detail.includes("0.11.0 is older than the 0.12.0 that is running"), true);
  assert.equal(notice.message, "There is no update to apply");
});

test("a managed-elsewhere notice carries the owner's own instructions", () => {
  // The refusal from `installation-owner.ts` already names the command (`brew upgrade`, `npm unlink -g …`). The notice
  // must not paraphrase it — that text is the actionable part.
  const notice = updateNotice("managed-elsewhere", {
    runningVersion: "0.10.0",
    detail: "This Pi Central was installed by Homebrew, so Homebrew decides.\n\n  brew upgrade pi-central",
  });
  assert.equal(notice.detail.includes("brew upgrade pi-central"), true);
  assert.equal(notice.type, "warning");
});

test("a failed check says nothing was changed and names a terminal alternative", () => {
  const notice = updateNotice("check-failed", { detail: "npm error network request failed" });
  assert.equal(notice.type, "error");
  assert.equal(notice.detail.includes("npm error network request failed"), true);
  assert.match(notice.detail, /Nothing was changed/);
  // The reader whose app cannot reach the registry still has a shell.
  assert.match(notice.detail, /npm view pi-central version/);
});

test("an available update says what is available and that sessions will restart", () => {
  const notice = updateNotice("update-available", { runningVersion: "0.10.0", availableVersion: "0.11.0" });
  assert.match(notice.message, /Pi Central 0\.11\.0 is available/);
  assert.match(notice.detail, /0\.10\.0/);
  // The consequence that is not obvious, and that criterion 4's dialog repeats at confirmation time.
  assert.match(notice.detail, /session will be too|will be restarted/);
});

test("a notice with no known version still reads as a sentence", () => {
  // `readRunningVersion` returns "unknown" when the package cannot be resolved — a notice must not render "Running ,".
  for (const kind of ["up-to-date", "nothing-to-apply", "failed"] as const) {
    const notice = updateNotice(kind, { runningVersion: undefined, detail: "a reason" });
    assert.equal(/Running\s*[,.]/.test(notice.detail), false, `${kind}: no dangling "Running ,"`);
    assert.equal(/^,/.test(notice.detail), false, `${kind}: no leading comma`);
  }
});

test("the check action releases its guard before handing off to the update", () => {
  /*
   * A real bug, found by reading the flow after the dead end was reported: `checkForUpdateFromMenu` sets
   * `updating = true`, and `applyUpdateFromMenu` begins with `if (updating) return;`. So a check that FOUND a newer
   * version silently did nothing — no dialog, no error, no log, just a menu item that appeared to work.
   *
   * Asserted by position: the `updating = false` that precedes the handoff must come before the call.
   */
  const fn = MAIN.slice(MAIN.indexOf("async function checkForUpdateFromMenu"), MAIN.indexOf("async function applyUpdateFromMenu"));
  const handoff = fn.indexOf("applyUpdateFromMenu(");
  assert.notEqual(handoff, -1, "the check action hands off to the update");
  const releasedBefore = fn.lastIndexOf("updating = false", handoff);
  assert.notEqual(releasedBefore, -1, "the guard is released before the handoff, or the update refuses itself");
  // And the release is not inside a `finally` that only runs after the call returns.
  const between = fn.slice(releasedBefore, handoff);
  assert.equal(between.includes("}"), false, "the release is not buried in a block that ends before the call");
});

test("the check action never installs by itself, only hands off to the update action", () => {
  /*
   * ADR-0011 §4: detect freely, apply only on request. The check action reports what it found and hands off to
   * `applyUpdateFromMenu`, which shows its own confirmation — so "check" cannot install anything on its own, and the
   * reader still gets the dialog that names the sessions to be restarted.
   *
   * Asserted as an absence: no `applyUpdate(` here, and no direct call to the install. The presence of the handoff is
   * pinned by the previous test, so this one only rules out the shortcut.
   */
  const fn = MAIN.slice(MAIN.indexOf("async function checkForUpdateFromMenu"), MAIN.indexOf("async function applyUpdateFromMenu"));
  assert.equal(fn.includes("applyUpdate("), false, "the check action never applies an update itself");
  assert.equal(fn.includes("runInstall"), false);
  assert.equal(fn.includes("installCommand("), false, "and never builds an install command");
  // It does report, which is what detection is for.
  assert.equal(fn.includes("checkLatestVersion("), true);
});
