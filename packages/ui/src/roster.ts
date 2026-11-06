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
import { nameLabel } from "./format.ts";

/** One entry in the roster. `path` is the only required field: it is the durable identity. */
export interface RosterEntry {
  /** The session file. Survives a restart; never `LiveSession.id`. */
  path: string;
  /** Pi's own uuid, when known. A secondary key if the file ever moves. */
  sessionId?: string | undefined;
  /** The directory it works in, so a row can render before discovery answers. */
  cwd?: string | undefined;
  /**
   * What to call it before anything else answers.
   *
   * Stored RAW, not resolved: the label is decided by `nameLabel`, which needs `scratch` as well. Storing the
   * resolved text was the bug — a scratch session's default name IS its handle, so a restart showed `s2` where
   * the rail had said `Scratch session`, and a value that Pi reported as `undefined` was stored and shown as
   * the word "Undefined".
   */
  name?: string | undefined;
  /**
   * Whether this was a scratch session.
   *
   * Persisted because the LABEL depends on it: an unnamed scratch session must read `Scratch session` after a
   * restart, not `s2` and not `Undefined`. Without this flag the row has no way to know.
   */
  scratch?: boolean | undefined;
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
  if (entry.scratch !== undefined) out.scratch = entry.scratch;
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
    if (typeof record["scratch"] === "boolean") entry.scratch = record["scratch"];
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
 * **A refresh keeps the entry where it is.** Moving on every refresh would reorder the rail dozens of times a second
 * while a session streams — `remember` is dispatched for every live session on every broadcast — so position changes
 * are driven by `moveToFront`, which the reducer calls only when a session's STATE changes.
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
 * Move one entry to the front of the roster.
 *
 * ## Why the array is the clock
 *
 * The rail's sections are rendered by filtering this array in order, so an entry's INDEX is its position within its
 * section. Moving it to the front is therefore all "most recently active first" needs: no timestamp to store and
 * nothing to migrate. `addToRoster` already prepends a new entry, so the two together mean the array is ordered by the
 * last time anything happened to a row.
 *
 * ## The decision this narrows, and why
 *
 * #68 settled that positions must **hold still**, and `addToRoster` preserved order for that reason — a row that jumps
 * while you aim at it is the original complaint. That holds for a row you are *reading*. It does not hold for a section
 * whose whole question is recency: "which of these went quiet last?" was answered by insertion order, which for an old
 * roster is close to arbitrary.
 *
 * So the rule is narrowed rather than dropped. A row moves only when its **state changes** — start, settle, block,
 * fail, stop — an event the reader caused or needs to know about. It never moves while streaming, and never on a mere
 * refresh (see `addToRoster`). The groups keep #68's stable attention order; only the order *within* a group is now
 * recency.
 *
 * Returns the same array when the entry is already first or absent, so a caller cannot trigger a re-render for nothing.
 */
export function moveToFront(entries: readonly RosterEntry[], path: string): RosterEntry[] {
  const at = entries.findIndex((candidate) => candidate.path === path);
  if (at <= 0) return entries as RosterEntry[];
  const next = [...entries];
  const [moved] = next.splice(at, 1);
  return [moved!, ...next];
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
  // Recorded even when false, so a session that is NOT scratch is not mistaken for one after a restart.
  entry.scratch = session.scratch;
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
 *
 * ## Why a removal has to be applied HERE as well as in the reducer (issue #204)
 *
 * Removing the roster entry is not enough to remove the ROW, because this join is what the rail renders and the
 * append loop below is unconditional. `state.roster` could be `[]` and the reader still saw the row: a **stopped**
 * session is in `live` (`stopped` is a state, not an absence, C3), so it came straight back through here on the next
 * render — measured, with the reducer's `forgotten` list correct and populated. The two places must agree, which is
 * why the removal list is an argument rather than something the caller filters afterwards: a filter at the call site
 * would leave this function free to re-add what the caller just dropped, which is the defect itself.
 */
export function rosterRows(
  entries: readonly RosterEntry[],
  live: readonly LiveSession[],
  forgotten: readonly string[] = [],
): RosterRow[] {
  const byFile = new Map<string, LiveSession>();
  for (const session of live) {
    if (session.sessionFile !== undefined) byFile.set(session.sessionFile, session);
  }

  const removed = new Set(forgotten);
  const rows: RosterRow[] = entries.map((entry) => ({ entry, session: byFile.get(entry.path) }));
  const listed = new Set(entries.map((entry) => entry.path));

  for (const session of live) {
    const file = session.sessionFile;
    if (file !== undefined && listed.has(file)) continue;
    // The removal holds unless the session has a PROCESS — see `hasProcess`. A hidden live session would be one the
    // reader cannot stop, so a forgotten row that is running again must be shown, and the reducer spends the removal
    // on the same transition so the next render takes the ordinary path.
    if (file !== undefined && removed.has(file) && !hasProcess(session)) continue;
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

/**
 * Where a row belongs in the rail's attention ordering.
 *
 * The sections are kept deliberately — the maintainer's verdict after using them was *"i now see directly when
 * sth has finished without scrolling"* (#68, settled), so grouping is doing real work that a chip on a stable
 * list would not.
 *
 * A session this process is not running is `stopped`, which is already a section and already in `LiveState`. So
 * a persisted roster adds rows to a group that exists rather than inventing a second list under a second name.
 */
export type RailGroup = "needs" | "failed" | "running" | "idle" | "stopped";

export function groupOf(row: RosterRow): RailGroup {
  const state = row.session?.state;
  switch (state) {
    case "awaiting-approval":
      return "needs";
    case "failed":
      return "failed";
    case "streaming":
    case "starting":
      return "running";
    case "idle":
      return "idle";
    // `registered` and `stopped` and "no live session at all" are the same answer to the reader's question.
    default:
      return "stopped";
  }
}

/** Group rows for the rail, preserving the roster's order WITHIN each group. Empty groups are dropped. */
export function groupRows(rows: readonly RosterRow[]): { group: RailGroup; rows: RosterRow[] }[] {
  const order: RailGroup[] = ["needs", "failed", "running", "idle", "stopped"];
  return order
    .map((group) => ({ group, rows: rows.filter((row) => groupOf(row) === group) }))
    .filter((section) => section.rows.length > 0);
}

/**
 * The live session a parked prompt is waiting for, if it has arrived (issue #89, resume-on-send).
 *
 * ## Why this is a function and not three lines inside an effect
 *
 * Resume-on-send is the only path where a message the reader typed crosses a restart of the session it belongs
 * to. The interesting parts — "which session is this message for", "has it appeared yet", "must it be sent only
 * once" — are exactly the parts that are invisible in a component test, because `renderToString` runs no
 * effects. Pulling the decision out makes it testable; the effect keeps only the sending.
 *
 * ## Why the match is on the FILE
 *
 * Resuming spawns a process that reports a NEW handle (`s1` after a restart is a different session). The roster
 * path is the only durable identity, so it is the only thing the parked message can be matched against.
 */
export function sessionForPendingPrompt(
  pending: { path: string } | undefined,
  live: readonly LiveSession[],
): LiveSession | undefined {
  if (pending === undefined) return undefined;
  return live.find((session) => session.sessionFile === pending.path);
}

/**
 * A label for a row that is NOT running, which is where two sessions can look identical.
 *
 * ## The defect this fixes
 *
 * `rosterEntryFor` persisted `entry.name = session.name`, and until #195 an unnamed project session was named after
 * its **directory**. So a browser's roster holds many entries whose `name` is `data-manager`, all with the same `cwd`
 * line — several distinct sessions rendered as indistinguishable rows. Reported as: *"We have several sessions named
 * data-manager, but they are distinct sessions. That leaves user in a deadlock to select the right session."*
 *
 * ## The rule
 *
 * A stored name is used only when it says something the row does not already say. A name equal to the directory's
 * basename is exactly what the old default produced, and it is the cwd line repeated — so it is treated as a
 * placeholder. What remains is either the reader's own first prompt (the same rule `nameLabel` uses) or a short form
 * of the session's own filename, which is unique by construction.
 *
 * The filename fallback matters on its own: History may not have loaded the session yet, and two rows must still be
 * distinguishable *before* their prompts are known.
 */
export function rosterLabel(entry: RosterEntry, firstPrompt?: string | undefined): string {
  const trimmed = entry.name?.trim();
  // `data-manager` for a session working in `~/git/data-manager` is the directory naming itself, not a title.
  const directoryDerived =
    trimmed !== undefined &&
    trimmed.length > 0 &&
    entry.cwd !== undefined &&
    trimmed.toLowerCase() === baseNameOf(entry.cwd).toLowerCase();

  const usable = directoryDerived ? undefined : trimmed;
  return nameLabel(usable, entry.scratch === true, shortSessionId(entry.path), firstPrompt);
}

/** The last path segment, for the directory-naming comparison. */
function baseNameOf(cwd: string): string {
  return cwd.split("/").filter((part) => part.length > 0).pop() ?? cwd;
}

/**
 * A short, unique, readable stand-in for a session file name.
 *
 * `2026-06-29T11-55-55-038Z_019f133c-6d1e-736f-83e4-b63ddf8ba396.jsonl` becomes `2026-06-29 · 019f133c`: the date says
 * *when*, and the first segment of Pi's uuid is what makes two sessions from the same day tell apart. Truncating the
 * uuid rather than the date is deliberate — a list sorted by recency is already ordered by time, so the date is the
 * redundant half.
 */
export function shortSessionId(path: string): string {
  const file = path.split("/").filter((part) => part.length > 0).pop() ?? path;
  const stem = file.replace(/\.jsonl$/, "");
  const match = /^(\d{4}-\d{2}-\d{2})T[^_]*_(.+)$/.exec(stem);
  if (match === null) return stem;
  return `${match[1]} · ${match[2]!.split("-")[0]!.slice(0, 8)}`;
}

/**
 * Is this row's session actually RUNNING?
 *
 * ## The defect this exists for
 *
 * The rail's controls were gated on `session === undefined`, i.e. "this row has no live session object". But stopping
 * a session does not remove it from the live list — the supervisor keeps it (C3: `stopped` is a state, not an absence)
 * — so after pressing Stop the row had a session, `state === "stopped"`, and therefore **no controls at all**: no
 * Resume, no Forget, no Delete. Reported as: *"the session roster can stop sessions, but then you cant resume them or
 * remove them from the roster."*
 *
 * A stopped session is not running, and every question the rail asks about a row — may I resume it, may I forget it,
 * may I stop it — is about that, not about whether an object exists.
 *
 * `failed` is deliberately NOT included: a failed session has its own Retry, and treating it as "not running" would
 * move it into the stopped-session view and lose that.
 *
 * ## Not the same question as `hasProcess`
 *
 * This answers *"which controls may I offer"*, so `failed` counts — that is how a failed row keeps its Retry instead
 * of collapsing into the stopped view. It is the wrong predicate for *"is this work that must not be hidden"*, and
 * using it there is what made a forgotten FAILED session reappear: `remember` spends a removal when the session is
 * "running again", a failed session is not stopped so it read as running, and the row returned on the next broadcast.
 * Use `hasProcess` for that question.
 */
export function isRunning(session: LiveSession | undefined): boolean {
  return session !== undefined && session.state !== "stopped";
}

/**
 * Does this session have a live PROCESS behind it?
 *
 * The question a removal is spent by (issue #204): work that is actually happening must never be hidden from the
 * rail, because *"a hidden live session would be a session you cannot stop"* (`SessionRail.tsx`). Asked of the
 * STATES rather than of the object, because the supervisor keeps an entry for a dead session (C3) — this is the same
 * distinction `Supervisor#findLiveByPath` draws by excluding `stopped` and `failed`.
 *
 * `registered` is not a process either: it is a file known from discovery (ARCHITECTURE). It is unreachable in this
 * phase — `Supervisor#spawn` starts at `starting` — and it is excluded for the same reason `failed` is, rather than
 * left to be rediscovered as a resurrection bug if it ever becomes reachable.
 *
 * Distinct from `isRunning` on purpose: that one decides which CONTROLS a row offers and includes `failed` so a
 * failed row keeps its Retry. Reusing it here is what let a removed failed session come back.
 */
export function hasProcess(session: LiveSession | undefined): boolean {
  if (session === undefined) return false;
  switch (session.state) {
    case "stopped":
    case "failed":
    case "registered":
      return false;
    default:
      return true;
  }
}
