/**
 * The session rail's geometry, preferences and density rule (issue #275).
 *
 * Tested directly rather than through the component, for the reason `panel.test.ts` gives: the component tests
 * render to static HTML and execute no pointer or key handlers, so the arithmetic — an inverted drag sign, a clamp
 * that lets the rail swallow the transcript, a corrupt `localStorage` value — is invisible there.
 *
 * Each test states what it would take to make it fail. Two of them are deliberately two-sided
 * (`showsRowMetrics`), because a rule that is only pinned in one direction can be satisfied by a constant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RAIL_CALM_ROSTER_THRESHOLD,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  RAIL_PREFS_KEY,
  clampRailWidth,
  defaultRailPrefs,
  initialRailPrefs,
  isFolded,
  parseRailPrefs,
  railMaxWidth,
  railStyle,
  resizeRailBy,
  resizeRailTo,
  serializeRailPrefs,
  showsRowMetrics,
  toggleFolded,
} from "../src/rail-prefs.ts";

test("the rail can never be narrower than its floor, whatever is asked", () => {
  // A 0 or negative width collapses the list to nothing, which reads as a broken app rather than as a width someone
  // chose. Falsified by removing the `Math.max(RAIL_MIN_WIDTH, …)` in `clampRailWidth`.
  assert.equal(clampRailWidth(0, 1600), RAIL_MIN_WIDTH);
  assert.equal(clampRailWidth(-500, 1600), RAIL_MIN_WIDTH);
  assert.equal(clampRailWidth(1, 1600), RAIL_MIN_WIDTH);
});

test("the rail can never take more than its share of the window", () => {
  /*
   * The transcript is the primary surface, so a drag cannot leave it gone. On a 1440px window the cap is 40% = 576px,
   * which the absolute maximum then lowers to 480.
   *
   * On a NARROW window the fraction is the binding constraint, and that is the case worth asserting separately: at
   * 1200px, 40% is 480 — still the absolute cap — but at 700px it is 280, so the rail stops well short of its
   * 480px ceiling. Falsified by dropping the viewport term from `railMaxWidth`.
   */
  assert.equal(clampRailWidth(9999, 1600), RAIL_MAX_WIDTH);
  assert.equal(railMaxWidth(1600), RAIL_MAX_WIDTH);
  assert.equal(railMaxWidth(1200), RAIL_MAX_WIDTH);
  assert.ok(railMaxWidth(700) < RAIL_MAX_WIDTH, "a narrow window caps the rail below its absolute maximum");
  // The floor wins on a window too narrow for the fraction to reach it: 40% of 400 is 160, which is below the floor.
  assert.equal(railMaxWidth(400), RAIL_MIN_WIDTH);
  assert.equal(clampRailWidth(9999, 400), RAIL_MIN_WIDTH);
});

test("a non-finite width is 'no opinion', not a collapsed rail", () => {
  /*
   * `NaN` in a grid track silently collapses the column and there is no error to notice — the reason `panel.ts`
   * carries the same guard. Falsified by removing the `Number.isFinite` branch: `clampRailWidth(NaN, …)` then
   * returns `NaN`, and the style it produces is `NaNpx`.
   */
  assert.equal(clampRailWidth(Number.NaN, 1440), RAIL_DEFAULT_WIDTH);
  assert.equal(clampRailWidth(Number.POSITIVE_INFINITY, 1440), RAIL_DEFAULT_WIDTH);
});

test("dragging RIGHT grows the rail, which is the opposite of the panel", () => {
  /*
   * The panel sits on the right with its handle on its left edge, so a rightward drag SHRINKS it. The rail sits on
   * the left with its handle on its right edge, so the same gesture GROWS it. Copying the panel's sign is the obvious
   * mistake, and it is the one this test exists for: an inverted drag is a defect a reader feels immediately and a
   * screenshot cannot show.
   *
   * Falsified by making `resizeRailBy` subtract the delta.
   */
  assert.equal(resizeRailBy(288, 40, 1440), 328);
  assert.equal(resizeRailBy(288, -40, 1440), 248);
});

test("the keyboard moves the rail by one step, and Home/End are the extremes", () => {
  /*
   * `Home` is the MINIMUM and `End` the maximum, following the slider convention. Both are asserted as literal
   * values into `resizeRailTo` — the version that routed them through `clampRailWidth(Infinity, …)` returned the
   * DEFAULT for `End`, so "go to the widest" jumped to 288px. Falsified by that change.
   */
  assert.equal(resizeRailTo("ArrowRight", 288, 1440), 304);
  assert.equal(resizeRailTo("ArrowLeft", 288, 1440), 272);
  assert.equal(resizeRailTo("Home", 400, 1440), RAIL_MIN_WIDTH);
  assert.equal(resizeRailTo("End", 288, 1440), RAIL_MAX_WIDTH);
});

test("an unreadable preference degrades to the OPEN default, not to a folded one", () => {
  /*
   * Two different failures, deliberately answered differently:
   *
   *   - CORRUPT (`"{not json"`, a string width, `"hidden": "false"`) → the plain default, because a value nobody
   *     can read must not hide rows;
   *   - ABSENT (`null`) → `initialRailPrefs`, because "this reader has never chosen" is a different fact and the
   *     roster's size may legitimately decide.
   *
   * Falsified by treating a parse failure as `initialRailPrefs(99)`: the first assertion then reports folded
   * sections, i.e. rows hidden on the strength of a damaged record.
   */
  for (const corrupt of ["{not json", "[]", '"nope"', "null", "{}\u0000"]) {
    const prefs = parseRailPrefs(corrupt, 99);
    assert.equal(prefs.density, "full", `${corrupt}: full density`);
    assert.equal(prefs.hidden, false, `${corrupt}: visible`);
    assert.deepEqual(prefs.collapsed, { idle: false, stopped: false }, `${corrupt}: nothing folded`);
  }
  // A stored `"false"` is a reachable value (a hand-edited record, or a client that serialised the string) and it
  // must not mean hidden.
  assert.equal(parseRailPrefs('{"hidden":"false"}', 0).hidden, false);
  assert.equal(parseRailPrefs('{"hidden":"true"}', 0).hidden, false, "only the boolean counts");
});

test("a stored preference always wins over the roster-size default", () => {
  /*
   * The upgrade path. A reader with twelve sessions who has opened their sections must not have them closed again by
   * the heuristic on the next launch — the heuristic is only for a reader who has never chosen.
   *
   * Falsified by `parseRailPrefs` calling `initialRailPrefs(rowsOnDisk)` on the parsed branch too: the stored
   * `{idle:false}` would then be replaced by the heuristic's `{idle:true}`.
   */
  const stored = serializeRailPrefs({ ...defaultRailPrefs(), collapsed: { idle: false, stopped: true } });
  const prefs = parseRailPrefs(stored, 99);
  assert.deepEqual(prefs.collapsed, { idle: false, stopped: true }, "the reader's own choice, not the heuristic");
});

test("a large roster starts folded, and a small one does not", () => {
  /*
   * The one place the app chooses for the reader, and it is argued in `initialRailPrefs`: at the reported twelve
   * sessions the rail cost roughly thirty-three lines of chrome beside an empty transcript. The threshold is asserted
   * from both sides, so this cannot be satisfied by always folding or always opening.
   *
   * Falsified by returning `prefs` unconditionally (the large case fails) or by folding unconditionally (the small
   * case fails).
   */
  assert.deepEqual(initialRailPrefs(0).collapsed, { idle: false, stopped: false }, "a fresh install is open");
  assert.deepEqual(
    initialRailPrefs(RAIL_CALM_ROSTER_THRESHOLD).collapsed,
    { idle: false, stopped: false },
    "at the threshold, still open",
  );
  assert.deepEqual(
    initialRailPrefs(RAIL_CALM_ROSTER_THRESHOLD + 1).collapsed,
    { idle: true, stopped: true },
    "one past it, folded",
  );
});

test("only Idle and Stopped can fold, whatever a stored record says", () => {
  /*
   * `needs`, `failed` and `running` are not foldable, and the rule is a constraint rather than a default: a session
   * blocked on a dialog cannot progress without the reader, and a session that is spending money must stay on screen.
   * The TYPE says so, and this test says so at runtime too, because a stored record is untrusted input.
   *
   * Falsified by `isFolded` returning `prefs.collapsed[group] === true` without the group guard: a record naming
   * `running` would then hide the one section that must never hide.
   */
  const prefs = { ...defaultRailPrefs(), collapsed: { idle: true, stopped: false } };
  assert.equal(isFolded(prefs, "idle"), true);
  assert.equal(isFolded(prefs, "stopped"), false);
  for (const group of ["needs", "failed", "running"]) {
    assert.equal(isFolded(prefs, group), false, `${group} is never folded`);
  }
  /*
   * And a toggle request for a non-foldable group is a no-op rather than a new state.
   *
   * Cast, because the TYPE already refuses the call — which is the first line of defence and the reason the cast is
   * here rather than a widening of the parameter. What this asserts is the SECOND line: a stored record naming
   * `running` (untrusted input, which no type checks) must not fold it either.
   */
  const forged = { ...prefs, collapsed: { ...prefs.collapsed, running: true } } as typeof prefs;
  assert.equal(isFolded(forged, "running"), false, "a forged record cannot fold Running");
  const after = toggleFolded(forged, "running" as "idle");
  assert.deepEqual(after, forged, "nothing changed");
});

test("folding one section leaves the other alone", () => {
  // The obvious off-by-one in a two-key record. Falsified by `toggleFolded` replacing `collapsed` wholesale.
  const once = toggleFolded(defaultRailPrefs(), "idle");
  assert.deepEqual(once.collapsed, { idle: true, stopped: false });
  const twice = toggleFolded(once, "stopped");
  assert.deepEqual(twice.collapsed, { idle: true, stopped: true });
  const thrice = toggleFolded(twice, "idle");
  assert.deepEqual(thrice.collapsed, { idle: false, stopped: true });
});

test("CALM keeps the metrics that can change a decision, and drops the ones that cannot", () => {
  /*
   * The rule the screenshot asked for: eleven rows carried `ctx 0%`, `ctx 3%`, `ctx 0%`, `ctx 5%`… A gauge nobody
   * can act on is texture.
   *
   * BOTH directions are asserted, which is what makes this a rule rather than a lock: a constant `true` fails the
   * "nothing to act on" case, and a constant `false` fails the three cases that matter. Those three are the row's
   * stated reasons to act — pressure, queued work, failure.
   *
   * `isNearFull` owns the threshold, so this does not restate the number.
   */
  const calm = (session: { contextPercent: number | null; pending: number; state: string }) =>
    showsRowMetrics("calm", session);

  assert.equal(calm({ contextPercent: 3, pending: 0, state: "idle" }), false, "3% context is not a decision");
  assert.equal(calm({ contextPercent: 0, pending: 0, state: "streaming" }), false, "nor 0% on a running row");
  assert.equal(calm({ contextPercent: null, pending: 0, state: "idle" }), false, "nor an unmeasured one");

  assert.equal(calm({ contextPercent: 92, pending: 0, state: "streaming" }), true, "a nearly-full context is");
  assert.equal(calm({ contextPercent: 3, pending: 2, state: "streaming" }), true, "queued work is");
  assert.equal(calm({ contextPercent: 3, pending: 0, state: "failed" }), true, "a failure is");
});

test("FULL density shows the metrics line whenever there is a session", () => {
  /*
   * The default must be unchanged for a reader who never opens Settings — the acceptance criterion every preference
   * in this app has carried since `reading.ts`. Falsified by making `full` obey the calm rule.
   */
  assert.equal(showsRowMetrics("full", { contextPercent: 0, pending: 0, state: "idle" }), true);
  assert.equal(showsRowMetrics("full", { contextPercent: null, pending: 0, state: "streaming" }), true);
  // A row with no live session has no metrics at all, in either density: there is nothing to measure.
  assert.equal(showsRowMetrics("full", undefined), false);
  assert.equal(showsRowMetrics("calm", undefined), false);
});

test("the style a preference set produces is ONE custom property", () => {
  /*
   * `--rail-width` and nothing else, matching the rule `--panel-width` established: the grid owns the track
   * definition and JavaScript writes one number. Falsified by emitting `--gauge-width` here — that token also sizes
   * the header's meter, so a rail preference would resize the header, the mistake `reading.ts` records for
   * `--reading-*`.
   */
  const style = railStyle({ ...defaultRailPrefs(), width: 340 });
  assert.deepEqual(Object.keys(style), ["--rail-width"]);
  assert.equal(style["--rail-width"], "340px");
});

test("the preference key is namespaced like every other one", () => {
  // A bare key would collide with whatever else runs on this origin, which is the reason the other two modules carry
  // the prefix.
  assert.equal(RAIL_PREFS_KEY, "pi-central.rail");
});
