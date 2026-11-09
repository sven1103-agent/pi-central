/**
 * What quitting means, and how a launch finds the orchestrator a previous one left running
 * (issue #216, ADR-0013).
 *
 * ## Why the decisions are here and not in `main.ts`
 *
 * The same reason `window-security.ts` exists: `main.ts` imports `electron`, which cannot be loaded under
 * `node --test`. Everything this slice is *about* — when a close hides instead of quitting, whether `⌘Q`
 * asks, and whether a recorded PID may be adopted — is a decision over facts, so it lives here where a test
 * can hand it the facts and read the answer.
 *
 * The alternative is a test that spawns Electron and clicks things, which on this project means a test that
 * is skipped on the machine the bug happens on. `runtime-record.test.ts` and `stop-policy.test.ts` assert
 * these directly; `attach-live.test.ts` proves the *probe* against a real listener.
 *
 * ## The rule this file is a consequence of
 *
 * A session is owned by one live process, and a second `pi` appending to one session file is a **branch
 * point** the format cannot detect (C9, ADR-0004). So "start a second orchestrator" is not a convenience
 * question: it is the exact hazard reattaching exists to avoid. Hence the record below is a **hint** that
 * must *prove* itself before it is trusted, and every failure to prove it resolves in the safe direction —
 * a fresh spawn, never a window pointed at a stranger's port.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The file name inside the app's own data directory (`app.getPath("userData")`). */
export const RUNTIME_FILE = "runtime.json";

/** The only shape this version trusts. A record with another version is not guessed at. */
export const RECORD_VERSION = 1;

/**
 * Where the record lives.
 *
 * Under the app's own data directory, which on macOS is `~/Library/Application Support/Pi Central` — a
 * location macOS owns and the reader can find, rather than a dotfile in their home directory. It is *not*
 * under Pi Central's orchestrator state root (`Q7`'s `~/.local/share/pi-central`): that tree belongs to the
 * orchestrator, this file belongs to the shell, and the shell writing into the product's state would be a
 * second writer of a tree it does not own.
 */
export function runtimeRecordPath(appDataDir: string): string {
  return join(appDataDir, RUNTIME_FILE);
}

/** What a launch needs in order to find (and distrust) an orchestrator a previous one started. */
export interface RuntimeRecord {
  version: typeof RECORD_VERSION;
  /** The child's PID. Alone it is not identity — see `startedAt`. */
  pid: number;
  /** The port the child announced. The window's URL is derived from it, never stored separately. */
  port: number;
  /**
   * The child's **start time**, in ms since the epoch, according to the operating system.
   *
   * ## Why this is not `recordedAt`
   *
   * PIDs are recycled. A record that survives a `kill -9` (no clean-quit hook runs) can name a PID that
   * another process now holds, and "the PID is alive" would then be true of a *stranger* — the window would
   * load a different application's loopback UI as Pi Central, and the orchestrator this launch should have
   * adopted would never be found. Comparing the recorded start time against the live process's is what turns
   * "a process with this PID exists" into "this process is the one we recorded" (criterion 6).
   *
   * Measured as `Date.now() - etime` rather than taken from `ps`'s own `lstart` string, because both sides
   * must be *the same fact*: the probe reads `etime` and this is written from `etime`, so the summary the
   * probe prints is the same string (see `rememberedMarks`).
   */
  startedAt: number;
  /**
   * When this record was written, for the log only.
   *
   * Deliberately not used as evidence. A clock that jumps (a laptop resuming from sleep, an NTP correction)
   * would make `Date.now() - startedAt` nonsense for one comparison, and the consequence of trusting that is
   * adopting the wrong process.
   */
  recordedAt: number;
}

/** The URLs derived from a port. One source of truth: a record stores a port, never a URL. */
export function urlsFor(port: number): { url: string; httpUrl: string } {
  return { url: `ws://127.0.0.1:${port}`, httpUrl: `http://127.0.0.1:${port}` };
}

/** What `writeRuntimeRecord` needs: what the child reported, and the marks that identify it. */
export interface RecordedFacts {
  pid: number;
  port: number;
  startedAt: number;
}

/**
 * The three filesystem calls an atomic write makes, injectable so the *order* and the *failure behaviour* can be
 * observed.
 *
 * Injection rather than monkey-patching `node:fs`: a builtin module's namespace object is not writable from ESM, so
 * a test that tried to spy on `renameSync` would either fail to install the spy or pass without ever calling it. The
 * pattern is the one `resolveEnvironment({ runLoginShell })` already uses for the same reason: a step whose failure
 * mode is the point of the step has to be reachable from a test.
 */
export interface RecordIo {
  mkdir(path: string): void;
  write(path: string, body: string): void;
  rename(from: string, to: string): void;
}

/** The real one. Named so `writeRuntimeRecord`'s default is a value rather than a bare `fs` import in its body. */
const RECORD_IO: RecordIo = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  write: (path, body) => writeFileSync(path, body, "utf8"),
  rename: (from, to) => renameSync(from, to),
};

/**
 * Write the record, atomically.
 *
 * The tmp-then-rename pair is the same reasoning as `open-sessions.ts`: a truncating write interrupted by a
 * crash leaves an empty file, and an empty file is indistinguishable from "nothing was recorded" — which is
 * the *safe* reading here (a fresh spawn) but also a silent loss of the thing the record exists for. With a
 * rename, a reader sees either the previous record or the new one, and a write whose rename never happens
 * leaves the previous record intact rather than a truncated one.
 *
 * Failures are reported, not thrown. A record that cannot be written costs one reattach — the orchestrator
 * itself is already running and must not be killed over it.
 */
export function writeRuntimeRecord(
  appDataDir: string,
  facts: RecordedFacts,
  io: RecordIo = RECORD_IO,
): { ok: true } | { ok: false; message: string } {
  const path = runtimeRecordPath(appDataDir);
  const record: RuntimeRecord = {
    version: RECORD_VERSION,
    pid: facts.pid,
    port: facts.port,
    startedAt: facts.startedAt,
    recordedAt: Date.now(),
  };
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    io.mkdir(dirname(path));
    io.write(temporary, `${JSON.stringify(record, null, 2)}\n`);
    io.rename(temporary, path);
    return { ok: true };
  } catch (error) {
    // The temporary file is removed on the way out, so a failed write cannot accumulate siblings that the next
    // launch would have to reason about. Deleting it is best-effort: the failure being reported is the write.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Nothing to add: the caller is told about the failure that caused this path.
    }
    return { ok: false, message: `could not write ${path}: ${(error as Error).message}` };
  }
}

/**
 * Read the record, tolerating every failure.
 *
 * A record that does not parse, has another version, or names an impossible PID is **discarded** rather than
 * repaired: this file is a hint about a process, and a hint that cannot be read is not a hint. The `note` is
 * separate from "no record" so the log can distinguish "this is the first launch" from "the record was
 * corrupt", which are different facts a reader may need.
 */
export function readRuntimeRecord(
  appDataDir: string,
): { record: RuntimeRecord | undefined; note?: string } {
  const path = runtimeRecordPath(appDataDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { record: undefined };
    return { record: undefined, note: `could not read ${path}: ${(error as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { record: undefined, note: `${path} is not valid JSON, so it was ignored` };
  }
  const shape = parsed as Partial<RuntimeRecord> | null;
  if (typeof shape !== "object" || shape === null) {
    return { record: undefined, note: `${path} does not hold a record, so it was ignored` };
  }
  if (shape.version !== RECORD_VERSION) {
    return { record: undefined, note: `${path} is version ${String(shape.version)}, and this shell reads ${RECORD_VERSION}` };
  }
  const { pid, port, startedAt, recordedAt } = shape;
  const usable = (value: unknown, low: number, high: number): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
  if (!usable(pid, 2, 2 ** 31 - 1) || !usable(port, 1, 65535) || !usable(startedAt, 0, Number.MAX_SAFE_INTEGER)) {
    return { record: undefined, note: `${path} does not name a process and a port, so it was ignored` };
  }
  return {
    record: {
      version: RECORD_VERSION,
      pid,
      port,
      startedAt,
      recordedAt: typeof recordedAt === "number" ? recordedAt : 0,
    },
  };
}

/** Remove the record. Called on a clean quit, and before a spawn that is about to replace it. */
export function removeRuntimeRecord(appDataDir: string): { ok: true } | { ok: false; message: string } {
  const path = runtimeRecordPath(appDataDir);
  try {
    rmSync(path, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `could not remove ${path}: ${(error as Error).message}` };
  }
}

/**
 * How long a probe of a remembered process may take.
 *
 * Short on purpose. A launch that blocks for seconds before deciding is a launch with a blank window, and the
 * two outcomes it decides between (adopt, or spawn a fresh one) are both reached without its answer.
 */
export const PROBE_TIMEOUT_MS = 2000;

/**
 * A command that prints the marks of one PID, or fails if there is no such process.
 *
 * ## Why one small shell script rather than `node:child_process`'s own answers
 *
 * `process.kill(pid, 0)` answers "may I signal it", which is not the same question: on macOS it returns
 * `EPERM` for a process the caller may not signal *and* for one that does not exist, so a permission denial
 * reads as "gone" — the failure that would make the shell spawn a second orchestrator beside a live one.
 *
 * **This was measured, not assumed.** Under an agent harness, `process.kill(1, 0)` returned `EPERM` and
 * `/bin/ps` could not even be spawned (`spawnSync` reported `EPERM`), while `/bin/sh` ran normally — so the
 * probe's own command has to be `sh`, and a `ps` that cannot answer arrives as a *complaint on stdout* rather
 * than as a spawn failure. Both cases reach `rememberedMarks` as `unknown`, which is never `absent`.
 *
 * ## What it prints
 *
 * `ps -o etime= -p N` — elapsed time, from the operating system, in the second-resolution form
 * `[[dd-]hh:]mm:ss`. It is the fact `RuntimeRecord.startedAt` is written from, and `marksFromEtime` turns it
 * back into the same number, so the two sides of the comparison are one measurement rather than two.
 *
 * `2>&1` is load-bearing: `ps` exits 1 for a PID that does not exist **and prints nothing**, and exits 1 with
 * `ps: ... Operation not permitted` when it may not ask. Merging the streams is what lets the two be told
 * apart. The fallback reads `/proc/N/stat` and prints a field starting `Y` — a deliberate marker that says
 * "this is not an `etime`, it is a start-time-ish value from a host without `ps`", which `rememberedMarks`
 * reports as alive with no marks rather than comparing apples to oranges. Linux is not a supported host (C10);
 * the fallback exists so a CI runner or a container gets the *liveness* answer without a false identity match.
 */
export function probeCommand(pid: number): string[] {
  return [
    "-c",
    `ps -o etime= -p ${pid} 2>&1 || { [ -r /proc/${pid}/stat ] && sed 's/^/Y /' /proc/${pid}/stat; }`,
  ];
}

/** One probe's output, as the probe reports it. `output` is stdout and stderr merged by `probeCommand`. */
export interface ProbeOutput {
  /** True when the command exited 0. `false` means "no such process" *or* "I may not ask" — see below. */
  ok: boolean;
  output: string;
}

/** What a probe said about the remembered PID. */
export type ProcessMarks =
  /** The process is not there. */
  | { status: "absent"; reason: string }
  /**
   * The process is there, and its start time is known (or is not — an OS without `etime`).
   *
   * `marks: undefined` is *alive without proof of identity*, which `decideAttach` refuses to adopt: it is the
   * `EPERM`-for-a-stranger-the-caller-cannot-signal case, and adopting on "some process holds this PID" is
   * the PID-reuse hole this whole file closes.
   */
  | { status: "present"; marks: number | undefined; summary: string }
  /** The probe could not be made to run at all. Never treated as absent. */
  | { status: "unknown"; reason: string };

/**
 * Read `ps -o etime=`'s output into the marks the record stores.
 *
 * Exported because the live test asserts the round trip: the number this produces from a real process is the
 * number `writeRuntimeRecord` will be given, and the comparison in `decideAttach` depends on that being one
 * fact rather than two.
 */
export function marksFromEtime(etime: string, now: number): number | undefined {
  const text = etime.trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  if (match === null) return undefined;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  const total =
    Number(days) * 86_400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  // `etime` rounds to the second, and the record is written from a reading taken up to a probe ago, so the
  // number is `now - elapsed` with up to a second of drift in each direction. See `START_TIME_TOLERANCE_MS`.
  return now - total * 1000;
}

/**
 * How far apart two measurements of one process's start time may be and still be that process.
 *
 * Two seconds: `etime` is truncated to a whole second, and the two readings are taken at different instants
 * (the second one after a spawn was observed, a port bound, and a record written). Anything wider starts to
 * be wide enough to swallow a *recycled* PID — the reuse window on macOS is large, but a tolerance of seconds
 * is still thousands of times narrower than it.
 */
export const START_TIME_TOLERANCE_MS = 2000;

/**
 * Turn one probe's output into marks.
 *
 * The four cases, and why they are four:
 *
 *   - **exit 0 with a parseable `etime`** → present, with proof.
 *   - **exit 0 with anything else** (the `/proc` fallback's `Y …`) → present, *without* proof. Alive, but not
 *     identifiable, so it may not be adopted.
 *   - **a non-zero exit with a permission complaint** → unknown. This is the measured `EPERM` case: a `ps` that
 *     may not look exits 1 and says so, and treating that as "gone" is what would start a second orchestrator
 *     beside a live one.
 *   - **a non-zero exit with nothing to say** → absent. `ps -p N` prints nothing at all for a PID that does not
 *     exist, which is the only shape that means "there is nothing to adopt".
 *   - **no process started at all** (`sh` itself refused, or no `spawn`) → unknown, for the same reason.
 */
export function rememberedMarks(output: ProbeOutput | undefined, now: number): ProcessMarks {
  if (output === undefined) {
    return { status: "unknown", reason: "the process probe could not be run at all" };
  }
  const text = output.output.trim();
  if (!output.ok) {
    if (COMPLAINT.test(text)) return { status: "unknown", reason: text };
    return {
      status: "absent",
      reason: text === "" ? "no process with the recorded PID" : `no process with the recorded PID (${text})`,
    };
  }
  const marks = marksFromEtime(output.output, now);
  return { status: "present", marks, summary: text };
}

/**
 * What a tool says when it was not allowed to answer.
 *
 * Deliberately narrow. A `ps` that cannot look prints `Operation not permitted` (macOS, and what this host does),
 * `Permission denied`, or an `EPT…`/`EPERM` errno; a `ps` that looked and found nothing prints nothing. Anything
 * broader would start classifying ordinary diagnostics as a refusal, and the cost of a false `unknown` is only a
 * spawn with a warning — while the cost of a false `absent` is a second orchestrator over live sessions.
 */
const COMPLAINT = /not permitted|permission denied|operation not allowed|EPERM/i;

/** Whether the recorded process is still the one we recorded. */
export function identityHolds(record: Pick<RuntimeRecord, "startedAt">, marks: ProcessMarks): boolean {
  if (marks.status !== "present" || marks.marks === undefined) return false;
  return Math.abs(marks.marks - record.startedAt) <= START_TIME_TOLERANCE_MS;
}

/** What asking the remembered port for `/` produced. */
export type ProbeAnswer =
  /** The request completed. `status` is the HTTP status; `location` is a `Location` header, if any. */
  | { ok: true; status: number; location: string | undefined; body: string }
  /** The request did not complete. `refused` is true when nothing was listening on the port. */
  | { ok: false; reason: string; refused: boolean };

/**
 * Whether a failed request means **nothing is listening**, as opposed to something that is listening and did not
 * answer.
 *
 * ## Why this reads `cause` and not the message
 *
 * `fetch` reports every network failure as `TypeError: fetch failed` and puts the errno in `error.cause`. A check
 * written against the message therefore classifies a closed port and a hung socket identically — and the two
 * lead to different decisions: a closed port is a fresh bind with no wait, while a socket that accepted and
 * never answered may mean the port is still held (`decideAttach`'s `delayMs`). Measured on this machine: a
 * connect to a closed ephemeral port surfaces as `Error: fetch failed` with `cause.code === "ECONNREFUSED"`.
 *
 * The chain is walked because the cause of a `fetch` failure is sometimes wrapped again (`undici` nests it
 * under a `cause` of its own), and stopping at the first level would silently report "not refused" for a closed
 * port — the failure that makes every launch wait a full second before spawning.
 *
 * Only `ECONNREFUSED` counts. A timeout, an abort, a DNS failure and a TLS complaint are all "the port was not
 * proven free", and treating any of them as refused would remove the wait in the one case it is needed.
 */
export function connectionRefused(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    const code = (current as { code?: unknown }).code;
    if (code === "ECONNREFUSED") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The string that makes an answer Pi Central's, copied from `packages/ui/index.html`.
 *
 * ## Why the marker is its own file's markers and not "it answered at all"
 *
 * A port is not an identity. Any local process can listen on the port a stale record names — after a reboot
 * the port is simply free for whoever asks, and a person running a dev server has a dozen of them. Loading
 * whatever answers would present a stranger's page as Pi Central's UI, in a window with a dock icon, which is
 * exactly the claim `window-security.ts` spends its whole length preventing.
 *
 * The three markers are all in the UI's own `<head>` and in no HTTP error page: `apple-touch-icon.png` (a
 * stable path the UI links, issue #124), `manifest.webmanifest`, and `<title>Pi Central</title>`. Checked as
 * substrings because the served document is the *built* `index.html`, whose form no test here may pin.
 */
export const UI_MARKERS = ["apple-touch-icon.png", "manifest.webmanifest", "<title>Pi Central</title>"] as const;

/**
 * Whether an answer came from the UI this app serves.
 *
 * `status` must be 200: a 404 that happens to carry the markers is a static handler answering about a
 * different root, and the seek is only followed when its target is the page.
 *
 * A reply that is up and is **not** ours sends its `Location` with the seek (`/` is answered with
 * `index.html`'s `307` on some builds). That is still the same listener — refusing a redirect simply because
 * it is a redirect would refuse the orchestrator for a fact about its static handler, not about identity, and
 * the markers are checked on the other side.
 */
export function answerIsOurs(answer: ProbeAnswer): boolean {
  if (!answer.ok) return false;
  if (answer.status === 200) return UI_MARKERS.every((marker) => answer.body.includes(marker));
  return false;
}

/**
 * Verdicts `decideAttach` can reach.
 *
 * Two, not three. An earlier draft had a `takeover` verdict for "the port answers but it is not ours", which
 * is not an outcome a shell can have: it holds no authority to stop a process it did not start, and the port
 * it would then compete for is one it never chose (`--port 0`, ADR-0013 §4). The case is a `spawn` with a
 * delay, and the reason says what is in the way — stating it as a distinct verdict made it look like an action.
 */
export type AttachVerdict = "attach" | "spawn";

export interface AttachDecision {
  verdict: AttachVerdict;
  /** One sentence for the log. It names the evidence, because "attach" with no reason is unauditable. */
  reason: string;
  /** How long to wait before spawning. Non-zero only when the remembered port may still be held. */
  delayMs: number;
}

/** Everything `decideAttach` may consult. Assembled by `main.ts`, which is the only part that can probe. */
export interface AttachEvidence {
  /** The record, or `undefined` for a first launch / a discarded one. */
  record: RuntimeRecord | undefined;
  /** The probe's answer about the remembered PID. `undefined` when there was no record to probe. */
  marks: ProcessMarks | undefined;
  /** The answer from the remembered port. `undefined` when there was no record to ask about. */
  answer: ProbeAnswer | undefined;
  /**
   * Whether this launch is *expected* to be a different process — an update re-launch (#217).
   *
   * An adopted process would be the old version running the old code, which is precisely what an update
   * re-launch exists to replace. The shell is told this by its own argv rather than inferring it, so the
   * adoption rule stays a rule and not a guess about why it was started.
   */
  expectsNewProcess: boolean;
}

/**
 * Decide whether to adopt the remembered orchestrator or start a fresh one.
 *
 * ## The order, and why it is this order
 *
 * Each step is cheaper and more fundamental than the next, and each one that fails ends the enquiry — there
 * is no point asking a port about a process that is gone, and no point comparing marks that do not exist.
 *
 *   1. **No record** → spawn. The ordinary first-launch path.
 *   2. **The PID is gone** → spawn, and the record is removed: nothing to attach to, and keeping it would
 *      mean re-probing a dead PID on every launch.
 *   3. **The PID is alive but is a different process** → spawn. This is the PID-reuse case, and it is why
 *      `startedAt` is stored. It is also why the check comes before the port is asked: a stranger's port must
 *      not be asked at all, and a stranger's *listening* process must never look like evidence.
 *   4. **The probe could not be made** → spawn, and **never remove the record**. This is the case where the
 *      shell's own process listing is restricted (`EPERM`, measured): the orchestrator may well be alive and
 *      holding every session, so starting beside it is the branch point C9 forbids — but there is nothing
 *      else this launch can do, and the record is left intact so the *next* launch can still adopt. The
 *      reason says so, because "spawned despite a record" is a fact a reader must be able to see.
 *   5. **The port does not answer** → spawn. Alive but not listening is a process that is still starting (its
 *      announcement came from a port that has since closed) or one that is wedged; adopting it would show a
 *      window that can never connect.
 *   6. **Something answers and it is not this UI** → spawn, and wait before binding: whatever holds the port
 *      is not ours and has not been told to stop, so the spawn may well race it for the ephemeral port. The
 *      wait is `RETRY_DELAY_MS` rather than a guess about the port, because the shell never picks ports
 *      (ADR-0013 §4) and cannot ask for a different one.
 *   7. **It answers with the UI we serve** → attach. Every fact this launch could check agreed.
 *
 * `expectsNewProcess` is consulted after identity: a re-launch that finds the same live process must not
 * adopt it, because the whole point of the launch is that a new version was installed.
 */
export function decideAttach(evidence: AttachEvidence): AttachDecision {
  const { record, marks, answer, expectsNewProcess } = evidence;
  if (record === undefined) {
    return { verdict: "spawn", reason: "no orchestrator was recorded by a previous launch", delayMs: 0 };
  }
  const named = `the recorded orchestrator (pid ${record.pid}, port ${record.port})`;

  if (marks === undefined) {
    return { verdict: "spawn", reason: `nothing is known about ${named}`, delayMs: 0 };
  }
  if (marks.status === "unknown") {
    return {
      verdict: "spawn",
      reason:
        `${named} cannot be checked from here (${marks.reason}), so this launch starts its own. ` +
        `If that process is still running, two orchestrators now share your sessions; quit this one and reattach by hand.`,
      delayMs: 0,
    };
  }
  if (marks.status === "absent") {
    return { verdict: "spawn", reason: `${named} is gone (${marks.reason})`, delayMs: 0 };
  }
  if (marks.marks === undefined) {
    return {
      verdict: "spawn",
      reason: `${named} is alive but this host does not say when it started, so it cannot be identified`,
      delayMs: 0,
    };
  }
  if (!identityHolds(record, marks)) {
    const started = new Date(marks.marks).toISOString();
    return {
      verdict: "spawn",
      reason:
        `pid ${record.pid} now belongs to a different process (it started at ${started}), ` +
        `so the record was left by something that has exited`,
      delayMs: 0,
    };
  }
  if (expectsNewProcess) {
    return {
      verdict: "spawn",
      reason: `pid ${record.pid} is the orchestrator being replaced, and this launch was told to start a new one`,
      delayMs: 0,
    };
  }
  if (answer === undefined) {
    return { verdict: "spawn", reason: `${named} was not asked for its UI`, delayMs: 0 };
  }
  if (!answer.ok) {
    return {
      verdict: "spawn",
      reason: `${named} is alive but is not listening on port ${record.port} (${answer.reason})`,
      // A refused connection means the port is closed, and a fresh bind is safe immediately. Anything else
      // (a socket that accepted and then hung) may mean the port is still held, so wait one retry's worth.
      delayMs: answer.refused ? 0 : RETRY_DELAY_MS,
    };
  }
  if (!answerIsOurs(answer)) {
    const where = answer.location === undefined ? "" : ` (it redirects to ${answer.location})`;
    return {
      verdict: "spawn",
      reason:
        `port ${record.port} is answered by something that is not Pi Central's UI${where}; ` +
        `this launch starts its own orchestrator on its own port`,
      delayMs: RETRY_DELAY_MS,
    };
  }
  return {
    verdict: "attach",
    reason: `${named} is running and serving Pi Central's UI, so this window loads it instead of starting a second orchestrator`,
    delayMs: 0,
  };
}

/** How long to wait before a spawn that may race something for the remembered port. */
export const RETRY_DELAY_MS = 1000;

/**
 * The states in which a session has a process behind it.
 *
 * `registered` is included: a session Pi Central knows about but has not finished starting is still one whose
 * restoration is at stake, and `⌘Q`'s question exists to protect exactly that work. `stopped` and `failed`
 * are not — there is nothing running to keep, and asking about them would train the reader to dismiss the
 * dialog.
 */
export const LIVE_STATES = ["registered", "starting", "idle", "streaming", "awaiting-approval"] as const;

/** The part of a session the question names. A structural copy, so no protocol type is imported. */
export interface SessionSummary {
  name: string;
  cwd: string;
  state: string;
}

/** What `⌘Q` should do, given what is live. */
export type StopDecision =
  /** Nothing is running: quit, and stop the child as part of it. */
  | { action: "quit"; reason: string }
  /** Something is running: ask, and name these. */
  | { action: "ask"; sessions: SessionSummary[] };

/**
 * Decide whether `⌘Q` asks.
 *
 * ## Why the list comes from the caller and not from a count
 *
 * The dialog's contents are the supervisor's own session list (`list()`), passed through unchanged. A shell
 * that kept its own tally would answer a different question than "which sessions are running", and the
 * failure is silent: the count would be right on the day it was written and wrong the first time a session
 * fails to start. `stop-policy.test.ts` asserts the dialog is *built from* a list it hands over.
 */
export function decideStop(sessions: readonly SessionSummary[]): StopDecision {
  const live = sessions.filter((session) => (LIVE_STATES as readonly string[]).includes(session.state));
  if (live.length === 0) return { action: "quit", reason: "no session is running" };
  return { action: "ask", sessions: live };
}

/** One button in the question. `id` is what the answer is compared against; the label is what is read. */
export interface StopChoice {
  id: "detach" | "stop" | "cancel";
  label: string;
  detail: string;
}

/**
 * The three answers, in the order they are shown.
 *
 * **Keep sessions running is first and is the default** (criterion 3). Ordering is not cosmetic here: the
 * destructive choice must not be the one a reader reaches by pressing Return or by dismissing the dialog with
 * the keyboard, because the state that got them here is "I have work running".
 *
 * The labels are the slice's own words — `Keep sessions running`, `Stop them and quit`, `Cancel` — and they
 * are asserted rather than written in `main.ts`, because a dialog is the one place where the wording *is* the
 * interface.
 */
export const STOP_CHOICES: readonly StopChoice[] = [
  { id: "detach", label: "Keep sessions running", detail: "They keep writing to their session files, and the next launch reattaches to them." },
  { id: "stop", label: "Stop them and quit", detail: "The orchestrator is asked to stop every session cleanly before it exits." },
  { id: "cancel", label: "Cancel", detail: "Nothing is stopped and the app stays open." },
];

/** The choice a dismissal or Return selects. Named rather than a literal `0` in `main.ts`. */
export const DEFAULT_STOP_CHOICE: StopChoice["id"] = "detach";

/**
 * The whole `dialog.showMessageBox` argument, as data.
 *
 * ## Why this is a function and not four lines in `main.ts`
 *
 * A dialog is the one surface where the wording, the order and the default *are* the behaviour, and `main.ts` cannot be
 * loaded by a test. Leaving the object inline meant criterion 3 could only be checked by a person clicking three
 * buttons — which is exactly the kind of claim that silently rots when a label is reworded or `cancelId` is dropped.
 *
 * So the object is built here, asserted in `runtime-record.test.ts`, and `main.ts` does nothing but hand it to Electron.
 * What a test can then say is the thing that matters: the buttons are these three, in this order, Keep is the default,
 * and Escape (which reaches `cancelId`) keeps the sessions.
 *
 * `noLink` is set because macOS otherwise rewrites the button titles; `type: "question"` puts the app icon on it. Neither
 * is cosmetic drift — a dialog whose buttons do not say what the code decided is the failure this prevents.
 */
export function stopDialog(sessions: readonly SessionSummary[]): {
  type: "question";
  buttons: string[];
  defaultId: number;
  cancelId: number;
  message: string;
  detail: string;
  noLink: true;
} {
  const { message, detail } = stopQuestion(sessions);
  return {
    type: "question",
    buttons: STOP_CHOICES.map((choice) => choice.label),
    defaultId: choiceIndex(DEFAULT_STOP_CHOICE),
    /*
     * `Escape` maps to Cancel, NOT to the default.
     *
     * The two happen to differ here, and the difference is deliberate: Return means "the default", which keeps the
     * sessions, while Escape means "get me out of this", which must also keep them. Both are safe, and both must be safe
     * for different reasons — an implementation that pointed `cancelId` at `Stop` would make a dismissal stop work.
     */
    cancelId: choiceIndex("cancel"),
    message,
    /*
     * The per-choice descriptions are deliberately NOT appended here.
     *
     * They were, and the dialog became a wall of text that repeated each button label immediately above the button —
     * at seven sessions the list was pushed out of view entirely. The labels say what each button does; `StopChoice.detail`
     * remains, and is asserted, so the wording has one home and the dialog has one job.
     */
    detail,
    noLink: true,
  };
}

/**
 * Which choice a `dialog.showMessageBox` response index means.
 *
 * Exists so `main.ts` and the verification script agree on the mapping, and so an index out of range resolves to the
 * default rather than to `undefined`. A dialog response the shell does not recognise must keep the sessions — the same
 * direction as a dialog that could not be shown.
 */
export function chooseAnswer(response: number): StopChoice["id"] {
  return STOP_CHOICES[response]?.id ?? DEFAULT_STOP_CHOICE;
}

/** The index `dialog.showMessageBox` needs for its `cancelId`/`defaultId`, derived from the list above. */
export function choiceIndex(id: StopChoice["id"]): number {
  const index = STOP_CHOICES.findIndex((choice) => choice.id === id);
  // Not `-1`, which Electron reads as "no button": a missing choice would otherwise make the default the
  // last one, i.e. `Cancel`, and dismissing the dialog would silently do nothing.
  return index === -1 ? 0 : index;
}

/** The sentence above the list: how many, named. Pluralised here so both surfaces say the same thing. */
export function stopQuestion(sessions: readonly SessionSummary[]): { message: string; detail: string } {
  const count = sessions.length;
  const noun = count === 1 ? "session is" : "sessions are";
  const heading = `${count === 1 ? "1" : String(count)} ${noun} still running.`;
  /*
   * The list, in a form a reader can scan.
   *
   * The directory is the part that disambiguates — several sessions can share a name — so it is not dropped. An
   * unreadably long path is shortened at the FRONT, because the leaf directory is what identifies a project while
   * `/Users/someone/…` is the same for every row.
   */
  const rows = sessions.map((session) => `• ${session.name} — ${shorten(session.cwd)}`);
  return {
    message: `${heading} Quit anyway?`,
    /*
     * Three lines, and the third is the only sentence that is not already visible somewhere else.
     *
     * An earlier version restated all three button labels here, so the dialog said "Choose Keep sessions running… or
     * Stop them and quit…" directly above two buttons with those exact labels, and then the per-choice descriptions
     * (`stopDialog` appends them) said it a third time. A dialog that repeats its own buttons is a dialog the reader
     * stops reading — and at seven sessions the repetition pushed the list itself off the top of the text.
     *
     * What is left is what the buttons cannot say: that the window is not the thing keeping the sessions alive.
     */
    detail: `Quitting the app does not stop them — they are owned by the orchestrator, not by this window.\n\n${rows.join("\n")}`,
  };
}

/**
 * A path shortened from the front, for a dialog row.
 *
 * Front, not back: the leaf is what names the project. `…/git/pi-central-dev` is recognisable at a glance, while
 * `/Users/sven1103/git/idea-fa…` is a row that has to be read twice. `MAX_ROW_PATH` is generous enough that an ordinary
 * path is untouched.
 */
export function shorten(path: string, max = MAX_ROW_PATH): string {
  if (path.length <= max) return path;
  const keep = max - 1;
  const tail = path.slice(path.length - keep);
  // Cut on a separator where there is one, so the result does not begin mid-segment.
  const boundary = tail.indexOf("/");
  return `…${boundary === -1 ? tail : tail.slice(boundary)}`;
}

/** How much of a session's directory one dialog row shows. */
export const MAX_ROW_PATH = 52;
