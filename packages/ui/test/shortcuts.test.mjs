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
  SHELL_SHORTCUT_IDS,
  SHORTCUTS,
  SHORTCUT_GROUPS,
  STOP_CHORD,
  chordOf,
  detectPlatform,
  displayChord,
  isEditableTarget,
  nextRowKey,
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
  assert.match(code(confirmDelete), /chordOf\(event\) !== DELETE_CHORD/, "Delete's dialog answers its own chord");
  assert.match(code(app), /chordOf\(event\) !== STOP_CHORD/, "Stop's dialog answers its own chord");
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
  assert.match(listener, /chord !== "alt\+arrowdown" && chord !== "alt\+arrowup"/, "it listens for the two chords");
  assert.match(listener, /event\.preventDefault\(\)/, "and claims the key, so the list does not also scroll");
  assert.match(listener, /onFocusRow\(row\)/, "and it moves the focus, which is the whole behaviour");
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
  // A sheet whose only door is `⌘/` cannot teach `⌘/`. The discovery control is in the app's own navigation bar,
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
