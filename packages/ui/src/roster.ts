/**
 * The session roster (issue #89).
 *
 * ## What a roster is
 *
 *   > the app shall maintain the session roster and preserve it so it survives crashes, updates or restarts of
 *   > the orchestrator. It has nothing to do with the sessions activity. […] the fact that users lose their
 *   > session roster (that is the primary purpose of Pi Central) is a no go
 *
 * **The roster is the list of sessions you are working with.** It is the rail. Activity is a *column on each
 * row*, not the axis of the list — a session that is not running is still in your roster, and you prompt it to
 * continue when you want to.
 *
 * ## Why this is a separate module rather than fields on `UiState`
 *
 * The rules here are pure: what counts as a usable entry, how the list joins to live sessions, what happens
 * when one is added twice. Keeping them out of the reducer means they are testable without a store, which is
 * how `scroll.ts`, `panel.ts`, `reading.ts` and `files.ts` are all organised.
 *
 * ## Two mistakes this module is shaped to prevent
 *
 * **1. A second category of session.** An earlier attempt introduced a "remembered" noun and rendered a second
 * rail section for it — so every session appeared twice, one section apart. There is no such category. A session
 * is a session; it is either running or `stopped`, and `stopped` is already in `LiveState`.
 *
 * **2. Deriving the list from what is running.** The same attempt built the persisted list out of `state.live`
 * and retired rows as they came online — write, retire, re-add. Here the roster is the INPUT and activity is
 * joined in for display, so nothing is derived, nothing retires, and the duplication cannot recur.
 *
 * ## Keyed by the session FILE, never by handle
 *
 * `Supervisor` allocates `id` from a per-process counter (`s${++this.#created}`), so `s1` after a restart is a
 * DIFFERENT session. A roster keyed by handle would not fail loudly; it would point at the wrong conversation.
 *
 * ## Where it is stored
 *
 * Browser `localStorage`, beside `pi-central.panel` (#75) and `pi-central.reading` (#134). A roster answers
 * "which sessions am I working with", which is a view preference belonging to one browser profile.
 * `~/.config/pi-central/` is for facts about the INSTALLATION (agent root, ownership mode, credential
 * references per ADR-0010); a roster there would make two browsers on one machine fight over one list.
 *
 * Nothing about a session's contents is stored. This is a list of identifiers.
 */
import type { LiveSession } from "@pi-central/protocol";

/** One entry in the roster. `path` is the only required field: it is the durable identity. */
export interface RosterEntry {
  /** The session file. Survives a restart; never `LiveSession.id`. */
  path: string;
  /** Pi's own uuid, when known. A secondary key if the file ever moves. */
  sessionId?: string | undefined;
  /** The directory it works in, so a row can render before discovery answers. */
  cwd?: string | undefined;
  /** What to call it before anything else answers. */
  name?: string | undefined;
}

export const ROSTER_PREFS_KEY = "pi-central.roster";

/**
 * Upper bound on roster length.
 *
 * Not a product limit — a corrupt or hostile `localStorage` value must not make the rail build ten thousand
 * rows on boot. 200 is far above the ~10 a person works with (Increment 4's goal: "a fleet of ten sessions is
 * no harder to run than one") and far below anything that costs visibly.
 */
export const ROSTER_MAX = 200;

/** A value that could be a path from this app: non-empty, absolute, no NUL. */
function isPlausiblePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 4096) return false;
  // The same rejections `files.ts` makes: a NUL truncates in C-level calls, and a relative path means nothing
  // to `sessionAt`, which resolves against the sessions root.
  if (value.includes("\u0000")) return false;
  return value.startsWith("/");
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function withoutUndefined(entry: RosterEntry): Partial<RosterEntry> {
  const out: Partial<RosterEntry> = {};
  if (entry.sessionId !== undefined) out.sessionId = entry.sessionId;
  if (entry.cwd !== undefined) out.cwd = entry.cwd;
  if (entry.name !== undefined) out.name = entry.name;
  return out;
}

/**
 * Read the roster, discarding anything not recognised.
 *
 * Every field validated rather than trusted, for the reason `panel.ts` and `reading.ts` both give:
 * `localStorage` outlives upgrades and is shared with whatever else runs on this origin. A corrupt roster must
 * degrade to an EMPTY one — which fills in as sessions are used — and never to a broken rail.
 *
 * Duplicate paths collapse, keeping the FIRST: the order is the reader's, and the first is where they put it.
 */
export function parseRoster(raw: string | null): RosterEntry[] {
  if (raw === null || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // A bare array is what `serializeRoster` writes. `{entries: […]} ` is accepted too so a later version can add
  // sibling fields without this parser throwing the whole value away.
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
    if (!isPlausiblePath(path) || seen.has(path)) continue;
    seen.add(path);
    const entry: RosterEntry = { path };
    const sessionId = optionalText(record["sessionId"], 128);
    if (sessionId !== undefined) entry.sessionId = sessionId;
    // Validated AS A PATH, because `cwd` reaches a spawn decision. A relative or NUL-bearing value must never
    // survive parsing; a bad `cwd` drops the FIELD, not the whole entry.
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
 * Add a session, or refresh the hints of one already present.
 *
 * **Order is preserved for an existing entry.** A session that starts running must not jump to the top of a
 * list the reader arranged — that is #68's "positions that hold still" complaint in miniature, and the roster
 * is the one place the order is entirely the reader's.
 *
 * Hints are MERGED rather than replaced: a live session may not know the `name` a previous run recorded, and
 * overwriting with `undefined` would rename a row the reader recognises.
 */
export function addToRoster(entries: readonly RosterEntry[], entry: RosterEntry): RosterEntry[] {
  if (!isPlausiblePath(entry.path)) return [...entries];
  const at = entries.findIndex((candidate) => candidate.path === entry.path);
  if (at >= 0) {
    const next = [...entries];
    next[at] = { ...entries[at]!, ...withoutUndefined(entry) };
    return next;
  }
  return [entry, ...entries].slice(0, ROSTER_MAX);
}

/**
 * Take a session off the roster.
 *
 * The session FILE is not deleted — that is #150, a separate and irreversible action. This only removes the row.
 */
export function removeFromRoster(entries: readonly RosterEntry[], path: string): RosterEntry[] {
  return entries.filter((entry) => entry.path !== path);
}

/**
 * The roster entry for a live session, or `undefined` when it has no durable identity yet.
 *
 * Pi reports `sessionFile` after `get_state`, so a session can exist without one. Remembering nothing is
 * correct: there is no durable key, and inventing one from the handle is the bug this module exists to avoid.
 */
export function rosterEntryFor(session: LiveSession): RosterEntry | undefined {
  if (!isPlausiblePath(session.sessionFile)) return undefined;
  const entry: RosterEntry = { path: session.sessionFile };
  if (session.sessionId) entry.sessionId = session.sessionId;
  if (session.cwd) entry.cwd = session.cwd;
  if (session.name) entry.name = session.name;
  return entry;
}

/**
 * A roster row: an entry, plus the live session it resolves to — or `undefined` when it is not running.
 *
 * There is no second kind of row. `session === undefined` renders the `stopped` chip, which is already in
 * `LiveState` and already has a label. An earlier attempt invented a "remembered" noun for exactly this case
 * and it grew into a second rail section listing every session twice.
 */
export interface RosterRow {
  entry: RosterEntry;
  session: LiveSession | undefined;
}

/**
 * Join the roster with what this process is running. **The roster decides the list; `live` only fills the
 * activity column.**
 *
 * Matching is by session file. Two cases need care:
 *
 * - A live session that is NOT in the roster is appended, after the reader's own entries. It exists; silently
 *   dropping a running process from the rail would be a worse lie than putting it at the end.
 * - A live session with no file yet cannot be matched or stored, so it is appended with its handle as the key.
 *   It becomes a normal entry on the next render after `get_state` answers.
 */
export function rosterRows(entries: readonly RosterEntry[], live: readonly LiveSession[]): RosterRow[] {
  const byFile = new Map<string, LiveSession>();
  for (const session of live) {
    if (session.sessionFile !== undefined) byFile.set(session.sessionFile, session);
  }

  const rows: RosterRow[] = entries.map((entry) => ({ entry, session: byFile.get(entry.path) }));
  const listed = new Set(entries.map((entry) => entry.path));

  for (const session of live) {
    const file = session.sessionFile;
    if (file !== undefined && listed.has(file)) continue;
    const entry = rosterEntryFor(session) ?? {
      // No durable key yet. The handle is used ONLY as a render key, never persisted — `addToRoster` refuses it
      // because it is not an absolute path.
      path: `live:${session.id}`,
      name: session.name,
      cwd: session.cwd,
    };
    rows.push({ entry, session });
  }
  return rows;
}

/**
 * The label for a row's activity column.
 *
 * `stopped` for a session this process is not running. Not "unknown", not "remembered": the reader's question is
 * "is this running", and the answer is no. `stopped` is already in `LiveState`, so this adds no vocabulary.
 */
export function rowActivity(row: RosterRow): string {
  return row.session === undefined ? "stopped" : row.session.state;
}
