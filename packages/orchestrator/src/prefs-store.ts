/**
 * The reader's preferences, kept by the installation rather than by a browser origin (issue #285).
 *
 * ## The defect this exists to fix
 *
 * Every preference Pi Central had — the chosen models, the roster, the rail's width, the transcript's measure —
 * lived in `localStorage`, which a browser partitions **per origin**. The desktop shell launches the orchestrator
 * with `--port 0` (ADR-0013 §4: the shell must never pick a port, which is how the `EADDRINUSE` class was made
 * unreachable), so the window loads `http://127.0.0.1:51234` on Monday and `http://127.0.0.1:61802` on Tuesday.
 *
 * Written to the right place, read back from an origin that had never seen it. Nothing failed: the write succeeded,
 * the read returned `null`, and every parser correctly degraded to its default. The reader's set of models was
 * simply gone on every launch and after every update, and twelve keys went with it.
 *
 * A fixed port was the tempting fix and is refused by the same ADR that made the port ephemeral. What the
 * orchestrator has that an origin does not is an identity independent of the port: it serves the *installation*, and
 * its state root (`~/.config/pi-central`) already outlives restarts and updates for the open-session list (#185).
 * So preferences live beside that, in one file.
 *
 * ## What this module does, and what it deliberately does not
 *
 * It stores STRINGS under KEYS and validates only what would damage the store: the key shape, a per-value size, the
 * total size, and that a value is a string. It does not know what a model reference is, what a plausible rail width
 * is, or which panel modes exist — that judgement lives with the module that owns the preference (`model-scope.ts`,
 * `rail-prefs.ts`, `panel.ts`), where it is also tested, and putting a second copy here would create two answers to
 * one question that could disagree after either side changed.
 *
 * The consequence is deliberate and worth stating: a value written by a NEWER build survives a downgrade and is
 * handed unchanged to a reader that understands it, instead of being deleted by a version that does not.
 *
 * ## A corrupt file is reported, and never read as "nothing chosen"
 *
 * This is the one place where the temptation to be forgiving is wrong. An unreadable or unparseable file reported as
 * an empty map would tell the reader "you have never scoped your models" and, worse, would let the next write replace
 * whatever was there. So a failure comes back as a failure, the page keeps what it has in memory, and the surface
 * says so once (`prefs-store.ts` on the UI side).
 *
 * ## Writes are atomic and ordered
 *
 * Temp-then-rename, for the reason `open-sessions.ts` gives: a crash mid-write on a truncating write leaves an empty
 * file, and an empty file reads as "no preferences" — the exact loss this module exists to prevent.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PrefsErrorReason } from "@pi-central/protocol";

/** Where the map lives, under Pi Central's own state root (Q7 — never inside `~/.pi`). */
export function prefsPath(stateRoot: string): string {
  return join(stateRoot, "preferences.json");
}

/**
 * The longest a key may be.
 *
 * Keys are namespaced strings the UI invents (`pi-central.model-scope`), so this is not a format rule — it is a
 * bound that stops a mistaken caller from using the store as arbitrary storage. The value cap below does the same
 * job from the other end.
 */
export const PREFS_KEY_MAX = 64;

/**
 * The longest a single value may be.
 *
 * The measured sizes: the model scope is a few hundred bytes, the roster's 200-entry cap at ~200 bytes a row is
 * ~40 KB, and the panel and rail are under 200 bytes each. 48 KB per value is therefore two orders of magnitude
 * above anything real, and still small enough that a bug cannot fill a disk.
 */
export const PREFS_VALUE_MAX = 48 * 1024;

/**
 * The most one document may hold.
 *
 * Bounded for the reason `roster.ts` bounds its own list: a corrupt or hostile value must not make startup read a
 * hundred megabytes. Every key the app has adds up to well under 64 KB, so this is a ceiling rather than a budget.
 */
export const PREFS_TOTAL_MAX = 256 * 1024;

/** The file's shape. Versioned so a future change can be recognised rather than guessed at. */
interface StoredShape {
  version: 1;
  prefs: Record<string, string>;
}

/** What `readPrefs` answers: the map, or why there is none. */
export type PrefsRead =
  | { ok: true; prefs: Record<string, string> }
  | { ok: false; reason: PrefsErrorReason; message: string };

/**
 * Whether a key is one this store will keep.
 *
 * Restricted to the shape the UI actually uses — `[a-z0-9.-]` — rather than accepting anything. A key with a slash
 * or a NUL in it would be a path or a truncation waiting to happen somewhere downstream, and a key is a name the
 * code chose, so there is no legitimate reason to need those bytes.
 */
export function isPrefsKey(key: string): boolean {
  if (key.length === 0 || key.length > PREFS_KEY_MAX) return false;
  return /^[a-z0-9][a-z0-9.-]*$/i.test(key);
}

/**
 * Read the map, tolerating a missing file and nothing else.
 *
 * `ENOENT` is the normal first run and is an empty map — the state has never been written, so "nothing has been
 * stored" is TRUE. Every other failure is reported as a failure, because the alternative is a claim about the
 * reader's own settings that nothing verified.
 *
 * Duplicate keys cannot occur in a JSON object (the last one wins at parse time), and unknown fields inside the
 * document are ignored rather than rejected: a file written by a newer build must not become unreadable here.
 */
export function readPrefs(stateRoot: string): PrefsRead {
  const path = prefsPath(stateRoot);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, prefs: {} };
    return { ok: false, reason: "unreadable", message: `could not read ${path}: ${(error as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "corrupt", message: `${path} is not valid JSON` };
  }
  const shape = parsed as Partial<StoredShape> | null;
  if (typeof shape !== "object" || shape === null || shape.version !== 1) {
    return { ok: false, reason: "corrupt", message: `${path} is not a recognised preferences file` };
  }
  const source = shape.prefs;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return { ok: false, reason: "corrupt", message: `${path} has no preferences map` };
  }

  const prefs: Record<string, string> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    // One bad entry is DROPPED rather than failing the whole file: a single stale key is not a reason to present the
    // reader with none of their other settings, and the rest of the document is demonstrably readable.
    if (!isPrefsKey(key) || typeof value !== "string" || value.length > PREFS_VALUE_MAX) continue;
    prefs[key] = value;
  }
  return { ok: true, prefs };
}

/** What `writePrefs` answers. Failures are returned, never thrown: a preference is not worth killing a process. */
export type PrefsWrite = { ok: true } | { ok: false; message: string };

/**
 * Sanitise a map a client sent.
 *
 * Returns the entries this store will keep, and DROPS the rest rather than refusing the whole write. A client one
 * version ahead that sends a key this store dislikes must not be the reason the reader's other preferences stop
 * being saved — and the dropped key is not lost, because the client keeps its own copy in memory for the session.
 *
 * The total-size cap is checked on the ACCEPTED set, so a map with one oversized value cannot refuse the fifteen
 * small ones beside it.
 */
export function acceptPrefs(input: Record<string, unknown>): { prefs: Record<string, string>; dropped: string[] } {
  const prefs: Record<string, string> = {};
  const dropped: string[] = [];
  let total = 0;
  for (const [key, value] of Object.entries(input)) {
    if (!isPrefsKey(key) || typeof value !== "string" || value.length > PREFS_VALUE_MAX) {
      dropped.push(key);
      continue;
    }
    if (total + key.length + value.length > PREFS_TOTAL_MAX) {
      dropped.push(key);
      continue;
    }
    total += key.length + value.length;
    prefs[key] = value;
  }
  return { prefs, dropped };
}

/**
 * Write the map, atomically, REPLACING what was there.
 *
 * Replacement rather than a merge, and the difference is not cosmetic: a merge makes a deletion inexpressible, so a
 * key the reader's client removed would return from the file on the next read, forever, with no way to say "this is
 * gone now".
 */
export function writePrefs(stateRoot: string, prefs: Record<string, string>): PrefsWrite {
  const path = prefsPath(stateRoot);
  const body: StoredShape = { version: 1, prefs };
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `could not write ${path}: ${(error as Error).message}` };
  }
}
