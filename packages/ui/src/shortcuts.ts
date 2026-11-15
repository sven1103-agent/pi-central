/**
 * The keyboard: one registry, one dispatcher, one sheet.
 *
 * ## Why this is a module and not a `switch` in `App.tsx`
 *
 * The request was narrow — *"the app shall provide hotkeys for this, and also a way to display all available
 * hotkeys"* — and it is exactly the request that produces two lists that disagree. A keybinding handler knows the
 * keys it handles, and a help sheet is written by hand beside it; the handler gains a binding, the sheet is not
 * touched, and from then on the app documents keys it does not have and hides keys it does. The documented list in
 * `DESIGN.md` §12 had already rotted that way: it promised `⌘K`, `⌘.`, `⌘\` and `/`, and only the last of those
 * even had an implementation.
 *
 * So the keys are DATA here. `SHORTCUTS` is the only list, `shortcutForChord` is how the shell resolves a
 * keystroke, and `ShortcutSheet` renders the same array. The pair cannot drift, and `shortcuts.test.mjs` holds the
 * shell's dispatcher to it by name, so a binding cannot be declared and forgotten.
 *
 * ## What a chord is
 *
 * A canonical string: `mod+alt+shift+<key>`, modifiers in that fixed order, key lowercased or a named key
 * (`escape`, `enter`, `tab`, `backspace`, `arrowup`, …). `mod` is ⌘ on macOS and Ctrl elsewhere, resolved from the
 * EVENT rather than from the platform — `event.metaKey || event.ctrlKey` — so a Mac is not punished for a browser
 * that reports a synthetic Ctrl, and a Linux user on a Mac keyboard gets the key they actually pressed.
 *
 * Only chords WITH a modifier are bindings. An unmodified key belongs to whatever the reader is typing in, and a
 * registry that could claim one is a registry that can swallow a character.
 */

/** Which notation to print a chord in. Derived from the user agent, overridable so rendering is testable. */
export type Platform = "apple" | "other";

/**
 * The groups a shortcut belongs to, in the order the sheet shows them.
 *
 * Grouped by WHEN the key applies rather than by which module implements it: a reader looking for "how do I stop
 * this session" does not care that the answer lives in the shell and the escape ladder lives in the composer.
 */
export const SHORTCUT_GROUPS = [
  { id: "sessions", title: "Sessions" },
  { id: "pages", title: "Pages" },
  { id: "writing", title: "Writing" },
] as const;

export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number]["id"];

export interface ShortcutDefinition {
  /** Stable, and the name the shell's dispatcher switches on. Never shown. */
  id: string;
  group: ShortcutGroup;
  /** One or more chords, all equivalent. Canonical form — see `chordOf`. */
  keys: readonly string[];
  /** What the key does, as the ACTION's own name (the same words the buttons use). */
  label: string;
  /** The condition, or what the action does not do. Only where saying it stops a surprise. */
  note?: string | undefined;
  /**
   * Resolved by the shell's single window listener.
   *
   * False for the keys a SURFACE owns: the composer's `Enter`, the escape ladder, the `@` picker's arrows, and the session
   * list's `⌥↑`/`⌥↓` — which the rail handles because it is the only thing that knows the order the rows are shown in.
   * They are still LISTED (a reader wants one place to look) but the shell must not act on them, because the surface
   * knows things the shell does not: whether the picker is open, whether a run is streaming, where the caret is.
   *
   * Handlers switch on this `id`, never on the chord — so the key can be changed in this file alone and every handler
   * follows. A handler that matched `event.key === "n"` would make this list a second, unenforced source of truth.
   */
  shell: true | false;
  /**
   * Suppressed while a text field has focus, because this chord is a NATIVE text-editing key there.
   *
   * `⌘⌫` is the case: in a textarea on macOS it deletes from the caret to the start of the line. Binding it
   * globally would mean a reader mid-sentence opens a delete-transcript dialog — safe, since Cancel takes focus, but
   * a keystroke that means "delete a few words" must not mean "delete a file" anywhere near a message box.
   */
  avoidInEditable?: boolean | undefined;
}

/**
 * Every binding the app has.
 *
 * Kept in one place, and the order here is the order the sheet prints — most-used first within a group, so the
 * sheet's top-left corner is the answer to "how do I stop a session".
 */
export const SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: "session.start",
    group: "sessions",
    keys: ["mod+n"],
    label: "New session",
    note: "A scratch workspace, with no directory to choose.",
    shell: true,
  },
  {
    id: "session.openDirectory",
    group: "sessions",
    keys: ["mod+shift+o"],
    label: "Open a directory…",
    shell: true,
  },
  {
    id: "session.stop",
    group: "sessions",
    keys: ["mod+."],
    label: "Stop the focused session",
    note: "Asks first. Press the same keys again in the dialog to stop it.",
    shell: true,
  },
  {
    id: "session.delete",
    group: "sessions",
    keys: ["mod+backspace"],
    label: "Delete the focused session's transcript",
    note: "Asks first, and only when nothing is running: press again in the dialog to delete.",
    shell: true,
    avoidInEditable: true,
  },
  {
    id: "session.next",
    group: "sessions",
    keys: ["alt+arrowdown"],
    label: "Next session in the list",
    note: "In the session list. Walks the rows in the order they are shown, and wraps.",
    shell: false,
  },
  {
    id: "session.previous",
    group: "sessions",
    keys: ["alt+arrowup"],
    label: "Previous session in the list",
    note: "In the session list.",
    shell: false,
  },
  {
    id: "page.sessions",
    group: "pages",
    keys: ["mod+1"],
    label: "Sessions",
    shell: true,
  },
  {
    id: "page.history",
    group: "pages",
    keys: ["mod+2"],
    label: "History",
    shell: true,
  },
  {
    id: "settings.open",
    group: "pages",
    keys: ["mod+,"],
    label: "Settings",
    shell: true,
  },
  {
    id: "keys.show",
    group: "pages",
    /*
     * `⌘K`, not `⌘/`.
     *
     * `/` is not a key every layout has unmodified: on a German keyboard it is Shift+7, and a US `⌘/` therefore could
     * not be pressed there at all. Reported from use — *"the shortcut to open the shortcut dialog is ill-placed for
     * DE-Keyboard layouts"* — and the report was right, though the fault was worse than placement: `chordOf` reported
     * `mod+shift+/` and the binding never fired. `resolveChord` now tolerates that Shift, so `⌘/` would work today, but
     * a LETTER is still the better key: it needs no layout assumption whatsoever, and `⌘K` is the convention for a
     * keyboard reference in this class of app. It was also free — `DESIGN.md` had only ever floated `⌘K` for a
     * hypothetical jump-to-session palette, which was never built.
     */
    keys: ["mod+k"],
    label: "All keyboard shortcuts",
    note: "This list.",
    shell: true,
  },
  {
    id: "composer.send",
    group: "writing",
    keys: ["enter"],
    label: "Send the message",
    shell: false,
  },
  {
    id: "composer.newline",
    group: "writing",
    keys: ["shift+enter"],
    label: "New line, instead of sending",
    shell: false,
  },
  {
    id: "composer.queue",
    group: "writing",
    keys: ["alt+enter"],
    label: "Queue the message for after this run",
    note: "While a run is going.",
    shell: false,
  },
  {
    id: "composer.queueSheet",
    group: "writing",
    keys: ["alt+q"],
    label: "Show what is queued",
    note: "While a run is going.",
    shell: false,
  },
  {
    id: "composer.mentionNext",
    group: "writing",
    keys: ["arrowdown"],
    label: "Move down the @ suggestion list",
    shell: false,
  },
  {
    id: "composer.mentionPrevious",
    group: "writing",
    keys: ["arrowup"],
    label: "Move up the @ suggestion list",
    shell: false,
  },
  {
    id: "composer.mentionAccept",
    group: "writing",
    keys: ["tab"],
    label: "Accept the @ suggestion",
    shell: false,
  },
  {
    id: "composer.escape",
    group: "writing",
    keys: ["escape"],
    label: "Cancel, then stop",
    note: "Closes the @ picker, then a sheet, then a dialog; with nothing open it stops the run and keeps the queue.",
    shell: false,
  },
];

/** The key names a chord can end in, spelled the way `KeyboardEvent.key` spells them. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  " ": "space",
  Escape: "escape",
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
};

/** Keys that are modifiers themselves: pressing one is not yet a chord. */
const MODIFIER_KEYS = new Set(["shift", "control", "alt", "meta", "altgraph", "capslock", "dead"]);

/** The part of a `KeyboardEvent` a chord is made of. Narrowed so this is testable without a DOM. */
export interface KeyEventLike {
  key: string;
  metaKey?: boolean | undefined;
  ctrlKey?: boolean | undefined;
  altKey?: boolean | undefined;
  shiftKey?: boolean | undefined;
}

/**
 * The canonical chord for a keystroke, or `undefined` when it cannot be a binding.
 *
 * `undefined` for a bare key (no ⌘/⌥) on purpose: see the file header. `⌘` and `Ctrl` are the same modifier here —
 * `mod` — because the app is used on both and one list of bindings is worth more than a platform split.
 */
export function chordOf(event: KeyEventLike): string | undefined {
  const key = NAMED_KEYS[event.key] ?? event.key.toLowerCase();
  if (key.length === 0) return undefined;
  if (MODIFIER_KEYS.has(key)) return undefined;
  const mod = event.metaKey === true || event.ctrlKey === true;
  const alt = event.altKey === true;
  const shift = event.shiftKey === true;
  if (!mod && !alt) return undefined;
  return `${mod ? "mod+" : ""}${alt ? "alt+" : ""}${shift ? "shift+" : ""}${key}`;
}

/** The binding for a canonical chord, if there is one. */
export function shortcutForChord(chord: string): ShortcutDefinition | undefined {
  return SHORTCUTS.find((shortcut) => shortcut.keys.includes(chord));
}

/**
 * Is `key` a single character the KEYBOARD LAYOUT may need Shift to produce?
 *
 * Letters are excluded on purpose, and that exclusion is the whole reason this is a function: `⌘O` and `⌘⇧O` are two
 * different bindings in this app, and collapsing Shift for letters would make one of them unreachable. Digits and
 * punctuation are included because on several layouts they are Shift-ed characters — see `resolveChord`.
 */
function isLayoutShiftedKey(key: string): boolean {
  if (key.length !== 1) return false; // a named key (`backspace`, `arrowup`) is never typed through the layout
  return !/[a-z]/.test(key);
}

/**
 * The chord to match `chordOf(event)` against, tolerating a Shift the LAYOUT required.
 *
 * ## The defect this fixes
 *
 * `⌘/` was chosen for the keys sheet, and it **never fired on a German keyboard**. On DE, `/` is Shift+7, so pressing
 * it produces `{ key: "/", shiftKey: true }` and `chordOf` reported `mod+shift+/` — which is not the registered
 * `mod+/`. The key was documented, listed on the sheet, printed in a tooltip, and dead for every reader whose layout
 * puts `/` behind a modifier. The same fault made `⌘1`/`⌘2` dead on AZERTY, where the digits are Shift-ed.
 *
 * Reported from use: *"the shortcut to open the shortcut dialog is ill-placed for DE-Keyboard layouts"*. It was worse
 * than ill-placed — it did not work at all.
 *
 * ## The rule
 *
 * For a key the layout produces through Shift, an EXTRA Shift is not a different chord: the reader pressed the key the
 * sheet told them to press. So the exact chord is tried first, then the same chord with Shift removed.
 *
 * One direction only. A binding that EXPLICITLY asks for Shift is not satisfied by pressing it without Shift — that
 * would let `⌘⇧O` be triggered by `⌘O`. And letters never take the tolerant path, so those two stay distinct.
 *
 * Returns the chord to match, which is the input unchanged when no tolerance applies.
 */
export function resolveChord(chord: string): string[] {
  const parts = chord.split("+");
  const key = parts[parts.length - 1] ?? "";
  if (!parts.includes("shift") || !isLayoutShiftedKey(key)) return [chord];
  // The unshifted form is a SEPARATE candidate, after the exact one: an explicit `mod+shift+/` binding still wins.
  return [chord, parts.filter((part) => part !== "shift").join("+")];
}

/**
 * Did this keystroke mean `binding`'s chord? Layout-tolerant, and the ONLY way any surface should ask.
 *
 * Every caller that compared `chordOf(event) !== SOME_CHORD` directly had the German-keyboard bug: on a layout where
 * the key needs Shift, the raw chord carries `shift` and the comparison silently fails. One predicate means the shell
 * and the three dialogs that answer their own chords cannot disagree about what a keystroke meant.
 */
export function matchesChord(event: KeyEventLike, binding: string): boolean {
  const chord = chordOf(event);
  if (chord === undefined) return false;
  return resolveChord(chord).includes(binding);
}

/** The ids the shell must handle, derived from the registry so the sheet cannot promise a key nobody reads. */
export const SHELL_SHORTCUT_IDS: readonly string[] = SHORTCUTS.filter((shortcut) => shortcut.shell).map(
  (shortcut) => shortcut.id,
);

/** The chord that stops a session, read from the registry so a dialog and the shell cannot disagree. */
export const STOP_CHORD: string = chordForId("session.stop");

/** The chord that starts a delete, likewise. */
export const DELETE_CHORD: string = chordForId("session.delete");

/**
 * The chord that opens the keys sheet, for the tooltip on the control that also opens it.
 *
 * Read from the registry rather than written at the call site. The bar's tooltip had a literal `"mod+/"` in it while
 * this file said `mod+/` too — two copies of one fact, which is precisely how the binding came to be documented on a
 * keyboard that could not press it.
 */
export const KEYS_CHORD: string = chordForId("keys.show");

/**
 * The (first) chord for a binding id.
 *
 * Throws for an unknown id: a dialog that asks "which key confirms me?" about a binding that does not exist is a
 * programming error, and returning `undefined` would turn it into a dialog that silently cannot be confirmed from the
 * keyboard — the failure this registry exists to prevent.
 */
function chordForId(id: string): string {
  const shortcut = SHORTCUTS.find((candidate) => candidate.id === id);
  if (shortcut === undefined || shortcut.keys[0] === undefined) {
    throw new Error(`no shortcut registered for "${id}"`);
  }
  return shortcut.keys[0];
}

/** The pieces of a chord, for printing. */
interface ChordParts {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function partsOf(chord: string): ChordParts {
  const pieces = chord.split("+");
  const key = pieces.pop() ?? "";
  return {
    mod: pieces.includes("mod"),
    alt: pieces.includes("alt"),
    shift: pieces.includes("shift"),
    key,
  };
}

/** Apple's own notation, which is what a macOS reader already knows from every other app. */
const APPLE_KEY_LABELS: Readonly<Record<string, string>> = {
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "⌫",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

const PLAIN_KEY_LABELS: Readonly<Record<string, string>> = {
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/**
 * A chord as it should be READ.
 *
 * Two conventions, and each is used consistently rather than mixed: macOS prints the modifiers as the symbols its
 * menus use and runs them together (`⌘⇧O`, the form the rail's own hint already shows), everywhere else spells them
 * out with `+` (`Ctrl+Shift+O`), because `⌘` on a Windows keyboard is a mystery glyph, not a key.
 */
export function displayChord(chord: string, platform: Platform): string {
  const { mod, alt, shift, key } = partsOf(chord);
  const named = (platform === "apple" ? APPLE_KEY_LABELS : PLAIN_KEY_LABELS)[key] ?? key.toUpperCase();
  if (platform === "apple") {
    return `${mod ? "⌘" : ""}${alt ? "⌥" : ""}${shift ? "⇧" : ""}${named}`;
  }
  return [mod ? "Ctrl" : "", alt ? "Alt" : "", shift ? "Shift" : "", named].filter((part) => part.length > 0).join("+");
}

/** Which notation this machine wants. `undefined` (SSR, a test) is treated as non-Apple: the spelling is the safe one. */
export function detectPlatform(userAgent: string | undefined): Platform {
  return userAgent !== undefined && /Mac|iPhone|iPad/.test(userAgent) ? "apple" : "other";
}

export interface ShortcutRow {
  id: string;
  label: string;
  note?: string | undefined;
  /** Already rendered in the platform's notation, so the sheet does no formatting of its own. */
  keys: readonly string[];
}

export interface ShortcutSection {
  id: ShortcutGroup;
  title: string;
  rows: readonly ShortcutRow[];
}

/**
 * The registry, ready to render: grouped, ordered, and printed.
 *
 * One function for the whole transformation, so the sheet cannot show a group the registry does not have or lose a
 * binding while filtering — the failure mode of doing this inline in JSX with three `.filter`/`.map` passes.
 */
export function shortcutSections(platform: Platform): ShortcutSection[] {
  return SHORTCUT_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    rows: SHORTCUTS.filter((shortcut) => shortcut.group === group.id).map((shortcut) => ({
      id: shortcut.id,
      label: shortcut.label,
      ...(shortcut.note === undefined ? {} : { note: shortcut.note }),
      keys: shortcut.keys.map((key) => displayChord(key, platform)),
    })),
  })).filter((section) => section.rows.length > 0);
}

/**
 * Where `alt+↓` / `alt+↑` should move focus.
 *
 * Takes the keys in the order the rail RENDERS them (grouped by attention, and filtered), because "next" has to mean
 * the next row on screen — the alternative walks a list the reader cannot see. Wraps, so the two keys are enough to
 * reach every row from wherever the reader is.
 *
 * `undefined` when there is nothing to move to, and that is not an error: an empty rail has no next row.
 */
export function nextRowKey(
  keys: readonly string[],
  current: string | undefined,
  delta: 1 | -1,
): string | undefined {
  if (keys.length === 0) return undefined;
  const at = current === undefined ? -1 : keys.indexOf(current);
  if (at === -1) return delta > 0 ? keys[0] : keys[keys.length - 1];
  return keys[(at + delta + keys.length) % keys.length];
}

/** The element facts `isEditableTarget` needs. Narrowed so this is testable with a plain object. */
export interface TargetLike {
  tagName?: string | undefined;
  isContentEditable?: boolean | undefined;
}

/** Is the keystroke going into a field the reader is typing in? */
export function isEditableTarget(target: TargetLike | null | undefined): boolean {
  if (target === null || target === undefined) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable === true;
}

/** What is on screen in front of the app, as far as the keyboard is concerned. */
export interface ShellGate {
  /** A modal dialog is open: a confirmation, Settings, or the keys sheet. */
  modalOpen: boolean;
  /** The keys reference itself is open. */
  keysOpen: boolean;
  /** A covering sheet that is not a modal: the directory picker. */
  sheetOpen: boolean;
  /** The keystroke landed in a text field. */
  inField: boolean;
}

/**
 * Which shell binding a keystroke should fire, or `undefined` for "the shell does not act".
 *
 * ## Why the guards are a function
 *
 * They are a LADDER, and a ladder written inline in an effect is a ladder that cannot be tested without a mounted App
 * and a socket — so it gets tested by nobody. `queue.ts#escalation` exists for the same reason and says the same
 * thing: *"a ladder implemented twice is a ladder that drifts"*. This one is implemented once, and the order below is
 * the documented behaviour rather than an accident of `if` order.
 *
 * ## The order, and why each step is above the next
 *
 * 1. **A chord at all.** `chordOf` requires a modifier, so nothing here can swallow a character.
 * 2. **A SHELL binding.** The composer's `Enter` and the rail's `⌥↓` belong to those surfaces, which know whether a
 *    picker is open or where the caret is. Listed in the sheet, not dispatched here.
 * 3. **No modal in front of the app** — unless the modal IS the keys sheet. `⌘N` behind a delete confirmation would
 *    stack a second dialog on the first, and the reader could no longer tell which one the next key belongs to. The
 *    sheet is the exception because its content is the keyboard: letting the keys work while it is open is how a
 *    reader checks what `⌘.` does without closing the list they are reading.
 * 4. **No covering sheet.** The directory picker is not modal — it does not trap focus — but it covers the window and
 *    has its own Escape. The shell acting underneath it is how a session starts behind a sheet nobody dismissed.
 * 5. **Not a native text-editing chord.** `⌘⌫` deletes to the start of the line in a textarea on macOS. A binding can
 *    opt out of fields (`avoidInEditable`), and only that binding is checked: standing every key down in a field would
 *    mean a reader who clicked into the composer lost `⌘N` for the rest of the session.
 */
export function resolveShortcut(event: KeyEventLike, gate: ShellGate): ShortcutDefinition | undefined {
  const chord = chordOf(event);
  if (chord === undefined) return undefined;
  /*
   * Every candidate form of the chord, not just the literal one: a layout that types this key through Shift produces a
   * chord with `shift` in it, and that extra Shift must not hide the binding (see `resolveChord`).
   */
  let shortcut: ShortcutDefinition | undefined;
  for (const candidate of resolveChord(chord)) {
    shortcut = shortcutForChord(candidate);
    if (shortcut !== undefined) break;
  }
  if (shortcut === undefined || !shortcut.shell) return undefined;
  if (gate.modalOpen && !gate.keysOpen) return undefined;
  if (gate.sheetOpen) return undefined;
  if (shortcut.avoidInEditable === true && gate.inField) return undefined;
  return shortcut;
}
