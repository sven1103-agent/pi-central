/**
 * Sorting, paging and selection for the History tab (requested alongside #150).
 *
 * ## Why this is a module and not state inside the component
 *
 * The reader's complaint was precise: *"Nobody can scan 500 sessions."* The tab listed 200 rows in one column with no
 * order and no pages, which is a list you scroll rather than a list you use. Three decisions fix that — sort, page,
 * select — and all three are pure functions over the loaded page, so each is testable without a DOM and the component
 * keeps only the two pieces of view state (which sort, which page).
 *
 * ## What "sort" can and cannot mean here
 *
 * Discovery already returns the newest-first page, and the **loaded page is what is sorted**: this cannot reach session
 * 501 by sorting, because it never sees it. That is a real limit and it is stated in the UI rather than hidden —
 * `historyTotal > history.length` already tells the reader they are looking at a slice.
 *
 * ## Selection is a Set of PATHS, not of sessions
 *
 * A path is the durable identity of a conversation (ADR-0004). An index or an object reference would break the moment
 * the list re-sorts — which happens on every keystroke in the filter — and a selection that silently retargets is the
 * worst possible bug in a bulk delete.
 */
import type { HistoricalSession } from "@pi-central/protocol";

/** The orders a reader actually asks for. */
export type HistorySort = "newest" | "oldest" | "largest" | "name";

export const HISTORY_SORT_LABELS: Readonly<Record<HistorySort, string>> = {
  newest: "Newest first",
  oldest: "Oldest first",
  largest: "Largest first",
  name: "Name A–Z",
};

export const HISTORY_PAGE_SIZE = 25;

/**
 * Sort a page of history.
 *
 * Every comparator ends with `modifiedMs` descending as a tiebreak, so the order is TOTAL: two sessions with the same
 * name, or the same size, still have one defined position. Without that, a re-render could swap two equal rows under
 * the reader's pointer — the same "positions that hold still" complaint the rail settled in #68.
 */
export function sortHistory(
  sessions: readonly HistoricalSession[],
  sort: HistorySort,
): HistoricalSession[] {
  const byNewestFirst = (a: HistoricalSession, b: HistoricalSession) => b.modifiedMs - a.modifiedMs;
  const sorted = [...sessions];

  switch (sort) {
    case "newest":
      sorted.sort(byNewestFirst);
      break;
    case "oldest":
      sorted.sort((a, b) => a.modifiedMs - b.modifiedMs || byNewestFirst(a, b));
      break;
    case "largest":
      sorted.sort((a, b) => b.bytes - a.bytes || byNewestFirst(a, b));
      break;
    case "name":
      /*
       * Case-insensitive, and an UNNAMED session sorts by the label the reader actually sees — a prompt excerpt or a
       * handle — rather than falling into a bucket of empty strings. Sorting by a value the row does not display is how
       * a list looks randomly ordered.
       */
      sorted.sort(
        (a, b) => historyLabel(a).localeCompare(historyLabel(b), undefined, { sensitivity: "base" }) || byNewestFirst(a, b),
      );
      break;
  }
  return sorted;
}

/**
 * The label a History row shows, for sorting.
 *
 * Duplicated from the component's rendering on purpose? No — kept here so the sort cannot disagree with the row. The
 * component imports this too; see `History.tsx`.
 */
export function historyLabel(session: HistoricalSession): string {
  const name = session.name?.trim();
  const chosen =
    name !== undefined && name.length > 0 && !/^(undefined|null)$/i.test(name) && !/^s\d+$/.test(name)
      ? name
      : undefined;
  if (chosen !== undefined) return chosen;
  // The prompt, truncated the way the row truncates it — sorting is on what is visible, not on the full text.
  const prompt = session.firstMessage?.replace(/\s+/g, " ").trim();
  if (prompt !== undefined && prompt.length > 0) return prompt;
  // Scratch sessions have a generic label; a project session falls back to its id, as the row does.
  return session.scratch ? "Scratch session" : session.id;
}

/** How many pages a count needs. Always at least 1, so an empty list still has a page 1 to be on. */
export function pageCount(total: number, pageSize = HISTORY_PAGE_SIZE): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/**
 * One page of rows.
 *
 * `page` is CLAMPED rather than trusted: filtering can shrink the list under a reader who is on page 7, and rendering
 * an empty page because "page 7 of 3" is a blank screen with no explanation. Clamping keeps them on the last page,
 * where the rows are.
 */
export function pageOf(
  sessions: readonly HistoricalSession[],
  page: number,
  pageSize = HISTORY_PAGE_SIZE,
): { rows: HistoricalSession[]; page: number; pages: number; total: number } {
  const pages = pageCount(sessions.length, pageSize);
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (clamped - 1) * pageSize;
  return {
    rows: sessions.slice(start, start + pageSize),
    page: clamped,
    pages,
    total: sessions.length,
  };
}

/**
 * Toggle one row in the selection.
 *
 * Selection is a `Set` of paths, and this returns a NEW set — a mutated set would not re-render, which reads as a
 * checkbox that does not respond.
 */
export function toggleSelected(selected: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(selected);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/**
 * Select or clear every row on the CURRENT page.
 *
 * The page, not the whole list — and that is the safety property, not a limitation. "Select all" over 500 loaded
 * sessions followed by a bulk delete is how a reader deletes things they never looked at. Confining it to the page
 * keeps the blast radius to what is on screen, which is what "select all" means when a list is paged.
 */
export function togglePageSelected(
  selected: ReadonlySet<string>,
  rows: readonly HistoricalSession[],
): Set<string> {
  const paths = rows.map((row) => row.path);
  const allSelected = paths.every((path) => selected.has(path));
  const next = new Set(selected);
  for (const path of paths) {
    if (allSelected) next.delete(path);
    else next.add(path);
  }
  return next;
}

/** Is every row on this page selected? Drives the header checkbox's state. */
export function allOnPageSelected(
  selected: ReadonlySet<string>,
  rows: readonly HistoricalSession[],
): boolean {
  return rows.length > 0 && rows.every((row) => selected.has(row.path));
}

/**
 * Drop selected paths that are no longer in the list.
 *
 * Called after a delete, so the toolbar's count cannot outlive the rows it counts. A stale count is worse than no
 * count: the reader would press "Delete 7" and watch three of them go.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  sessions: readonly HistoricalSession[],
): Set<string> {
  const present = new Set(sessions.map((session) => session.path));
  return new Set([...selected].filter((path) => present.has(path)));
}
