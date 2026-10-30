/**
 * The rail's composition, remembered across restarts (issue #89).
 *
 * ## The problem
 *
 * The rail is `state.live` — the sessions **this orchestrator process** spawned — so it is empty after a
 * restart, an app update, or a process kill. The maintainer's requirement:
 *
 *   > users see their roster state as they left off. Currently a Pi Central update, a computer restart or a
 *   > process kill would require users to select their roster composition again from scratch.
 *
 * ## Two constraints, and neither is negotiable
 *
 * **1. `id` is not durable.** `Supervisor` allocates `id` from a per-process counter (`s${++this.#created}`),
 * so `s1` after a restart is a DIFFERENT session. A roster keyed by handle would not merely fail to restore —
 * it would point at the wrong conversation, which is worse than not restoring at all.
 *
 * What survives is the session FILE path and Pi's own uuid. This module stores the **file path**: it is the
 * thing discovery already resolves (`HistoricalSession.path`), and it survives a name change and a uuid that
 * Pi has not reported yet.
 *
 * **2. A restored session is NOT live (C3).** "Sessions are files plus private stdio; there is no daemon."
 * After a restart Pi Central cannot know that anything is running, so a restored row must not be drawn as
 * live — that is the exact lie the snapshot rule exists to prevent.
 *
 * ## Where it lives, and why
 *
 * Browser `localStorage`, beside `pi-central.panel` (#75) and `pi-central.reading` (#134). A roster answers
 * *"which sessions do I want in front of me"*, which is a view preference and belongs to one browser profile.
 * `~/.config/pi-central/` is for facts about the INSTALLATION (agent root, ownership mode, credential
 * references per ADR-0010); putting a roster there would make two browsers on one machine fight over one list.
 *
 * ## Nothing about a session's contents is stored
 *
 * This is a list of identifiers and the display facts needed to show a row before discovery answers. No
 * transcript, no prompts, no output.
 */

/**
 * One remembered row.
 *
 * `path` is the only required field: it is the durable identity. Everything else is a hint used to draw the
 * row while discovery is still running, and is replaced by discovery's answer the moment it arrives — so a
 * stale name or a stale `cwd` cannot outlive the first snapshot.
 */
export interface RosterEntry {
  /** The session file. The durable identity. Never `LiveSession.id`. */
  path: string;
  /** Pi's own session uuid, when it was known. A secondary key, for matching if the file moved. */
  sessionId?: string | undefined;
  /** The directory the session worked in, for the row and for `cwdExists` after a restart. */
  cwd?: string | undefined;
  /** What to call it before discovery answers. */
  name?: string | undefined;
}

export const ROSTER_PREFS_KEY = "pi-central.roster";

/**
 * The upper bound on remembered rows.
 *
 * Not a product limit — a corrupt or hostile `localStorage` value must not be able to make the rail build
 * ten thousand rows on boot. 200 is far above the ~10 a person actually works with (the increment's goal:
 * "a fleet of ten sessions is no harder to run than one") and far below anything that costs visibly.
 */
export const ROSTER_MAX = 200;

/** A path that could be a session file: non-empty, absolute, no NUL. */
function isPlausiblePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 4096) return false;
  // The same rejections `files.ts` makes, for the same reason: a NUL truncates in C-level calls, and a
  // relative path has no meaning to a discovery registry resolved against `sessionsRoot`.
  if (value.includes("\u0000")) return false;
  return value.startsWith("/");
}

/** Trim a hint to something a row can render, or drop it. */
function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Read the remembered roster, discarding anything not recognised.
 *
 * Every field validated rather than trusted, for the reason `panel.ts` and `reading.ts` both give:
 * `localStorage` outlives upgrades and is shared with whatever else runs on this origin. A corrupt roster
 * must degrade to "nothing remembered" — an empty rail that fills in from discovery — and never to a broken
 * one.
 *
 * Duplicate paths are collapsed, keeping the FIRST occurrence, because the order is the reader's and the
 * first is the one they put there.
 */
export function parseRoster(raw: string | null): RosterEntry[] {
  if (raw === null || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // A bare array is what `serializeRoster` writes. An object with `entries` is accepted too so a later
  // version can add sibling fields without this parser rejecting the whole value.
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>)["entries"])
      ? ((parsed as Record<string, unknown>)["entries"] as unknown[])
      : [];

  const seen = new Set<string>();
  const entries: RosterEntry[] = [];
  for (const item of list) {
    if (entries.length >= ROSTER_MAX) break;
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const path = record["path"];
    if (!isPlausiblePath(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const entry: RosterEntry = { path };
    const sessionId = optionalText(record["sessionId"], 128);
    if (sessionId !== undefined) entry.sessionId = sessionId;
    // `cwd` is validated as a path rather than as text: it is passed to a spawn decision, and a relative or
    // NUL-bearing value must never reach it.
    if (isPlausiblePath(record["cwd"])) entry.cwd = record["cwd"];
    const name = optionalText(record["name"], 200);
    if (name !== undefined) entry.name = name;
    entries.push(entry);
  }
  return entries;
}

/** Serialize for `localStorage`. Beside `parseRoster` so the two cannot drift. */
export function serializeRoster(entries: readonly RosterEntry[]): string {
  return JSON.stringify(entries.slice(0, ROSTER_MAX));
}

/**
 * Add or move an entry to the FRONT, which is where a session the reader just used belongs.
 *
 * Returns a new array; the caller decides whether to persist. Kept pure so the ordering rule is testable.
 */
export function rememberSession(entries: readonly RosterEntry[], entry: RosterEntry): RosterEntry[] {
  if (!isPlausiblePath(entry.path)) return [...entries];
  const without = entries.filter((existing) => existing.path !== entry.path);
  return [entry, ...without].slice(0, ROSTER_MAX);
}

/** Forget one session — the other half of #87's dismissal, done durably. */
export function forgetSession(entries: readonly RosterEntry[], path: string): RosterEntry[] {
  return entries.filter((entry) => entry.path !== path);
}

/**
 * Build the roster entry for a live session, so the rail can persist what it is showing.
 *
 * `sessionFile` is the durable identity and a session may not have one yet (Pi reports it after `get_state`),
 * in which case there is nothing to remember and this returns `undefined` — better to remember nothing than
 * to remember a handle that will point at a different session after the next restart.
 */
export function rosterEntryFor(session: {
  sessionFile?: string | undefined;
  sessionId?: string | undefined;
  cwd?: string | undefined;
  name?: string | undefined;
}): RosterEntry | undefined {
  if (!isPlausiblePath(session.sessionFile)) return undefined;
  const entry: RosterEntry = { path: session.sessionFile };
  if (session.sessionId) entry.sessionId = session.sessionId;
  if (session.cwd) entry.cwd = session.cwd;
  if (session.name) entry.name = session.name;
  return entry;
}
