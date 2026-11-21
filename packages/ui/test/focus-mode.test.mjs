/**
 * Reading focus: the window is the conversation (issue #275, second slice).
 *
 * ## What this file is guarding
 *
 * The mode removes chrome, which is the easy direction to get wrong. Two failures are one CSS rule away, and neither
 * shows up as an error:
 *
 *   1. **A trap.** Hide everything and the session's identity, model and controls are gone with no way back. The rule
 *      chosen is that focus mode hides only surfaces that ARE elsewhere — the Session panel states the session's facts
 *      and controls, and the activity bars stay because they are the way out.
 *   2. **A mode that eats the conversation.** Anything that shortens the reading surface is not focus, it is damage.
 *      The lane's measure and the composer's place are asserted UNCHANGED, which is what makes this a mode.
 *
 * The reachability claim is the one a stylesheet cannot make on its own, so it is also asserted at the shell: hiding a
 * region must leave the control that restores it rendered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appClass, defaultRailPrefs, parseRailPrefs, serializeRailPrefs } from "../src/rail-prefs.ts";
import { SHORTCUTS } from "../src/shortcuts.ts";

const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const app = read("App.tsx");

/** The declarations of the rule whose selector is exactly `selector`, LAST match (cascade order). */
function rule(selector) {
  const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`^${wanted}\\s*\\{([^}]*)\\}`, "gm"))];
  return all.length > 0 ? all.at(-1)[1] : undefined;
}

test("focus mode is OFF by default, and survives a round trip", () => {
  /*
   * The acceptance criterion every preference in this app carries since `reading.ts`: a reader who touches nothing sees
   * the shipped app. Falsified by defaulting `focus` to true — the first assertion reports a mode nobody asked for.
   */
  assert.equal(defaultRailPrefs().focus, false, "the shipped default is the full chrome");
  assert.equal(parseRailPrefs(serializeRailPrefs({ ...defaultRailPrefs(), focus: true }), 0).focus, true, "it round-trips");
  // Only the boolean counts; `"true"` is a reachable stored value and must not switch a mode on.
  assert.equal(parseRailPrefs('{"focus":"true"}', 0).focus, false);
  assert.equal(parseRailPrefs("{not json", 99).focus, false, "a corrupt record does not enter the mode");
});

test("the shell puts the mode on the app root as ONE class", () => {
  /*
   * One switch, one place. A prop threaded through four components would spread "what does focus do" over four files
   * and make it unanswerable by reading the stylesheet.
   *
   * Falsified by `appClass` returning the base unchanged: every rule below would be dead, and the mode a no-op.
   */
  assert.equal(appClass("app", defaultRailPrefs()), "app");
  assert.equal(appClass("app", { ...defaultRailPrefs(), focus: true }), "app is-focus");
  assert.match(app, /className=\{appClass\("app", railPrefs\)\}/, "the shell is the one writer");
});

test("focus mode hides the CHROME, and nothing that is the conversation", () => {
  /*
   * The dividing line, asserted in both directions. What goes: the fleet counters (the rail's business), the session
   * header band (the panel states the same facts with room to read them), the permanent hint row.
   *
   * What must NOT be governed by `is-focus`: the reading lane, the composer's field, the transcript's scroller. A rule
   * that narrowed the measure in this mode would make the conversation smaller in the mode named after it.
   *
   * Falsified by adding `.app.is-focus .transcript-lane { max-width: … }` — the negative assertion reports it.
   */
  assert.match(rule(".app.is-focus .topbar .fleet") ?? "", /display:\s*none/, "the fleet counts fold away");
  assert.match(rule(".app.is-focus .transcript-header") ?? "", /display:\s*none/, "the companion band leaves the row");
  assert.match(rule(".app.is-focus .composer-hint") ?? "", /display:\s*none/, "and so does the permanent hint line");

  for (const forbidden of [".transcript-lane", ".transcript-main", ".composer", ".transcript", ".composer-input"]) {
    const scoped = rule(`.app.is-focus ${forbidden}`);
    assert.ok(!scoped, `${forbidden} must not be governed by focus mode — the conversation is what the mode is FOR`);
  }
});

test("focus mode is not a trap: the way out and the way to the facts both survive", () => {
  /*
   * The failure this guards is the one that makes a mode unacceptable rather than merely opinionated: hide the session
   * header and every way to reach the session's controls with it.
   *
   * Two facts are asserted, and they are different:
   *
   *   - the ACTIVITY BARS are not hidden (they are the way back), only narrowed;
   *   - the session's facts and controls live in the Session PANEL, which focus mode does not touch — which is why the
   *     header may leave rather than merely shrink.
   *
   * Falsified by adding `.app.is-focus .navrail { display: none }`: the bar assertion reports a mode with no exit.
   */
  assert.ok(!/display:\s*none/.test(rule(".app.is-focus .navrail") ?? ""), "the bars stay: they are the way back");
  assert.match(rule(".app.is-focus .navrail") ?? "", /width:\s*36px/, "narrowed, not removed");
  // And the component that holds the controls is not governed by the mode at all.
  assert.equal(rule(".app.is-focus .panel"), undefined, "the panel is untouched, so the controls are one click away");
});

test("focus mode keeps the lane where it was, and only takes the companion’s track", () => {
  /*
   * The reader’s report, in one property: with the header hidden the conversation must stay at the same x. It had
   * moved left, because the row still reserved the companion’s trailing track for an element that was `display: none`
   * — so the pair-centring arithmetic still included a box nobody could see.
   *
   * The rule is deliberately the same three tracks with a trailing `1fr` in place of the 340px: the lane keeps the
   * MIDDLE track, so hiding the companion cannot move the prose by a single pixel. That is what makes this a mode
   * around the conversation rather than a rearrangement of it.
   *
   * Falsified by dropping the override: the stylesheet’s wide rule still names `340px`, and the lane sits
   * half-a-companion left of centre again — with 340px of nothing beside it.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const focusRow = /\.app\.is-focus \.transcript-wrap\.has-header\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(focusRow, "the mode must re-declare the tracks");
  /*
   * The same margin token and lane, with a `0px` where the companion was. Asserted structurally rather than by number:
   * what must not come back is the pair-centring, and what must survive is the lane’s own width.
   */
  assert.match(focusRow, /var\(--reading-margin\)\s+minmax\(0,\s*var\(--reading-lane\)\)\s+0px/, "the companion’s track collapses to zero");
  assert.match(focusRow, /--companion-width:\s*0px/, "and its width with it, so `fill` can take the whole row");
  // And the conversation itself is still not governed by the mode. This is the file’s other half, kept adjacent so
  // the pair reads together.
  for (const forbidden of [".transcript-lane", ".transcript-main", ".composer", ".transcript", ".composer-input"]) {
    assert.equal(rule(`.app.is-focus ${forbidden}`), undefined, `${forbidden} must not be governed by focus mode`);
  }
});

test("the keys are still stated, on the field that consumed the line", () => {
  /*
   * The hint row is the only written explanation of `Enter`/`Shift+Enter`, so a mode that folded it away would trade a
   * line of chrome for a piece of discoverability. It moves onto the field's `title`, in the same words.
   *
   * Falsified by removing the `title` from the textarea: the assertion reports a composer that no longer says how to
   * send.
   */
  const composer = read("components/Composer.tsx");
  assert.match(composer, /Enter to send · Shift\+Enter for a new line/, "the field states the keys");
  assert.match(composer, /Enter steers · Alt\+Enter queues/, "and the streaming variant");
  // Stated ONCE: the hint row and the title would otherwise be two copies that drift.
  assert.match(composer, /title=\{[\s\S]{0,240}?Enter to send/, "on the field's own title");
});

test("the mode has a key, and it is not the stop key", () => {
  /*
   * `⌘.` stops the run — the most consequential keystroke in the app. A view mode must not be one modifier away from it
   * by accident, so `⌘⇧.` takes the Shift: the same corner, a different thing, and pressing the wrong one costs a
   * confirmation rather than a silent stop.
   *
   * Falsified by registering `mod+.`: the two assertions then name the same chord, and `shortcuts.test.mjs` would report
   * a duplicate binding.
   */
  const focus = SHORTCUTS.find((shortcut) => shortcut.id === "view.focus");
  assert.ok(focus, "the mode is in the registry, so the sheet lists it");
  assert.deepEqual([...focus.keys], ["mod+shift+."]);
  const stop = SHORTCUTS.find((shortcut) => shortcut.id === "session.stop");
  assert.notDeepEqual([...focus.keys], [...stop.keys], "one keystroke, one meaning");
  // Dispatched by the shell, like every other window-level key.
  assert.equal(focus.shell, true);
  assert.match(app, /"view\.focus": \(\) => setRailPrefsAndPersist/, "and the shell handles it by id");
});

test("no other binding is registered twice, now that one more exists", () => {
  /*
   * The registry's own invariant, restated where a new entry is added — because the entry above is exactly the kind that
   * slips onto a taken chord (a punctuation key next to an existing one).
   */
  const seen = new Map();
  for (const shortcut of SHORTCUTS) {
    for (const chord of shortcut.keys) {
      assert.equal(seen.get(chord), undefined, `${chord} is bound to both ${seen.get(chord)} and ${shortcut.id}`);
      seen.set(chord, shortcut.id);
    }
  }
});
