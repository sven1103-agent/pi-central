/**
 * The session rail's geometry and its remembered preferences (issue #275).
 *
 * ## Why the rail stopped being a layout rule
 *
 * The rail used to be a constant: a 288px track in `.panes`, permanently beside the transcript above 1024px and a
 * drawer below it. A report from use at twelve sessions — two running, nine idle — made the cost visible in one
 * screenshot: eleven rows of three lines each, next to a transcript that said "No messages yet". The complaint was
 * *"it becomes distracting if you see it all the time"*, and the honest reading is the one `reading.ts` already
 * recorded for the transcript's measure: there is no single right number, so the number is the reader's.
 *
 * So visibility, width, density and which sections are folded are **preferences** here, stored like
 * `panel.ts`'s and `reading.ts`'s. The breakpoint survives only as a FLOOR: below 1024px the drawer is the only
 * shape that fits, whatever the preference says.
 *
 * ## What the preferences are NOT allowed to do
 *
 *   - **Hide a running session.** `Running`, `Failed` and `Needs you` are not collapsible at all — the section
 *     list in `SessionRail.tsx` decides that, not this module, but the type here is deliberately narrower than
 *     `RailGroup` so the elsewhere-impossible case cannot be spelled.
 *   - **Move on its own.** Nothing here reacts to what a session is doing: the same roster with the same
 *     preferences renders the same rail. A column that folds itself while the reader aims at a row is the failure
 *     `roster.ts` records for row order (#68).
 *   - **Reverse #68 silently.** An existing roster opens with everything expanded, so an upgrade looks identical;
 *     only a roster that is ALREADY large, and has no stored preference yet, starts folded — that is
 *     `initialRailPrefs`, and it is the one place the app chooses for the reader rather than offering a choice.
 *
 * ## Why this is a plain module
 *
 * Drag and keyboard resizing are where the off-by-one and clamp bugs live, and the component tests in this
 * repository render to static HTML, so they cannot exercise a pointer. The arithmetic is pure here for the same
 * reason `panel.ts`'s is.
 */

import { isNearFull } from "./format.ts";

/** Narrower than this and a row's name and its chips collide, so the width stops being a rail and becomes a list. */
export const RAIL_MIN_WIDTH = 220;

/** Above this the rail competes with the transcript rather than sitting beside it. */
export const RAIL_MAX_WIDTH = 480;

/** What the rail has always been, so a reader who never opens Settings sees no change. */
export const RAIL_DEFAULT_WIDTH = 288;

/**
 * The share of the window the rail may ever take.
 *
 * A fraction rather than a constant, for `panel.ts`'s reason: the rail must never be able to swallow the
 * transcript, and on a 2560px window a 480px cap is not the same thing as on a 1280px one. It is a narrower
 * fraction than the panel's 0.6 because the transcript, not the rail, is the primary surface.
 */
export const RAIL_MAX_VIEWPORT_FRACTION = 0.4;

/**
 * One line per row, or all three.
 *
 * `calm` keeps the state edge, the name and the chips, and drops the metrics line — except where that line carries
 * something that changes a decision (see `rowMetricsWorthShowing`). It is the "switcher, not dashboard" reading of
 * the same rail, chosen per reader rather than decided for everyone.
 */
export type RailDensity = "full" | "calm";

/**
 * The groups that may be folded.
 *
 * Deliberately a CLOSED set of two: `needs`, `failed` and `running` are never foldable, because a session blocked
 * on a dialog cannot progress without the reader and a session that is spending money must not be invisible.
 * `stopped` is the group where a fold is a convenience; `idle` is the group that makes a large roster large.
 */
export type RailFoldableGroup = "idle" | "stopped";

export const RAIL_FOLDABLE_GROUPS: readonly RailFoldableGroup[] = ["idle", "stopped"];

/**
 * The roster size above which a fresh preference set starts folded.
 *
 * The one measurement in this module. At the reported twelve sessions, nine of which were idle, the rail rendered
 * roughly thirty-three lines of chrome beside an empty transcript; folding `idle` and `stopped` brings that to
 * about five. Below this threshold the rows themselves are the fleet view and folding them would only hide it.
 */
export const RAIL_CALM_ROSTER_THRESHOLD = 4;

export interface RailPrefs {
  /** Pixels, clamped to what this window can give. */
  width: number;
  density: RailDensity;
  /**
   * Is the rail a summoned overlay instead of a column?
   *
   * A reader preference, not a breakpoint. Below 1024px the answer is forced to `true` by the layout; above it,
   * this is what the reader chose — and with it on, the transcript gets the whole width, which is the only option
   * in issue #275 that actually adds reading room rather than re-arranging what competes for it.
   */
  hidden: boolean;
  /**
   * Reading focus: the window *is* the conversation (issue #275, second slice).
   *
   * On, and the surfaces that exist to describe the fleet rather than the session step out of the way: the topbar
   * collapses to its connection dot, the activity bars narrow, the session header stops being a band beside the prose,
   * and the composer's hint row stops reserving a permanent line. The conversation keeps its lane, its measure and its
   * composer — nothing about reading changes, which is the property that makes this a mode and not a redesign.
   *
   * Off by default, like every preference in this module, so a reader who never asks sees the shipped app.
   */
  focus: boolean;
  /**
   * Which foldable sections are folded.
   *
   * Kept while the rail is hidden, exactly as `PanelPrefs` keeps its mode and width while collapsed: a control
   * that forgets where you left it is a control you stop using.
   */
  collapsed: Record<RailFoldableGroup, boolean>;
}

export const RAIL_PREFS_KEY = "pi-central.rail";

/** Everything expanded, full density, at the width the rail has always had. */
export function defaultRailPrefs(): RailPrefs {
  return {
    width: RAIL_DEFAULT_WIDTH,
    density: "full",
    hidden: false,
    focus: false,
    collapsed: { idle: false, stopped: false },
  };
}

/**
 * The preference set a reader starts with, given how big their roster already is.
 *
 * Only `collapsed` depends on the roster, and only when there is no stored preference yet: an existing reader
 * upgrading must see the app they had, and a newcomer with eleven sessions should not have to discover a setting
 * before the first screen is usable.
 */
export function initialRailPrefs(rowsOnDisk = 0): RailPrefs {
  const prefs = defaultRailPrefs();
  if (rowsOnDisk <= RAIL_CALM_ROSTER_THRESHOLD) return prefs;
  return { ...prefs, collapsed: { idle: true, stopped: true } };
}

/**
 * Does a row show its metrics line — the gauge, `ctx N%` and the queued/failed chips?
 *
 * The rule is **"only when it can change a decision"**, and it replaces "always", which is what the row rendered
 * before issue #275: eleven rows each carrying a 120px gauge and a percentage that was identical across them
 * (`ctx 0%`, `ctx 3%`, `ctx 0%`, `ctx 5%`…). A column of gauges nobody can act on is texture, not information —
 * and it is most of why the rail read as a wall.
 *
 * What stays is exactly what `SessionRail.tsx` says the line is FOR: pressure (a context that will need
 * compaction), work waiting to run, and a failure. Those are the reasons to act on a row, so `calm` keeps them and
 * drops only the rows where the answer is "nothing to do here".
 *
 * A session that is not running has no metrics at all (no process, no measurement) — the same rule as
 * `contextPercent` returning `null` rather than a fabricated zero.
 */
export function showsRowMetrics(
  density: RailDensity,
  session: { contextPercent: number | null; pending: number; state: string } | undefined,
): boolean {
  if (session === undefined) return false;
  if (density === "full") return true;
  return isNearFull(session.contextPercent) || session.pending > 0 || session.state === "failed";
}

/** The widest the rail may be in this window. */
export function railMaxWidth(viewportWidth: number): number {
  const byViewport = Math.max(RAIL_MIN_WIDTH, viewportWidth * RAIL_MAX_VIEWPORT_FRACTION);
  return Math.round(Math.min(RAIL_MAX_WIDTH, byViewport));
}

/** Clamp a requested width to what this window can actually give. */
export function clampRailWidth(width: number, viewportWidth: number): number {
  // A non-finite width arrives from a corrupt `localStorage` value or a `NaN` drag delta. Treated as "no opinion"
  // rather than propagated, because `NaN` in a grid track silently collapses the column and there is no error to
  // notice — the same guard, for the same reason, as `clampPanelWidth`.
  if (!Number.isFinite(width)) return RAIL_DEFAULT_WIDTH;
  return Math.round(Math.min(railMaxWidth(viewportWidth), Math.max(RAIL_MIN_WIDTH, width)));
}

/**
 * The width after dragging the handle by `delta` pixels.
 *
 * `delta` is positive to the RIGHT, which **grows** this column: unlike the panel, the rail sits on the left and its
 * handle is on its own right edge. The sign is inverted here rather than at the call site so there is one place to be
 * wrong, and it is the opposite of `resizePanelBy` for a reason worth reading twice.
 */
export function resizeRailBy(current: number, delta: number, viewportWidth: number): number {
  return clampRailWidth(current + delta, viewportWidth);
}

/**
 * The width after a keyboard nudge. `Home`/`End` jump to the extremes.
 *
 * `Home` is the MINIMUM and `End` the maximum, following the slider convention rather than reading as
 * "left/right" — and, like `resizePanelTo`, not routed through `clampRailWidth(Infinity, …)`, whose non-finite
 * guard would return the default.
 */
export function resizeRailTo(
  key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
  current: number,
  viewportWidth: number,
): number {
  const step = 16;
  switch (key) {
    case "ArrowRight":
      return clampRailWidth(current + step, viewportWidth);
    case "ArrowLeft":
      return clampRailWidth(current - step, viewportWidth);
    case "Home":
      return clampRailWidth(RAIL_MIN_WIDTH, viewportWidth);
    case "End":
      return clampRailWidth(railMaxWidth(viewportWidth), viewportWidth);
  }
}

/**
 * Fold or unfold one section.
 *
 * Returns `prefs` unchanged for a group that is not foldable, so a stale stored value naming `running` cannot
 * produce a folded Running section even if it reaches a caller.
 */
export function toggleFolded(prefs: RailPrefs, group: RailFoldableGroup): RailPrefs {
  if (!RAIL_FOLDABLE_GROUPS.includes(group)) return prefs;
  return { ...prefs, collapsed: { ...prefs.collapsed, [group]: !prefs.collapsed[group] } };
}

/** Is this section folded? A non-foldable group is never folded, whatever the record says. */
export function isFolded(prefs: RailPrefs, group: string): boolean {
  if (group !== "idle" && group !== "stopped") return false;
  return prefs.collapsed[group] === true;
}

/**
 * Read remembered preferences, discarding anything not recognised.
 *
 * Every field validated rather than trusted, for the reason `panel.ts` gives: `localStorage` outlives upgrades
 * and is shared with whatever else runs on this origin, so a stored `density` may name a mode that no longer
 * exists and a stored `width` may be a string.
 *
 * **An ABSENT value and a CORRUPT one are different answers on purpose.** Absent means "this reader has never
 * chosen", so `rowsOnDisk` decides (see `initialRailPrefs`). Corrupt means the store cannot be trusted at all, so the
 * answer is the plain default — open and full — rather than a guess about what a damaged record once said. Degrading
 * a broken record to "your sections are folded" would hide rows on the strength of a value nobody can read.
 */
export function parseRailPrefs(raw: string | null, rowsOnDisk = 0): RailPrefs {
  if (raw === null || raw === "") return initialRailPrefs(rowsOnDisk);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A half-written value from a previous crash. Not worth reporting: the default is correct.
    return defaultRailPrefs();
  }
  if (typeof parsed !== "object" || parsed === null) return defaultRailPrefs();
  const record = parsed as Record<string, unknown>;

  const width = typeof record["width"] === "number" ? record["width"] : RAIL_DEFAULT_WIDTH;
  const density: RailDensity = record["density"] === "calm" ? "calm" : "full";
  const folded = typeof record["collapsed"] === "object" && record["collapsed"] !== null ? (record["collapsed"] as Record<string, unknown>) : {};

  return {
    width: clampRailWidth(width, 1440),
    density,
    // `... === true`, not a truthiness test: `"false"` is a reachable stored value and it must not mean hidden.
    hidden: record["hidden"] === true,
    focus: record["focus"] === true,
    collapsed: {
      idle: folded["idle"] === true,
      stopped: folded["stopped"] === true,
    },
  };
}

/** Serialize for `localStorage`. Beside `parseRailPrefs` so the two cannot drift. */
export function serializeRailPrefs(prefs: RailPrefs): string {
  return JSON.stringify(prefs);
}

/**
 * The CSS declaration a preference set turns into.
 *
 * One custom property, because the grid owns the track definition and `--rail-width` is the only thing JavaScript
 * writes — the rule `--panel-width` established, applied to the other column.
 */
export function railStyle(prefs: RailPrefs): Record<string, string> {
  return { "--rail-width": `${prefs.width}px` };
}

/**
 * The class the shell puts on the app's root for a preference set.
 *
 * A class rather than another custom property, because what focus mode changes is *which surfaces are laid out at all*
 * — a topbar that becomes a dot, a header that stops being a column, a hint row that stops reserving a line. Those are
 * structural, and expressing them as one class keeps every rule in the stylesheet beside the layout it modifies, with
 * one named switch. The alternative — the shell passing a prop through four components — would spread one preference
 * over four files and make "what does focus mode do" unanswerable by reading the stylesheet.
 *
 * `hidden` is deliberately NOT in here: it is a preference about the rail, and the rail's own layout rules already
 * carry it (ADR-0015's "the breakpoint is only a floor" section).
 */
export function appClass(base: string, prefs: RailPrefs, panelCollapsed: boolean): string {
  if (!prefs.focus) return base;
  /*
   * `is-panel-closed` is part of the SAME class list rather than a second stylesheet concern, and it is what keeps
   * reading focus from being a trap.
   *
   * Focus mode hides the session header on the strength of "the Session panel states the same facts" — and the panel is
   * COLLAPSED BY DEFAULT, so that sentence was false out of the box. With focus on, the header hidden and the panel
   * closed, there was no surface for Rename, Stop, Resume, Retry, Delete, the model or the thinking level anywhere:
   * *"i cant see the action bars … where are they"*.
   *
   * Deriving it here rather than from a preference means it cannot disagree with the panel's actual state: the caller
   * passes `panel.collapsed`, which the shell already owns. The stylesheet then scopes the hiding to
   * `:not(.is-panel-closed)`, so the header stays for exactly as long as it is the only place those facts exist.
   */
  return `${base} is-focus${panelCollapsed ? " is-panel-closed" : ""}`;
}
