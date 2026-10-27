/**
 * The right panel's geometry and its remembered preferences (issue #8, reworked).
 *
 * ## Why the panel stopped being "the inspector"
 *
 * The inspector was a fixed 320px column of session facts. Issue #8 put a file tree and a document
 * view in it, and the result was unusable — measured in a real window: the document text was clipped
 * mid-word (`Notable changes per release. Forr…`) with a horizontal scrollbar, because 320px minus
 * padding is not a readable measure. The panel now has **modes** and is **resizable**, which is what
 * a region that hosts a document needs.
 *
 * ## Why this logic is a plain module
 *
 * Drag and keyboard resizing are where the off-by-one and clamp bugs live, and a React component
 * cannot be exercised for them by the component tests in this repository (they render to static HTML
 * with `renderToStaticMarkup`, which runs no event handlers). So the arithmetic lives here, pure and
 * testable, and the component is left with wiring only.
 */

/** Narrower than this and the mode tabs plus a path stop fitting on one line. */
export const PANEL_MIN_WIDTH = 280;

/**
 * The widest the panel may be dragged, as a fraction of the window.
 *
 * A fraction rather than a constant because the panel must never be able to swallow the transcript:
 * on a 1440px window a 900px cap is most of the room, and on a 2560px one it is not. The transcript
 * is the primary content; the panel is a view onto it.
 */
export const PANEL_MAX_VIEWPORT_FRACTION = 0.6;

/** Above this the panel may be dragged; below it there is nothing to share. */
export const PANEL_ABSOLUTE_MAX = 1200;

/** The width a fresh panel starts at, and what a double-click on the handle restores. */
export const PANEL_DEFAULT_WIDTH = 360;

/**
 * The width at which `Files` mode can show the tree and the document side by side.
 *
 * **This constant is mirrored in `styles.css`**, which cannot import TypeScript. The two are kept in
 * step by a test that reads the stylesheet and asserts the number appears there — see
 * `panel.test.ts`. That is a blunt check, and it is deliberate: the alternative is a container-query
 * breakpoint that silently disagrees with the documented one, which is a class of bug this project
 * has hit before (the inspector rendered `127.2M` while the strip beside it rendered `12723914`).
 */
export const FILES_SPLIT_MIN_WIDTH = 560;

/**
 * The width at which `Files` mode opens the panel if the user has never dragged it.
 *
 * Entering `Files` at 360px would reproduce the original defect — a clipped document — so the panel
 * widens once, to a width where a file is readable. It happens **only** while `userSized` is false;
 * once the user has chosen a width, nothing moves the panel again. A panel that resizes itself after
 * you have placed it is worse than one that is too narrow.
 */
export const PANEL_FILES_DEFAULT_WIDTH = 720;

/** The widest the panel may be in this window. */
export function panelMaxWidth(viewportWidth: number): number {
  return Math.min(PANEL_ABSOLUTE_MAX, Math.max(PANEL_MIN_WIDTH, viewportWidth * PANEL_MAX_VIEWPORT_FRACTION));
}

/** Clamp a requested width to what this window can actually give. */
export function clampPanelWidth(width: number, viewportWidth: number): number {
  // A non-finite width can arrive from a corrupt `localStorage` value or a `NaN` drag delta. Treated
  // as "no opinion" rather than propagating, because `NaN` in a grid track silently collapses the
  // panel to nothing and there is no error to notice.
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(panelMaxWidth(viewportWidth), Math.max(PANEL_MIN_WIDTH, width)));
}

/**
 * The width after dragging the handle by `delta` pixels.
 *
 * `delta` is positive to the RIGHT, so it *reduces* the panel: the handle sits on the panel's left
 * edge, and dragging it right gives room to the transcript. Getting this sign wrong is the classic
 * bug here, and it is inverted in the component rather than at the call site so there is one place
 * to be wrong.
 */
export function resizePanelBy(current: number, delta: number, viewportWidth: number): number {
  return clampPanelWidth(current - delta, viewportWidth);
}

/**
 * The width after a keyboard nudge. `Home`/`End` jump to the extremes.
 *
 * `Home` is the MINIMUM and `End` the maximum, following the slider convention rather than reading
 * as "left/right". They are not routed through `clampPanelWidth(Infinity, …)`: the non-finite guard
 * there treats `Infinity` as "no opinion" and returns the default, so `End` would have jumped to
 * 360px instead of the widest the window allows.
 */
export function resizePanelTo(
  key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
  current: number,
  viewportWidth: number,
): number {
  const step = 16;
  switch (key) {
    case "ArrowLeft":
      // Left WIDENS the panel: the handle sits on the panel's left edge.
      return clampPanelWidth(current + step, viewportWidth);
    case "ArrowRight":
      return clampPanelWidth(current - step, viewportWidth);
    case "Home":
      return clampPanelWidth(PANEL_MIN_WIDTH, viewportWidth);
    case "End":
      return clampPanelWidth(panelMaxWidth(viewportWidth), viewportWidth);
  }
}

/** Which view the panel is showing. Two, and the union is closed so a switch must handle both. */
export type PanelMode = "session" | "files";

export interface PanelPrefs {
  width: number;
  mode: PanelMode;
  /**
   * Is the panel hidden?
   *
   * **Collapsed is the default** (issue #75). The panel is a special-purpose view — session audit
   * facts, or a file browser — not something to look at while working, and on a normal window it took
   * roughly as much room as the transcript. The transcript is the primary surface; keeping the panel
   * open for the whole session spends the widest column in the window on material nobody is reading.
   *
   * The width and mode are still remembered while collapsed, so re-opening returns the panel to where
   * the user left it rather than to a fresh default.
   *
   * Deliberately `... !== false` when parsing: the field is absent for anyone who has used an earlier
   * build, and absent must mean the new default rather than "false". */
  collapsed: boolean;
  /**
   * Has the user chosen this width, or is it still the default?
   *
   * This is the flag that stops the panel auto-widening for `Files` *after* the user has placed it.
   * Without it, entering `Files` would undo a deliberate drag, every time.
   */
  userSized: boolean;
}

export const PANEL_PREFS_KEY = "pi-central.panel";

export function defaultPanelPrefs(): PanelPrefs {
  return { width: PANEL_DEFAULT_WIDTH, mode: "session", userSized: false, collapsed: true };
}

/**
 * Read remembered preferences, discarding anything not recognised.
 *
 * Every field is validated rather than trusted. `localStorage` is shared with whatever else runs on
 * this origin and survives upgrades, so a stored `mode` may name a mode that no longer exists and a
 * stored `width` may be a string or `NaN`. Returning `undefined` for the width and letting the
 * caller clamp means a corrupt value degrades to the default rather than to a collapsed panel.
 */
export function parsePanelPrefs(raw: string | null): PanelPrefs {
  const fallback = defaultPanelPrefs();
  if (raw === null || raw === "") return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A half-written value from a previous crash. Not worth reporting: the default is correct.
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;
  const record = parsed as Record<string, unknown>;
  const mode: PanelMode = record["mode"] === "files" ? "files" : "session";
  const width = typeof record["width"] === "number" ? record["width"] : fallback.width;
  return {
    width,
    mode,
    userSized: record["userSized"] === true,
    // Only an explicit `false` opens the panel. A missing field (an older stored value) and any
    // unrecognised value both mean the default, which is collapsed.
    collapsed: record["collapsed"] !== false,
  };
}

/** Serialize for `localStorage`. Kept beside `parsePanelPrefs` so the two cannot drift. */
export function serializePanelPrefs(prefs: PanelPrefs): string {
  return JSON.stringify(prefs);
}
