/**
 * Completing a directory path from what is already known (issue #76, ADR-0012).
 *
 * ## The half of the complaint that needs no new capability
 *
 * The sheet requires an exact path. Typing `~/git/pro` and having it complete is not a file dialog and does not need
 * one: the candidates are the recent directories (#149) and the folders inside the directory being typed, which are
 * already known or already reachable. This is the part of #76 that costs no new orchestrator surface at all, and it
 * was called out as such when the issue was rewritten.
 *
 * ## Why this is pure, and why it is a separate module
 *
 * It is a string/array function with no I/O and no React, so it is testable as one. That matters because the rules
 * below are the whole feature and each of them is a decision:
 *
 *   - **`~` is expanded before matching, and re-abbreviated after.** A reader types `~/git`, not
 *     `/Users/them/git`, and a suggestion that answers in absolute form is a suggestion they have to edit.
 *   - **Directories only.** A file cannot be a working directory, so a completion that offered one would produce a
 *     row whose only outcome is a refusal.
 *   - **A trailing slash means "look inside".** `~/git/` completes to the folders under `~/git`, not to siblings of
 *     `git` — the distinction between "finish this word" and "start the next one", which every shell makes.
 *   - **Case-insensitive prefix match, and only that.** Fuzzy matching would rank `~/git/portfolio` above
 *     `~/git/project` for `pro`, which is technically a match and practically wrong.
 *
 * What it deliberately does NOT do: sort by anything but the reader's own order. Candidates arrive from the caller in
 * the order they should be shown (recent first, then alphabetical), because "recent" is a fact this module does not
 * have.
 */

/** What completing one input needs: the known directories, and the folders inside the current one. */
export interface CompletionInput {
  /** The text the reader has typed. */
  typed: string;
  /** The orchestrator's `$HOME`, for expanding and re-abbreviating `~`. `undefined` disables both. */
  home: string | undefined;
  /** Directories used before, most recent first. An absolute path each. */
  recent: readonly string[];
  /** Subdirectories of the directory being typed, when the caller has them. Absolute paths. */
  siblings: readonly string[];
  /** Cap on suggestions. Six is what a short list in a 620px sheet can show without scrolling. */
  limit?: number;
}

export interface Completion {
  /** The full path this candidate stands for. What "accept" would put in the input. */
  path: string;
  /** The same path with `~` for `$HOME`, which is what the row SHOWS. */
  display: string;
  /** The part of `display` the reader has already typed, so a row can emphasise the remainder. */
  typedPart: string;
  /** The remainder — what accepting would add. */
  remainder: string;
}

/**
 * Expand a leading `~` to `$HOME`.
 *
 * Only a leading `~` or `~/`: `~someone/else` is another user's home, which this product has no business resolving
 * (and which `$HOME` cannot expand correctly anyway). Returning the input unchanged is the honest answer, and the
 * caller's `startsWith("/")` check then refuses it — visibly, rather than by silently guessing at `/Users/someone`.
 */
export function expandHome(typed: string, home: string | undefined): string {
  if (home === undefined || home === "") return typed;
  if (typed === "~") return home;
  if (typed.startsWith("~/")) return home + typed.slice(1);
  return typed;
}

/** The inverse, for display. */
export function abbreviateHome(path: string, home: string | undefined): string {
  if (home === undefined || home === "") return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * The directory that a partial path is being completed INSIDE.
 *
 * `~/git/pro` → `~/git` (with `pro` as the partial name). `~/git/` → `~/git` (with an empty partial name). This is
 * what tells the caller which directory to ask the orchestrator about, and getting it wrong is how a completion list
 * fills with siblings of the wrong folder.
 */
export function completionBase(typed: string): { dir: string; partial: string } {
  /*
   * A trailing slash falls out of this as `partial: ""`, and that is the point: `~/git/` asks for the folders INSIDE
   * `git`, while `~/git` finishes the word `git`. Stripping the slash before taking the last segment — the obvious
   * way to write this — yields `{ dir: "~", partial: "git" }` and a list of `git`'s SIBLINGS, which is what a failing
   * assertion caught. Every shell makes this distinction and so must a path field.
   */
  const slash = typed.lastIndexOf("/");
  if (slash < 0) return { dir: "", partial: typed };
  // Keep the leading `/` for an absolute path: `/Us` must yield `/`, not `""`, or the base stops being absolute and
  // the orchestrator refuses the listing it is used for.
  return { dir: typed.slice(0, slash) === "" ? "/" : typed.slice(0, slash), partial: typed.slice(slash + 1) };
}

/**
 * The suggestions for what has been typed, in the order given.
 *
 * Order is the caller's, and that is deliberate: it knows "recent" and this does not. Candidates are de-duplicated on
 * the expanded path, so a recent directory that is also a sibling appears ONCE — two rows that accept the same string
 * is the kind of duplicate that makes a list look broken.
 */
export function completeDirectory(input: CompletionInput): Completion[] {
  const { typed, home, recent, siblings, limit = 6 } = input;
  if (typed === "") return [];

  const expanded = expandHome(typed, home);
  const { dir, partial } = completionBase(expanded);

  /*
   * The needle is the partial name, and only when the typed path HAS a directory part.
   *
   * `~/git/pro` completes the entry name `pro…` inside `~/git`. But a bare `/` (or `~`) has no partial name and asks
   * for everything at that level — which is why `partial === ""` must match everything rather than nothing.
   */
  const needle = partial.toLowerCase();

  const candidates: string[] = [];
  // Siblings first when there ARE any: the reader is inside a directory and its contents are what they are looking
  // at. The caller passes them in display order.
  if (dir !== "") for (const path of siblings) candidates.push(path);
  /*
   * Then the recents, filtered to the same directory.
   *
   * A recent path in a DIFFERENT directory is not a completion of this one — `~/git/pro`, with `~/work/project` in the
   * recents, must not offer `~/work/project`. That is a different string being suggested under a prefix it does not
   * share, and accepting it would replace what was typed rather than extend it.
   */
  for (const path of recent) {
    if (dir === "") {
      candidates.push(path);
      continue;
    }
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent === dir) candidates.push(path);
  }

  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const path of candidates) {
    if (seen.has(path)) continue;
    if (!path.startsWith("/")) continue;
    /*
     * The match is on the NAME, not on the whole path.
     *
     * `partial` is one segment, so comparing the full path against it would never match: `~/git/pro` expands to
     * `/Users/x/git/pro`, whose first characters are `/Users/x`, not `pro`. Testing the last segment is the only
     * comparison that answers "does this entry start with what I typed".
     */
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!name.toLowerCase().startsWith(needle)) continue;
    seen.add(path);
    const display = abbreviateHome(path, home);
    /*
     * The split is between what the reader has and what accepting would ADD.
     *
     * `typedPart` is the typed form, not a recomputed prefix: a reader who typed `~` must see `~` emphasised rather
     * than `/Users/them`. The remainder is the rest of the NAME, which is why it is not the rest of the path — the
     * emphasis is on the word being finished, and highlighting `/git/` as "new" would be a lie about what typed text
     * already covers.
     */
    const trailingSlash = typed.endsWith("/");
    out.push({
      path,
      display,
      typedPart: trailingSlash ? display.slice(0, display.length - name.length) : typed,
      remainder: trailingSlash ? name : name.slice(partial.length),
    });
    if (out.length >= limit) break;
  }
  return out;
}
