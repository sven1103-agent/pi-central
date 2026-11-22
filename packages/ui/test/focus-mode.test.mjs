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
import { QUEUE_CHORD, chordOf, chordsOf, resolveShortcut, setKeyLayout, SHORTCUTS } from "../src/shortcuts.ts";

/** Nothing open, nothing focused: the state every chord is expected to work in unless it says otherwise. */
const closedGate = { modalOpen: false, keysOpen: false, sheetOpen: false, inField: false };

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
  const focus = { ...defaultRailPrefs(), focus: true };
  assert.equal(appClass("app", defaultRailPrefs(), true), "app", "off means the base class and nothing else");
  /*
   * `is-panel-closed` rides with the mode, and it is not cosmetic: focus mode hides the session header on the strength of
   * "the panel states the same facts", and `panel.ts` defaults to COLLAPSED — so without this class the mode removed the
   * only surface for Rename, Stop, Resume, Retry, Delete, the model and the thinking level. That shipped as *"i cant see
   * the action bars … where are they"*.
   */
  assert.equal(appClass("app", focus, true), "app is-focus is-panel-closed");
  assert.equal(appClass("app", focus, false), "app is-focus", "an open panel needs no exemption");
  assert.match(
    app,
    /className=\{appClass\("app", railPrefs, panel\.collapsed\)\}/,
    "the shell is the one writer, and it passes the panel's real state",
  );
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
  /*
   * The companion band leaves the row — conditionally, and the condition is the whole point. `:not(.is-panel-closed)` is
   * what stops the mode from removing the only surface that holds the session's controls.
   *
   * And it names the ROW's own item with a child combinator. `.transcript-header` is a FRAME class the peek overlay wears
   * on purpose, so a descendant selector hid the overlay's content too: with the panel open, hovering the tab opened a
   * 340px box containing nothing. Falsified by dropping the `>` — the frame assertion below then reads the shared class
   * and this fails.
   */
  assert.match(
    rule(".app.is-focus:not(.is-panel-closed) .transcript-wrap.has-header > .transcript-header") ?? "",
    /display:\s*none/,
    "the companion band leaves the row, but only when the panel is showing the same facts",
  );
  assert.equal(
    rule(".app.is-focus:not(.is-panel-closed) .transcript-header"),
    undefined,
    "and it must not reach the peek's copy of the same class, or the overlay opens empty",
  );
  assert.equal(
    rule(".app.is-focus .transcript-header"),
    undefined,
    "and there is no unconditional rule: an open panel is what earns the hiding",
  );
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
   * moved, because the row still reserved a trailing track for an element that was `display: none` — so the centring
   * arithmetic still included a box nobody could see.
   *
   * The rule is therefore the middle track with a SYMMETRIC margin on both sides (the same token twice), so hiding the
   * companion cannot move the prose by a pixel. That is what makes this a mode around the conversation rather than a
   * rearrangement of it.
   *
   * Falsified by dropping the override: the wide rule names `--reading-trailing` — `minmax(0, 1fr)` while centred,
   * which is only symmetric because the companion sits in it. Hiding the companion leaves that track flexible with
   * nothing in it, and under `fill` it leaves 364px of void.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const focusRow = /\.app\.is-focus:not\(\.is-panel-closed\) \.transcript-wrap\.has-header\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(focusRow, "the mode must re-declare the tracks");
  const template = /grid-template-columns:\s*([^;]+);/.exec(focusRow)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  assert.equal(
    template,
    "var(--reading-leading) var(--reading-lane) var(--reading-leading)",
    "the leading margin twice: symmetry with no companion to fill the other side",
  );
  assert.match(focusRow, /--reading-trailing:\s*var\(--reading-leading\)/, "and the trailing token follows it, so `fill` stays correct");
  assert.match(focusRow, /column-gap:\s*0/, "no gutter beside a box that is not there");
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
   * `⌥⇧Z` was added beside it because it is the mode's popular name and chord (*"many apps call it Zen Mode"*), and BOTH
   * are kept: replacing `⌘⇧.` would send readers who learned it next to the stop key.
   *
   * Falsified by registering `mod+.`: the two assertions then name the same chord, and `shortcuts.test.mjs` would report
   * a duplicate binding.
   */
  const focus = SHORTCUTS.find((shortcut) => shortcut.id === "view.focus");
  assert.ok(focus, "the mode is in the registry, so the sheet lists it");
  assert.deepEqual([...focus.keys], ["alt+shift+z", "mod+shift+."]);
  const stop = SHORTCUTS.find((shortcut) => shortcut.id === "session.stop");
  assert.notDeepEqual([...focus.keys], [...stop.keys], "one keystroke, one meaning");
  // Dispatched by the shell, like every other window-level key.
  assert.equal(focus.shell, true);
  assert.match(app, /"view\.focus": \(\) => setRailPrefsAndPersist/, "and the shell handles it by id");
});

test("Zen mode's chord is reachable on a keyboard where Option is a dead key", () => {
  /*
   * The defect this test exists for, and it is the same class as the German-keyboard `⌘/` bug the registry already
   * records: on macOS Option is a DEAD KEY for letters, so `⌥⇧Z` reports `key: "¸"` rather than `"z"`. A binding
   * declared as `alt+shift+z` would be documented, listed on the sheet, and impossible to press.
   *
   * `chordOf` therefore reads the PHYSICAL key (`code`) when Option is the only modifier. Both spellings are asserted
   * because both happen in the wild — some layouts and some platforms report the letter through Option.
   *
   * Falsified by deleting the `letterFromCode` branch: the first assertion reports `alt+shift+¸`, no binding matches it,
   * and the mode becomes pointer-only on macOS.
   */
  /*
   * EVERY SHAPE macOS PRODUCES, because the first version of this test only had the third one and the binding was still
   * dead — reported as *"no shortcut toggled zen mode"*. The failure was guard ORDER: `"dead"` is in `MODIFIER_KEYS` and
   * `""` fails the empty-key check, and both of those ran BEFORE the `code` fallback, so two of the three shapes below
   * returned `undefined` and `code` was never read.
   *
   * Falsified by restoring the old order (guards first, `code` after): the first two assertions report `undefined`.
   */
  const shapes = [
    { key: "Dead", note: "the composed character is itself a dead key — what ⌥⇧Z actually reports on macOS" },
    { key: "", note: "a layout that reports nothing at all" },
    { key: "¸", note: "the composed cedilla" },
    { key: "Ω", note: "⌥Z on a US layout" },
    { key: "z", note: "a platform that reports the letter through Option" },
  ];
  for (const { key, note } of shapes) {
    const event = { key, code: "KeyZ", altKey: true, shiftKey: true };
    assert.equal(chordOf(event), "alt+shift+z", `${JSON.stringify(key)} → the physical key (${note})`);
    assert.equal(resolveShortcut(event, closedGate)?.id, "view.focus", `${JSON.stringify(key)} resolves to the mode`);
  }

  /*
   * And a modifier pressed ON ITS OWN is still not a chord. This is what the `MODIFIER_KEYS` guard is for, and it has to
   * survive the reordering: with `fromCode` `undefined` the guard still applies, so holding Option (reported as
   * `key: "Alt"`, or as `"Dead"` with no `code`) does nothing.
   */
  assert.equal(chordOf({ key: "Alt", altKey: true }), undefined, "Option alone is not a chord");
  assert.equal(chordOf({ key: "Dead", altKey: true }), undefined, "and neither is a dead key with no letter behind it");

  /*
   * And WITHOUT Option the produced key still wins, because a layout is entitled to decide what `⌘Y` means: QWERTZ
   * swaps Y and Z, and `⌘Z` on QWERTZ produces `key: "y"`. Reading `code` there would bind the wrong physical key.
   */
  assert.equal(chordOf({ key: "y", code: "KeyZ", metaKey: true }), "mod+y", "⌘ chords follow the layout");

  // A non-letter code is never substituted: the fallback exists for dead-key substitution, not to overrule a layout.
  assert.equal(chordOf({ key: "&", code: "Digit1", altKey: true }), "alt+&");
});

test("an Option chord follows the LETTER, on a keyboard that is not US QWERTY", () => {
  /*
   * The second report on the same key: *"it still does not work"*, after the dead-key fallback was added and verified.
   *
   * `code` is a PHYSICAL position, not a letter — `KeyZ` is "the key in the Z position of a US keyboard". Reading it
   * directly assumed US QWERTY, so on the German layout this repository already has two other reports from, the key
   * LABELLED `Z` reports `code: "KeyY"`:
   *
   *     ⌥⇧Z  →  composed alt+shift+y  →  matches nothing  →  the mode never toggles
   *
   * And it would have hit `⌥Q` on AZERTY the same way (the key labelled Q is `KeyA` there).
   *
   * `setKeyLayout` installs the browser's own `getLayoutMap()`, which answers what each physical key TYPES on this
   * machine — the only honest source, since `code` cannot know. Falsified by ignoring the map: the QWERTZ assertions
   * then report `alt+shift+y`, exactly as the report did.
   */
  const QWERTZ = new Map([
    ["KeyY", "z"], // the key labelled Z
    ["KeyZ", "y"], // the key labelled Y
    ["KeyQ", "q"],
    ["KeyA", "a"],
    ["Period", "."],
  ]);

  try {
    setKeyLayout(QWERTZ);
    // The key labelled Z, which macOS reports as a dead key and as physical position KeyY.
    const qwertzZ = { key: "Dead", code: "KeyY", altKey: true, shiftKey: true };
    assert.equal(chordOf(qwertzZ), "alt+shift+z", "the letter the reader sees, not the US position");
    assert.equal(resolveShortcut(qwertzZ, closedGate)?.id, "view.focus", "so the mode toggles");

    /*
     * And the arrangement is still respected in the OTHER direction: on QWERTZ the key labelled Y is `KeyZ`, so
     * `⌥⇧Y` must be `alt+shift+y` — a mapping that only rewrote one of the two would make the other key lie.
     */
    assert.equal(chordOf({ key: "Dead", code: "KeyZ", altKey: true, shiftKey: true }), "alt+shift+y");

    // AZERTY's fault, caught by the same fix: there the key labelled Q is KeyA.
    setKeyLayout(new Map([["KeyA", "q"]]));
    assert.equal(chordOf({ key: "œ", code: "KeyA", altKey: true }), "alt+q", "⌥Q on AZERTY");
    assert.equal(QUEUE_CHORD, "alt+q", "which is the queued-messages chord, so that binding was dead too");

    /*
     * A layout entry that is not a single letter is ignored rather than trusted: this map turns physical keys back
     * into letters, and `"ShiftLeft" → "Shift"` must not become the letter "s".
     */
    setKeyLayout(new Map([["KeyZ", "Shift"], ["KeyY", "ß"]]));
    assert.equal(chordOf({ key: "Dead", code: "KeyZ", altKey: true }), "alt+z", "a non-letter entry falls back to the position");
    assert.equal(chordOf({ key: "Dead", code: "KeyY", altKey: true }), "alt+y", "and so does a multi-character one");
  } finally {
    // The module holds this globally, so a test that leaves it installed would change every later test in the file.
    setKeyLayout(undefined);
  }
});

test("on QWERTZ the key LABELLED Z toggles it, with no layout API to ask", () => {
  /*
   * The third report on one key, and the one that finally states the real requirement: *"ah, with Y it works. So on a
   * QWERTZ layout, it wont work!"*
   *
   * On QWERTZ the key labelled Z sits in the US position of Y, so it reports `code: "KeyY"` — and the key labelled Y sits
   * where the US has Z (`code: "KeyZ"`). Reading the physical key as US letters therefore made the key labelled Y fire the
   * mode, which is exactly what the reader observed. Reading it through the layout map fixed it in principle and not in
   * practice: `getLayoutMap` is CDP-gated in Electron, so the map was absent and the US letter was used.
   *
   * So the requirement is stated here WITHOUT the map: `setKeyLayout(undefined)`, meaning "the browser cannot tell us",
   * and the key labelled Z must STILL toggle the mode. That is what the candidate list buys — the binding decides, not the
   * platform.
   *
   * Falsified by returning only the US letter from `chordsOf`: this reports `alt+shift+y`, which is the bug.
   */
  setKeyLayout(undefined);

  // The key labelled Z: US position Y. This is the one the reader pressed.
  const keyLabelledZ = { key: "Dead", code: "KeyY", altKey: true, shiftKey: true };
  assert.equal(resolveShortcut(keyLabelledZ, closedGate)?.id, "view.focus", "the key labelled Z toggles Zen mode");

  /*
   * And the key LABELLED Y is `code: "KeyZ"` — the US position of Z — so it must ALSO work, because on a US keyboard that
   * key IS Z. Both keys toggling on one layout is the correct, deliberate outcome: the two bindings that could claim them
   * (`⌥⇧Z`) is one, and the reader who presses either key labelled Z or key labelled Y has asked for the mode under the
   * name this app gives it. Nothing else is bound to `alt+shift+y`, so there is no collision to resolve.
   */
  const keyLabelledY = { key: "Dead", code: "KeyZ", altKey: true, shiftKey: true };
  assert.equal(resolveShortcut(keyLabelledY, closedGate)?.id, "view.focus", "and so does the US position of Z");

  /*
   * ORDER MATTERS WHEN A LAYOUT REALLY DOES SWAP THEM. With a QWERTZ map installed, `KeyZ` is `y` and `KeyY` is `z`, and
   * the reader's own letter must come first — so a future `⌥⇧Y` binding would win on the key labelled Y rather than being
   * shadowed by the US spelling.
   */
  try {
    setKeyLayout(new Map([["KeyY", "z"], ["KeyZ", "y"]]));
    assert.deepEqual(chordsOf(keyLabelledZ), ["alt+shift+z", "alt+shift+y"], "their letter first, then the US one");
    assert.deepEqual(chordsOf(keyLabelledY), ["alt+shift+y", "alt+shift+z"], "and the other way round for the other key");
    // Neither order changes which binding these two events resolve to, because only one chord is bound.
    assert.equal(resolveShortcut(keyLabelledZ, closedGate)?.id, "view.focus");
    assert.equal(resolveShortcut(keyLabelledY, closedGate)?.id, "view.focus");
  } finally {
    setKeyLayout(undefined);
  }
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
