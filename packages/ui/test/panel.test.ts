/**
 * Panel geometry and preferences (issue #8, reworked).
 *
 * These are the arithmetic and parsing halves of the resizable panel, tested directly because the
 * component tests render to static HTML and therefore execute no drag or key handlers. The bugs this
 * guards are the ones that are invisible in a screenshot: an inverted drag sign, a clamp that lets
 * the panel swallow the transcript, and a corrupt `localStorage` value collapsing the panel to zero.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FILES_SPLIT_MIN_WIDTH,
  PANEL_ABSOLUTE_MAX,
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_PREFS_KEY,
  clampPanelWidth,
  defaultPanelPrefs,
  panelMaxWidth,
  parsePanelPrefs,
  resizePanelBy,
  resizePanelTo,
  serializePanelPrefs,
} from "../src/panel.ts";

test("the panel can never be narrower than its floor, whatever is asked", () => {
  // A 0 or negative width collapses the panel to nothing, which reads as a bug in the app rather
  // than as a width the user chose.
  assert.equal(clampPanelWidth(0, 1600), PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(-500, 1600), PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(1, 1600), PANEL_MIN_WIDTH);
});

test("the panel can never take more than its share of the window", () => {
  // The transcript is the primary content. On a 1440px window the cap is 60% = 864px, so the
  // transcript keeps 576px and the rail; the point is that a drag cannot leave the transcript gone.
  assert.equal(clampPanelWidth(9999, 1440), Math.round(1440 * 0.6));
  assert.ok(clampPanelWidth(9999, 1440) < 1440, "the panel must not be able to fill the window");
});

test("a very large window is still capped in absolute terms", () => {
  // 60% of 4000px is 2400px, which is more panel than any document needs and would push the
  // transcript to a sliver. The absolute ceiling is what stops that.
  assert.equal(clampPanelWidth(9999, 4000), PANEL_ABSOLUTE_MAX);
});

test("a tiny window degrades to the floor rather than to an inverted range", () => {
  // On a 400px window, 60% is 240px — BELOW the 280px floor. `panelMaxWidth` floors at the minimum,
  // so the window's max is never below the min and the range cannot invert.
  //
  // The clamp ORDER is therefore immaterial — `min(max, max(min, w))` and `max(min, min(max, w))` are
  // equivalent whenever `max >= min`, which was established by inverting it and watching the suite
  // still pass. This test pins the behaviour (never below the floor, never above the cap) rather than
  // the expression, which is the honest thing to assert. An earlier version of this comment claimed
  // the order mattered; it does not, and a false rationale is worse than none.
  const max = panelMaxWidth(400);
  assert.equal(max, PANEL_MIN_WIDTH, "the max must never fall below the min");
  assert.equal(clampPanelWidth(300, 400), PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(0, 400), PANEL_MIN_WIDTH);
  assert.equal(clampPanelWidth(9999, 400), PANEL_MIN_WIDTH);
});

test("dragging right narrows the panel, because the handle is on its LEFT edge", () => {
  // The sign that is easiest to invert and hardest to notice. `resizePanelBy` takes a pointer delta
  // in the conventional direction (positive = right) and inverts it once, here.
  assert.equal(resizePanelBy(600, 100, 1600), 500);
  assert.equal(resizePanelBy(600, -100, 1600), 700);
  assert.equal(resizePanelBy(600, 0, 1600), 600);
});

test("arrow keys widen with LEFT and narrow with RIGHT, matching the handle", () => {
  assert.equal(resizePanelTo("ArrowLeft", 600, 1600), 616);
  assert.equal(resizePanelTo("ArrowRight", 600, 1600), 584);
});

test("Home is the minimum and End is the maximum", () => {
  // Follows the slider convention. These are NOT routed through `clampPanelWidth(Infinity, …)`,
  // whose non-finite guard returns the default — which would have made `End` jump to 360px.
  assert.equal(resizePanelTo("Home", 600, 1600), PANEL_MIN_WIDTH);
  assert.equal(resizePanelTo("End", 600, 1600), panelMaxWidth(1600));
  assert.notEqual(resizePanelTo("End", 600, 1600), PANEL_DEFAULT_WIDTH);
});

test("a non-finite width falls back to the default instead of collapsing the panel", () => {
  // `NaN` in a CSS grid track makes the column vanish with no error anywhere. Reachable from a
  // corrupt stored value or a `NaN` delta, so it is handled rather than assumed away.
  assert.equal(clampPanelWidth(Number.NaN, 1600), PANEL_DEFAULT_WIDTH);
  assert.equal(clampPanelWidth(Number.POSITIVE_INFINITY, 1600), PANEL_DEFAULT_WIDTH);
  assert.equal(clampPanelWidth(Number.NEGATIVE_INFINITY, 1600), PANEL_DEFAULT_WIDTH);
});

test("preferences round-trip through their serialized form", () => {
  const prefs = { width: 512, mode: "files" as const, userSized: true, collapsed: false };
  assert.deepEqual(parsePanelPrefs(serializePanelPrefs(prefs)), prefs);
});

test("a corrupt or absent stored value degrades to the default, never throws", () => {
  // `localStorage` is shared with whatever else runs on this origin and survives upgrades, so none
  // of these are hypothetical: a half-written value from a crash, an old shape, a hand-edited one.
  for (const raw of [null, "", "not json", "[]", "null", '"files"', "42", "{}"]) {
    const parsed = parsePanelPrefs(raw);
    assert.equal(parsed.mode, "session", `mode must fall back for ${JSON.stringify(raw)}`);
    assert.equal(typeof parsed.width, "number", `width must be a number for ${JSON.stringify(raw)}`);
    assert.equal(parsed.userSized, false, `userSized must default false for ${JSON.stringify(raw)}`);
  }
});

test("an unrecognised mode falls back rather than rendering nothing", () => {
  // A mode that no longer exists must not leave the panel body blank — that is the same class of
  // bug as an unloaded directory rendering as empty.
  const parsed = parsePanelPrefs(JSON.stringify({ mode: "changes", width: 400, userSized: true }));
  assert.equal(parsed.mode, "session");
  assert.equal(parsed.width, 400, "the valid fields must still be honoured");
});

test("the split breakpoint in the stylesheet matches the one in the code", () => {
  // `styles.css` cannot import TypeScript, so the container-query breakpoint is written there by
  // hand. A silent disagreement between the two would mean the panel switches layout at a width
  // nobody documented — the same "one value, two formats" failure as the inspector's `127.2M`
  // beside a raw `12723914`. Asserted as a blunt text match on purpose.
  // Comments stripped: a phrase in a comment must not be able to satisfy a declaration assertion.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(
    css,
    new RegExp(`min-width:\\s*${FILES_SPLIT_MIN_WIDTH}px`),
    `styles.css must contain a container query at ${FILES_SPLIT_MIN_WIDTH}px`,
  );
});

test("the stored key is namespaced, so it cannot collide with another app on this origin", () => {
  assert.match(PANEL_PREFS_KEY, /^pi-central\./);
});

// --- The panel is collapsed by default (issue #75) --------------------------------------------------

test("a fresh preference set is COLLAPSED", () => {
  // The default experience: the transcript is the primary surface, and the panel is a
  // special-purpose view. Asserted on the default itself, because this is the decision the issue
  // makes and a `false` here would silently restore the old behaviour.
  assert.equal(defaultPanelPrefs().collapsed, true);
  assert.equal(parsePanelPrefs(null).collapsed, true);
  assert.equal(parsePanelPrefs("").collapsed, true);
});

test("a stored value with no `collapsed` field is collapsed, not expanded", () => {
  // The upgrade path, and the case that decides whether the default actually changes for anyone who
  // used an earlier build. Absent must mean the NEW default: an `=== true` test here would open the
  // panel for every existing user, which is the opposite of the issue.
  const legacy = JSON.stringify({ width: 400, mode: "files", userSized: true });
  const parsed = parsePanelPrefs(legacy);
  assert.equal(parsed.collapsed, true);
  // …and the rest of the stored preferences still survive, so re-opening restores the geometry.
  assert.equal(parsed.width, 400);
  assert.equal(parsed.mode, "files");
  assert.equal(parsed.userSized, true);
});

test("only an explicit `false` opens the panel", () => {
  // So that an unrecognised value — a string, a number, an object from a future shape — degrades to
  // the default rather than being read as permission to expand.
  assert.equal(parsePanelPrefs(JSON.stringify({ collapsed: false })).collapsed, false);
  assert.equal(parsePanelPrefs(JSON.stringify({ collapsed: true })).collapsed, true);
  assert.equal(parsePanelPrefs(JSON.stringify({ collapsed: "false" })).collapsed, true);
  assert.equal(parsePanelPrefs(JSON.stringify({ collapsed: 0 })).collapsed, true);
  assert.equal(parsePanelPrefs(JSON.stringify({ collapsed: null })).collapsed, true);
});

test("the collapsed flag round-trips, so the toggle is remembered", () => {
  const open = { width: 360, mode: "session" as const, userSized: false, collapsed: false };
  assert.deepEqual(parsePanelPrefs(serializePanelPrefs(open)), open);
});
