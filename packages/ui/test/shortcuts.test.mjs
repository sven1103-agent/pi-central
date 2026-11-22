/**
 * The keyboard: one registry, a dispatcher that obeys it, and a sheet that renders it.
 *
 * ## What was actually reported
 *
 * > *"Stopping and deleting a session is currently not supported with hotkeys. The user needs to do repetitive tasks
 * > with a lot of mouse movements, like stopping several finished sessions and deleting it, both with manual dialog
 * > confirmations. The app shall provide hotkeys for this, and also a way to display all available hotkeys in the
 * > app"*
 *
 * Three claims hide in that, and each one can fail on its own:
 *
 *   1. the keys EXIST for stop and delete (and for clearing a list of finished sessions);
 *   2. the dialog that asks still asks, and one keystroke can answer it — otherwise "hotkey support" is a key that
 *      walks the reader to a mouse;
 *   3. the list of keys is reachable WITHOUT knowing a key, and it shows what the app actually does.
 *
 * ## Why the registry is the assertion, not the source text
 *
 * The failure mode of a help surface is a second, hand-written list. It is not hypothetical here: `DESIGN.md` §12
 * promised `⌘K`, `⌘.`, `⌘\` and `/`, and only `/` had ever been implemented — a documented key that does nothing is
 * worse than an undocumented one, because the reader concludes the APP is broken rather than the note.
 *
 * So every assertion below goes through `SHORTCUTS`/`shortcutSections`, and the shell is held to the registry BY ID.
 * A binding that reaches the sheet without a handler, or a handler whose chord was removed, fails here.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import {
  DELETE_CHORD,
  KEYS_CHORD,
  SHELL_SHORTCUT_IDS,
  SHORTCUTS,
  SHORTCUT_GROUPS,
  STOP_CHORD,
  QUEUE_CHORD,
  chordOf,
  detectPlatform,
  displayChord,
  isEditableTarget,
  matchesChord,
  nextRowKey,
  resolveChord,
  resolveShortcut,
  shortcutForChord,
  shortcutSections,
} from "../src/shortcuts.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const rail = readFileSync(new URL("../src/components/SessionRail.tsx", import.meta.url), "utf8");
const sheetSource = readFileSync(new URL("../src/components/ShortcutSheet.tsx", import.meta.url), "utf8");
const confirmDelete = readFileSync(new URL("../src/components/ConfirmDelete.tsx", import.meta.url), "utf8");

let server, ShortcutSheet;
before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ ShortcutSheet } = await server.ssrLoadModule("/src/components/ShortcutSheet.tsx"));
});
after(async () => {
  await server?.close();
});

/** Comments removed: a rule its own rationale violates is a broken rule (see `invariants.test.ts`). */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// --- 1. The keys exist --------------------------------------------------------------------------

test("stopping and deleting a session each have a hotkey", () => {
  // The reported chore, stated as two assertions: a key that opens the Stop dialog, and a key that opens the Delete
  // dialog. Both are shell bindings, so the shell's one listener is what answers them.
  const stop = SHORTCUTS.find((shortcut) => shortcut.id === "session.stop");
  const remove = SHORTCUTS.find((shortcut) => shortcut.id === "session.delete");
  assert.ok(stop, "there is a Stop binding");
  assert.ok(remove, "there is a Delete binding");
  assert.equal(stop.shell, true, "Stop is answered by the shell, not by a surface that may not be mounted");
  assert.equal(remove.shell, true, "so is Delete");
  // And they are DIFFERENT keys: one mapping for both would make the destructive one a slip of the other.
  assert.notDeepEqual(stop.keys, remove.keys);
});

test("the stop key is the platform's own interrupt, and the delete key is not one", () => {
  // `⌘.` is what macOS uses to cancel an in-progress operation, so it needs no teaching. `⌘⌫` is the Delete binding
  // because it IS the delete gesture — and it is flagged, because in a text field it means "delete the line".
  assert.equal(STOP_CHORD, "mod+.");
  assert.equal(DELETE_CHORD, "mod+backspace");
  assert.equal(
    SHORTCUTS.find((shortcut) => shortcut.id === "session.delete")?.avoidInEditable,
    true,
    "Delete must stand down while a field has focus, or it competes with native text editing",
  );
});

test("each destructive dialog is confirmable by the key that opened it", () => {
  // "Hotkey support" that stops at the dialog still needs the mouse, which is the complaint. The dialog owns the
  // second press because only it knows it is open; the shell stands down while a modal is up (asserted below).
  // `matchesChord`, not `chordOf(event) !== CHORD`: the latter was the German-keyboard bug in miniature — it compares
  // the raw chord, so a layout that types the key through Shift reports `mod+shift+…` and the dialog ignores its own
  // key. One predicate, so the shell and every dialog agree about what a keystroke meant.
  assert.match(code(confirmDelete), /matchesChord\(event, DELETE_CHORD\)/, "Delete's dialog answers its own chord");
  assert.match(code(app), /matchesChord\(event, STOP_CHORD\)/, "Stop's dialog answers its own chord");
  // Registered on the CAPTURE phase so the window listener cannot also act on the same keystroke.
  assert.match(
    code(confirmDelete),
    /addEventListener\("keydown", onKeyDown, true\)/,
    "capture, so one press is one action",
  );
});

test("a group of finished sessions can be selected, then deleted in one confirmation", () => {
  // The "several finished sessions" half of the report. The control hangs off the Stopped heading, which is the only
  // place that knows which rows those are — and it is gated on the capability, like every other delete affordance.
  assert.match(code(rail), /className="group-select"/, "the group heading is a control");
  assert.match(code(rail), /onSelectGroup/, "and it hands the group's rows back");
  assert.match(code(app), /onSelectGroup: \(rows: RosterRow\[\]\)/, "the shell turns them into one pending delete");
  // One confirmation for N transcripts, not N confirmations: the same dialog every other delete uses.
  assert.match(code(app), /label: `\$\{paths\.length\} stopped session/, "the dialog names a count");
});

// --- 2. The dispatcher obeys the registry -------------------------------------------------------

test("every shell binding in the registry is dispatched BY ID", () => {
  // The check that makes the registry authoritative rather than decorative. A handler is a key in
  // `shellShortcuts`, so a binding without one is a documented key that does nothing.
  const handlers = code(app).slice(code(app).indexOf("const shellShortcuts"));
  const body = handlers.slice(0, handlers.indexOf("const platform"));
  const missing = SHELL_SHORTCUT_IDS.filter((id) => !body.includes(`"${id}":`));
  assert.deepEqual(missing, [], "a shell shortcut with no handler is a key that does nothing");
});

test("no shell handler matches on a raw key, which would bypass the registry", () => {
  // `event.key === "n"` in the dispatcher would mean the registry describes the code instead of governing it — and
  // the next person to change a chord would find one handler that still listens to the old one.
  const start = code(app).indexOf("const shellShortcuts");
  const body = code(app).slice(start, code(app).indexOf("const platform"));
  assert.doesNotMatch(body, /event\.key/, "handlers switch on the registry id, never on a key");
});

test("only a chord with a modifier can be a binding", () => {
  // A registry that could claim a bare key could swallow a character the reader is typing.
  assert.equal(chordOf({ key: "n" }), undefined, "no modifier, no chord");
  assert.equal(chordOf({ key: "Shift" }), undefined, "a modifier alone is not a chord");
  assert.equal(chordOf({ key: "n", metaKey: true }), "mod+n");
  assert.equal(chordOf({ key: "N", ctrlKey: true, shiftKey: true }), "mod+shift+n", "canonical and lowercased");
  assert.equal(chordOf({ key: "ArrowDown", altKey: true }), "alt+arrowdown", "named keys keep their name");
  // ⌘ and Ctrl are the same modifier: one list of bindings is worth more than a platform split.
  assert.equal(chordOf({ key: "n", metaKey: true }), chordOf({ key: "n", ctrlKey: true }));
});

test("a key a LAYOUT produces through Shift still reaches its binding", () => {
  /*
   * The German-keyboard bug, as a test.
   *
   * `⌘/` was the keys-sheet binding. On a DE layout `/` is Shift+7, so the browser reports `{ key: "/", shiftKey:
   * true }` and `chordOf` answered `mod+shift+/` — not the registered `mod+/`. The key was on the sheet, in a tooltip,
   * and dead. AZERTY has the same fault on the digits, so `⌘1`/`⌘2` were dead there.
   *
   * The rule is one-directional on purpose: an EXTRA Shift on a Shift-ed key is not a different chord, but a binding
   * that asks for Shift is never satisfied without it, and letters are excluded so `⌘O`/`⌘⇧O` stay distinct.
   */
  // A punctuation key typed through Shift resolves to the binding that names it unshifted.
  assert.equal(resolveChord("mod+shift+/").includes("mod+/"), true, "DE `⌘/` reaches `mod+/`");
  assert.equal(resolveChord("mod+shift+1").includes("mod+1"), true, "AZERTY `⌘1` reaches `mod+1`");
  // A LETTER keeps Shift significant, or the two open-directory-style pairs would collapse into one.
  assert.equal(resolveChord("mod+shift+o").includes("mod+o"), false, "`⌘⇧O` is not `⌘O`");
  assert.equal(resolveChord("mod+o").includes("mod+shift+o"), false, "and not the other way round");
  // Nothing to tolerate: a plain chord is returned unchanged, so callers can treat it as a list.
  assert.deepEqual(resolveChord("mod+k"), ["mod+k"]);
  // A NAMED key is never typed through the layout, so Shift on it is a real modifier.
  assert.equal(resolveChord("mod+shift+backspace").includes("mod+backspace"), false, "Shift+⌫ is not ⌫");

  // And the end-to-end path: the event a German keyboard emits now reaches the binding that names the key unshifted.
  // Tested against a chord that IS registered, because `⌘/` no longer is — it moved to `⌘K`. The tolerance is a property
  // of the resolver, not of that one key.
  const gate = { modalOpen: false, keysOpen: false, sheetOpen: false, inField: false };
  assert.equal(
    resolveShortcut({ key: ",", metaKey: true, shiftKey: true }, gate)?.id,
    "settings.open",
    "a Shift-ed punctuation key still fires the chord registered without Shift",
  );
  // The predicate every surface now uses agrees with it, so a dialog cannot ignore its own key either.
  assert.equal(matchesChord({ key: ",", metaKey: true, shiftKey: true }, "mod+,"), true);
  assert.equal(matchesChord({ key: "o", metaKey: true, shiftKey: true }, "mod+o"), false);
});

test("forgetting is a key, and it is not the same key as deleting", () => {
  /*
   * Reported from use: *"what is missing is a shortcut to forget sessions. Command + F would be suitable."*
   *
   * The registry is the assertion rather than the source text, for this file's usual reason: a key that exists in a
   * handler but not in the list is a key nobody can discover.
   */
  const forget = SHORTCUTS.find((shortcut) => shortcut.id === "session.forget");
  assert.ok(forget, "there is a Forget binding");
  assert.equal(forget.shell, true, "answered by the shell, so it works from anywhere");
  assert.deepEqual(forget.keys, ["mod+f"], "⌘F, as asked for");

  // Housekeeping keeps its two actions apart. One key doing both would make the destructive one a slip of the other.
  assert.notDeepEqual(forget.keys, SHORTCUTS.find((shortcut) => shortcut.id === "session.delete")?.keys);
  // And it must NOT stand down in a field the way delete does: `⌘F` is not a native text-editing chord on macOS
  // (that is ⌃F), so suppressing it here would disable the key for a reader who happened to click the composer.
  assert.equal(forget.avoidInEditable, undefined, "no text-editing conflict, so it is not suppressed");
});

test("forget asks nothing, because the transcript survives it", () => {
  // The distinction that decides whether a dialog is owed: `forget` removes the row and KEEPS the file (the store's
  // `forget` case), and a running session un-forgets itself on its next broadcast. Stop and delete are irreversible,
  // which is why they confirm and this does not — a dialog around a reversible act trains a reader to dismiss dialogs.
  const body = code(app).slice(code(app).indexOf("const requestForgetFocused"));
  const fn = body.slice(0, body.indexOf("const shellShortcuts"));
  assert.match(fn, /kind: "forget"/, "it dispatches the store's forget, the same action the buttons use");
  assert.doesNotMatch(fn, /setPendingDelete|setConfirmStop/, "and opens no confirmation");

  // It reads the SAME two lookups the delete path does, so the key and the buttons cannot mean different sessions.
  assert.match(fn, /focusedSession\(state\)/, "a live session with a file");
  assert.match(fn, /focusedStoppedRow\(state\)/, "or a roster row with no process");
  // Nothing focused is answered, not ignored — a key that silently does nothing reads as broken.
  assert.match(fn, /noteError/, "and says why when there is nothing to forget");
});

test("the keys sheet is on a letter, so no layout can hide it", () => {
  // `⌘/` worked once the Shift tolerance landed, but a letter needs no assumption at all — and `⌘K` is the convention.
  const binding = SHORTCUTS.find((shortcut) => shortcut.id === "keys.show");
  assert.ok(binding, "there is a keys-sheet binding");
  assert.deepEqual(binding.keys, ["mod+k"], "⌘K, not ⌘/ — see the registry's comment");
  assert.equal(KEYS_CHORD, "mod+k", "and the bar's tooltip is read from it, not written beside it");
  // `⌘K` must not already mean something else.
  const others = SHORTCUTS.filter((shortcut) => shortcut.id !== "keys.show");
  assert.equal(others.some((shortcut) => shortcut.keys.includes("mod+k")), false, "and it is free");
});

test("every registered chord resolves back to its own binding", () => {
  for (const shortcut of SHORTCUTS) {
    for (const chord of shortcut.keys) {
      assert.equal(shortcutForChord(chord)?.id, shortcut.id, `${chord} must resolve to ${shortcut.id}`);
    }
  }
});

test("no two bindings claim the same chord", () => {
  // Two entries for one chord would make the sheet print a key twice with two different meanings, and the winner is
  // whichever the `find` happens to reach first — a race decided by source order.
  const seen = new Map();
  for (const shortcut of SHORTCUTS) {
    for (const chord of shortcut.keys) {
      assert.equal(seen.get(chord), undefined, `${chord} is claimed by both ${seen.get(chord)} and ${shortcut.id}`);
      seen.set(chord, shortcut.id);
    }
  }
});

test("the shell stands down while a dialog or a sheet is open", () => {
  // A `⌘N` behind a delete confirmation would open a second dialog on top of the first, with no way to tell which
  // one the next keystroke belongs to.
  const stop = { key: ".", metaKey: true };
  const closed = { modalOpen: false, keysOpen: false, sheetOpen: false, inField: false };
  assert.equal(resolveShortcut(stop, closed)?.id, "session.stop", "with nothing open the key acts");
  assert.equal(resolveShortcut(stop, { ...closed, modalOpen: true }), undefined, "a modal in front stands it down");
  assert.equal(resolveShortcut(stop, { ...closed, sheetOpen: true }), undefined, "and so does the directory sheet");
  // The keys sheet is the exception, and it says why: it lists keys, so they must remain testable while it is open.
  assert.equal(
    resolveShortcut(stop, { ...closed, modalOpen: true, keysOpen: true })?.id,
    "session.stop",
    "the reference sheet does not disable the keyboard",
  );
});

test("a binding that asks to be kept out of fields is, and only that binding", () => {
  // `⌘⌫` is Delete-to-line-start in a textarea on macOS. Standing EVERY key down in a field would cost a reader
  // who clicked into the composer `⌘N` for the rest of the session, which is the wrong trade.
  const closed = { modalOpen: false, keysOpen: false, sheetOpen: false, inField: true };
  assert.equal(resolveShortcut({ key: "Backspace", metaKey: true }, closed), undefined, "⌘⌫ does not fire in a field");
  assert.equal(resolveShortcut({ key: "n", metaKey: true }, closed)?.id, "session.start", "⌘N still does");
});

test("a surface-owned binding is never dispatched by the shell", () => {
  // `Enter` and `⌥↓` are in the sheet because a reader wants one place to look, but the composer and the rail own
  // them: only they know whether a picker is open, or which rows are on screen.
  const closed = { modalOpen: false, keysOpen: false, sheetOpen: false, inField: false };
  assert.equal(resolveShortcut({ key: "Enter" }, closed), undefined, "Enter has no modifier, so it is not a chord");
  assert.equal(resolveShortcut({ key: "ArrowDown", altKey: true }, closed), undefined, "⌥↓ belongs to the rail");
  assert.equal(resolveShortcut({ key: "q", altKey: true }, closed), undefined, "⌥Q belongs to the composer");
});

test("next/previous session walks the rows in the order they are SHOWN", () => {
  // The rail owns this, not the shell: the visible order depends on the filter and the attention grouping, and a
  // second implementation of "next" would disagree with the list the reader is looking at.
  assert.equal(SHORTCUTS.find((shortcut) => shortcut.id === "session.next")?.shell, false);
  assert.equal(SHORTCUTS.find((shortcut) => shortcut.id === "session.previous")?.shell, false);

  // The listener itself, sliced out so a gutted effect cannot be satisfied by a comment or by the helper's own call
  // site — the first version of this assertion passed with the handler deleted, which is exactly the "test that cannot
  // fail" this repository keeps writing tests about.
  const railCode = code(rail);
  const listener = railCode.slice(
    railCode.indexOf("const onKeyDown = (event: KeyboardEvent)"),
    railCode.indexOf("return ("),
  );
  assert.match(listener, /matchesChord\(event, "alt\+arrowdown"\)/, "it listens for the down key");
  assert.match(listener, /matchesChord\(event, "alt\+arrowup"\)/, "and the up key");
  assert.match(listener, /event\.preventDefault\(\)/, "and claims the key, so the list does not also scroll");
  assert.match(listener, /onFocusRow\(row, true\)/, "and it moves the focus, which is the whole behaviour");
  /*
   * The second argument says the move came from the KEYBOARD (issue #275), and the shell needs the difference: walking
   * the list while the rail is summoned must keep it open, while a pointer selection closes the overlay over the
   * conversation just chosen. Dropping the flag would make `⌥↓` dismiss the list one row along.
   */
  assert.match(code(app), /onFocusRow=\{\(row, viaKeyboard\)/, "the shell reads which surface asked");
  assert.match(code(app), /if \(viaKeyboard\) setRailOpen\(true\);/, "and keeps a summoned rail open for the keys");
  // A window listener also fires while a dialog is in front, and moving focus behind a dialog changes what its own
  // buttons are about — so the rail stands down when the shell says a modal is up.
  assert.match(railCode, /if \(modalOpen\) return undefined;/, "a dialog in front stops the rail acting");
  assert.match(code(app), /modalOpen=\{pendingDelete !== undefined/, "and the shell tells it");

  // The arithmetic, including the two cases that are easy to get wrong.
  const keys = ["a", "b", "c"];
  assert.equal(nextRowKey(keys, "b", 1), "c");
  assert.equal(nextRowKey(keys, "c", 1), "a", "wraps, so two keys reach every row");
  assert.equal(nextRowKey(keys, "a", -1), "c", "and wraps backwards");
  assert.equal(nextRowKey(keys, undefined, 1), "a", "nothing focused starts at the top");
  assert.equal(nextRowKey(keys, "gone", -1), "c", "a key that left the list starts from the near end");
  assert.equal(nextRowKey([], "a", 1), undefined, "an empty list has no next row");
});

// --- 3. The list is reachable, and shows what the app does ---------------------------------------

test("the keys sheet is reachable without already knowing a key", () => {
  // A sheet whose only door is a chord cannot teach that chord. The discovery control is in the app's own navigation bar,
  // beside Settings — the two things a reader looks up rather than does.
  const bar = code(app).slice(code(app).indexOf('side="left"'), code(app).indexOf('side="right"'));
  assert.match(bar, /aria-label="Keyboard shortcuts"/, "a labelled control in the left bar");
  assert.match(bar, /keyboard shortcuts \(/i, "and its tooltip names the chord, so the key is learned too");
  // And focus RETURNS to it, the rule every keyboard-reachable surface in this app follows.
  assert.match(bar, /ref=\{keysTriggerRef\}/, "the trigger is a real ref, so focus can go back to it");
  assert.match(code(app), /setKeysOpen\(false\);\s*keysTriggerRef\.current\?\.focus\(\)/, "and it does");
});

test("the sheet renders the REGISTRY, so it cannot promise a key the app lacks", () => {
  // The assertion is on the module boundary: the sheet has no words of its own.
  assert.match(code(sheetSource), /shortcutSections\(platform\)/, "it renders the registry");
  assert.doesNotMatch(code(sheetSource), /⌘|Ctrl\+/, "no hand-written chord anywhere in the component");

  const html = renderToString(createElement(ShortcutSheet, { onClose() {}, platform: "apple" }));
  // Read as TEXT, not as markup: React escapes apostrophes, and an assertion about words must not depend on how.
  const shown = new JSDOM(`<body>${html}</body>`).window.document.body.textContent ?? "";
  for (const shortcut of SHORTCUTS) {
    // The label is the action's own words, so the sheet and the buttons cannot describe one action two ways.
    assert.ok(shown.includes(shortcut.label), `the sheet must list “${shortcut.label}”`);
  }
});

test("the sheet groups every binding, and drops no group", () => {
  const sections = shortcutSections("apple");
  const listed = sections.flatMap((section) => section.rows.map((row) => row.id));
  assert.deepEqual(listed.sort(), SHORTCUTS.map((shortcut) => shortcut.id).sort(), "every key, exactly once");
  assert.deepEqual(
    sections.map((section) => section.id),
    SHORTCUT_GROUPS.filter((group) => SHORTCUTS.some((shortcut) => shortcut.group === group.id)).map((g) => g.id),
    "groups appear in their declared order, and an empty one is dropped rather than shown empty",
  );
});

test("chords are printed in the platform's own notation, not one invented for both", () => {
  // `⌘⇧O` is what the rail's own hint already renders on macOS; `Ctrl+Shift+O` is what a Windows keyboard can read.
  // Printing `⌘` to a Windows reader names a key they do not have.
  assert.equal(displayChord("mod+shift+o", "apple"), "⌘⇧O");
  assert.equal(displayChord("mod+shift+o", "other"), "Ctrl+Shift+O");
  assert.equal(displayChord("mod+backspace", "apple"), "⌘⌫");
  assert.equal(displayChord("mod+backspace", "other"), "Ctrl+Backspace");
  assert.equal(displayChord("alt+arrowdown", "apple"), "⌥↓");

  assert.equal(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "apple");
  assert.equal(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "other");
  assert.equal(detectPlatform(undefined), "other", "an unknown platform gets the spelling that is safe everywhere");
});

test("the sheet is a dialog that Escape closes, and the Escape does not travel", () => {
  // The composer's escape ladder is also on the window. Without `stopPropagation` one Escape would close the sheet
  // AND stop the focused session's run — two actions for one keystroke, one of them destructive.
  assert.match(code(sheetSource), /role="dialog"/);
  assert.match(code(sheetSource), /aria-modal="true"/);
  assert.match(code(sheetSource), /if \(event\.key !== "Escape"\) return;/);
  assert.match(code(sheetSource), /event\.stopPropagation\(\)/, "the Escape is not passed to the escape ladder");
});

// --- The store's own door for a refusal ---------------------------------------------------------

test("a keystroke that cannot act says so, in the app's one error surface", () => {
  // `⌘⌫` on a running session cannot be sent at all: the orchestrator refuses it, correctly. Silently doing nothing
  // would make the key look broken, so the shell reports the same refusal before opening any dialog.
  assert.match(code(app), /kind: "noteError"/, "the shell reports it locally");
  assert.match(code(app), /it is open in the running session/, "in the orchestrator's own words");
});
test("a surface that answers its own chord reads it from the registry, not from event.key", () => {
  /*
   * The `⌥Q` defect, and it shipped: the registry declared `alt+q` for the queued-messages sheet AND `Composer.tsx`
   * decided for itself with `event.altKey && event.key === "q"`. Two copies of one fact, and the copy in the component
   * was dead on macOS — Option is a dead key for letters, so the event carries `key: "œ"` and the comparison never held.
   * The sheet has listed that key since it was written, and it had never worked on the platform this app is built for.
   *
   * The rule this asserts is the one the registry states in its own header: handlers switch on IDS, never on keys. A
   * literal comparison in a component makes "what can I press" a question with two answers, and only one of them is
   * tested.
   *
   * Falsified by restoring the literal comparison: the second assertion reports a surface that reads the chord itself.
   */
  const composer = readFileSync(new URL("../src/components/Composer.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(composer, /matchesChord\(event, QUEUE_CHORD\)/, "the queue sheet answers the registry's chord");
  assert.ok(
    !/event\.key === "q"/.test(composer),
    "and does not also compare the composed character, which is what Option replaces",
  );
  // The chord itself is still the registry's, so the tooltip, the sheet and the handler cannot disagree.
  assert.equal(QUEUE_CHORD, "alt+q");
});

