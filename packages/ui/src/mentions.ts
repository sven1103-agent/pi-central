/**
 * The `@path` autocomplete: where a mention starts, what it offers, and what accepting it writes.
 *
 * ## Why this is a module of pure functions
 *
 * Everything here is decided from a string and a directory listing, and none of it needs a DOM. That matters because the
 * parts that are easy to get wrong are exactly the parts a component test cannot reach in this repository — the caret
 * arithmetic, the ranking, and the replacement span. A picker that inserts one character too many is a bug that looks
 * like the reader cannot type.
 *
 * ## The three questions, in the order they are asked
 *
 *   1. **Is the caret inside a mention?** (`mentionAt`) — scanning BACKWARDS from the caret, so a mention in the middle
 *      of a sentence works and a mention in a code block is not special-cased. Backwards is what makes "the token the
 *      caret is in" cheap and exact.
 *   2. **What does that mention offer?** (`complete`) — the directory the typed path names, then the entries in it that
 *      match the last segment. Directories rank before files because a path being typed usually continues into one, and
 *      images rank before other files because that is the only reason this picker exists.
 *   3. **What replaces what?** (`apply`) — the span from the `@` to the caret, replaced by the chosen path plus a space.
 *
 * ## The constraint that shapes every rule here
 *
 * The inserted text has to be something the reader could have typed, and something the SEND path recognises. `previewsFor`
 * in `references.ts` decides what becomes a preview, so this module's output must be a form it accepts: a relative path
 * ending in an image extension, with no `..` and no scheme. `apply` therefore always emits the plain relative path —
 * never a quoted, escaped or absolute form — and a test asserts the two modules agree.
 */

/** The directory listing this needs, reduced to what a picker shows. Deliberately not `FileEntry`: no sizes, no links. */
export interface Entry {
  name: string;
  kind: "file" | "directory";
}

/** Where a mention starts and what has been typed after the `@`. */
export interface Mention {
  /** Index of the `@` in the text, so the replacement span is `[start, caret)`. */
  start: number;
  /** Everything typed after the `@` and before the caret. May be empty (a bare `@`). */
  query: string;
}

/**
 * How long an image path may be before it is not worth completing.
 *
 * The same ceiling `references.ts` puts on a candidate, so a mention this offers is one the preview will accept.
 */
const MAX_QUERY = 200;

/**
 * The mention the caret is inside, or `undefined`.
 *
 * ## The rule, stated as the four ways it must not fire
 *
 * A mention starts at an `@` that is either at the beginning of the text or preceded by whitespace or an opening
 * bracket. That single rule excludes the cases that would otherwise need special handling:
 *
 *   - `user@example.com` — the `@` follows a word, so it is an email, not a mention.
 *   - `\n@` at the start of a line still works, because a newline is whitespace.
 *   - `(@shot.png` works, because `(` is an opening bracket.
 *   - `@@shot` — the second `@` follows an `@`, which is neither, so the scan keeps going back to the first and the query
 *     is `@shot`. Wrong in a harmless direction: the reader typed nonsense and gets no matches.
 *
 * The query may not contain whitespace, which is what ends a mention when the reader types a space. It MAY contain `/`,
 * `.` and `-`, because a path does. It may not contain a second `@`, so `@a @b` is two mentions and the caret is in the
 * second.
 *
 * Returns `undefined` when the caret is not in a mention, which is the common case and must be cheap: this runs on every
 * keystroke.
 */
export function mentionAt(text: string, caret: number): Mention | undefined {
  if (caret <= 0 || caret > text.length) return undefined;
  // A mention never spans a newline: the caret is in the line it is in.
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;

  let index = caret - 1;
  while (index >= lineStart) {
    // `noUncheckedIndexedAccess`: indexing a string yields `string | undefined`, and the loop bound does not narrow it.
    const character = text.charAt(index);
    if (character === "@") {
      const before = index > 0 ? text[index - 1] : undefined;
      // Start of text, whitespace, or an opening bracket. Anything else (`word@`, `@`) is not a mention start.
      const isStart =
        before === undefined || /\s/.test(before) || before === "(" || before === "[" || before === '"';
      if (!isStart) return undefined;
      // The `@` must be within `MAX_QUERY` of the caret, for the same reason `references.ts` caps a candidate: a
      // 2000-character "query" is not a path being typed, and scanning it on every keystroke is work for nothing.
      if (caret - index - 1 > MAX_QUERY) return undefined;
      return { start: index, query: text.slice(index + 1, caret) };
    }
    // A whitespace character ends the search: the caret is not in a mention, it is after one.
    if (/\s/.test(character)) return undefined;
    index -= 1;
  }
  return undefined;
}

/** The directory part of a query, with a trailing slash so `""` means the session root. */
function directoryOf(query: string): { directory: string; tail: string } {
  const slash = query.lastIndexOf("/");
  if (slash === -1) return { directory: "", tail: query };
  return { directory: query.slice(0, slash), tail: query.slice(slash + 1) };
}

/**
 * Rank one entry against a query tail.
 *
 * Lower is better. **A directory is offered before an image, always** — and that reverses my first ordering, which put
 * images first on the theory that images are the reason the picker exists.
 *
 * Measured against a real repository root: a bare `@` offered eight images and NOT ONE DIRECTORY, because the root holds
 * dozens of `img_*.png` screenshots and the cap is eight. The reader types `@` intending `assets/shot.png` and cannot see
 * `assets/` at all — the picker is useless in exactly the case it was built for. Images are the reason to finish a path,
 * not the reason to start one.
 *
 * So:
 *
 *   0. directories that start with the tail — including a bare `@`, where every directory starts with the empty string
 *   1. images that start with the tail
 *   2. everything else that starts with the tail
 *   3. anything else that merely CONTAINS it
 *
 * Case-insensitive matching because a filename's capitalisation is not something a reader remembers mid-sentence, and the
 * ORDER inside a band is the listing's own (the orchestrator sorts directory-first, then by name), which keeps the result
 * stable as the reader types instead of reshuffling under the caret.
 */
function rank(entry: Entry, tail: string): number {
  const name = entry.name.toLowerCase();
  const wanted = tail.toLowerCase();
  if (!name.includes(wanted)) return -1;
  const starts = name.startsWith(wanted);
  const image = /\.(png|jpe?g|gif|webp)$/.test(name);

  if (entry.kind === "directory") return starts ? 0 : 3;
  if (image) return starts ? 1 : 3;
  return starts ? 2 : 3;
}

/**
 * Directories that are never offered.
 *
 * A review of the first version flagged `node_modules/` in the default suggestions: noise in a list that will almost never
 * be `@`-mentioned, and on a real repository root it occupies one of six visible rows. These are the three that are
 * *always* noise — dependency trees and version-control internals, never a file a reader wants to point an agent at.
 *
 * Deliberately a short, closed list rather than a pattern. `.github/` and `.idea/` are genuinely useful to mention, and a
 * "hide dotfiles" rule would take them; `dist/` and `build/` are legitimate targets for a question. The test for inclusion
 * is "would a person ever type `@` and mean this", and for these three the answer is no.
 */
const NEVER_OFFERED = new Set(["node_modules", ".git", ".svn"]);

/**
 * What the picker offers for one mention.
 *
 * `entries` is the listing of the directory the query names, or `undefined` when it is not loaded yet — which the caller
 * renders as "reading…" rather than as "nothing matches", because those are different facts and only one of them is worth
 * waiting for.
 *
 * A query naming a directory the session cannot list yields no options and no error: the orchestrator would refuse it, and
 * a refusal in the middle of typing is noise. Typing on is the fix, and the reader is already doing it.
 */
export function complete(mention: Mention, entries: readonly Entry[] | undefined, limit = 8): Completion[] {
  const { directory, tail } = directoryOf(mention.query);

  const ranked: { entry: Entry; rank: number }[] = [];
  for (const entry of entries ?? []) {
    // Never offered at any query: see `NEVER_OFFERED`. Filtered before ranking so it cannot take a visible row from a
    // directory the reader might actually want.
    if (NEVER_OFFERED.has(entry.name)) continue;
    const value = rank(entry, tail);
    if (value >= 0) ranked.push({ entry, rank: value });
  }
  // Stable within a band: `Array.prototype.sort` is stable in every engine this ships to, and the listing arrives
  // sorted, so two entries of equal rank keep the order the orchestrator sent. Sorting by name again would re-order
  // directories among themselves for no gain.
  ranked.sort((left, right) => left.rank - right.rank);

  return ranked.slice(0, limit).map(({ entry }) => ({
    /** What is INSERTED: the whole relative path, not just the name, so a mention in a subdirectory completes. */
    value: directory.length > 0 ? `${directory}/${entry.name}` : entry.name,
    /** What is SHOWN: the name, with a trailing slash for a directory so "continue into me" is visible. */
    label: entry.kind === "directory" ? `${entry.name}/` : entry.name,
    /** Whether choosing this should leave the mention OPEN (a directory) or finish it (a file). */
    continues: entry.kind === "directory",
  }));
}

/** One row of the picker. */
export interface Completion {
  /** What `apply` writes, minus the `@`. */
  value: string;
  /** What the row shows. */
  label: string;
  /** A directory: accepting it keeps the picker open with the mention extended. */
  continues: boolean;
}

/**
 * Replace the mention with a completion, and say where the caret goes.
 *
 * Two behaviours, and the difference is what makes the picker usable rather than merely correct:
 *
 *   - **a file** closes the mention with a trailing space, so the reader keeps typing prose without touching the arrow
 *     keys again;
 *   - **a directory** keeps it open with a trailing slash, so the picker immediately offers what is inside. Selecting a
 *     directory and then having to type `/@` again would make the picker slower than the keyboard.
 *
 * `caret` is the CURRENT caret, not the end of the text, so a mention in the middle of a sentence is replaced in place.
 */
export function apply(
  text: string,
  mention: Mention,
  completion: Completion,
  caret: number,
): { text: string; caret: number } {
  const inserted = completion.continues ? `${completion.value}/` : `${completion.value} `;
  const before = text.slice(0, mention.start);
  const after = text.slice(caret);
  return { text: `${before}@${inserted}${after}`, caret: mention.start + 1 + inserted.length };
}

/**
 * How far to scroll a list so the selected row is fully inside it.
 *
 * ## The defect this fixes
 *
 * Reported from use: *"when the auto-complete helper is opened, the window shall scroll if users use the arrow keys to
 * navigate the list down. Otherwise the selected files / directories cannot be seen."*
 *
 * The list is capped at six rows and scrolls, but nothing tied the SELECTION to the SCROLL. Arrowing past the sixth row moved
 * the highlight to a row that was outside the box, so the picker looked frozen while the reader kept pressing Down — and
 * because the highlight was invisible, so was the answer to "what will Enter accept?"
 *
 * ## Why this is arithmetic rather than `scrollIntoView`
 *
 * `scrollIntoView` scrolls every scrollable ANCESTOR, not just the list. In this app that means the transcript — and on a
 * conversation pinned to the tail, that is a jump of the whole reading area for a keystroke in a helper. So the decision of
 * HOW FAR to move is made here, as a number, and the component assigns it to the list's own `scrollTop`.
 *
 * ## The four cases, and why each returns what it does
 *
 *   - the row is already fully visible → `undefined`, so the caller does nothing and typing does not jitter the list
 *   - the row is ABOVE the viewport → align its top to the top
 *   - the row is BELOW the viewport → align its bottom to the bottom
 *   - the row is taller than the viewport → align its top, which is the only part that can be usefully shown
 *
 * A `padding` parameter exists because the list has vertical padding: without it, a row aligned to `scrollTop` sits flush
 * against the box edge and reads as clipped. The same inset is applied at the end, so the last row can be reached.
 */
export function scrollToShow(
  selected: { top: number; height: number },
  viewport: { scrollTop: number; height: number },
  padding = 0,
): number | undefined {
  if (viewport.height <= 0) return undefined;
  const rowTop = selected.top;
  const rowBottom = selected.top + selected.height;

  // Where the visible band actually starts and ends, allowing for the list's own padding.
  const bandTop = viewport.scrollTop + padding;
  const bandBottom = viewport.scrollTop + viewport.height - padding;

  // Fully visible: do nothing. This is what stops a keystroke that did not change the selection from scrolling the list.
  if (rowTop >= bandTop && rowBottom <= bandBottom) return undefined;

  // Taller than the band: show its top, the only part that identifies it.
  if (selected.height > viewport.height - padding * 2) return Math.max(0, rowTop - padding);

  // Above: bring the top into view.
  if (rowTop < bandTop) return Math.max(0, rowTop - padding);

  // Below: bring the bottom into view.
  return Math.max(0, rowBottom - viewport.height + padding);
}

/**
 * Which completion is highlighted, after a key.
 *
 * Wraps rather than clamping, so pressing Down at the end of a short list returns to the first — the behaviour every
 * command palette has, and the reason a reader can cycle without looking at the count.
 */
export function moveSelection(current: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return ((current + delta) % count + count) % count;
}
