/**
 * The lifecycle decisions: what a close means, what `⌘Q` asks, and whether a recorded orchestrator is adopted
 * (issue #216, criteria 1, 2, 3, 5, 6, 7).
 *
 * ## What this file is, and what it is not
 *
 * It asserts `runtime-record.ts` — the decisions — and not `main.ts`, the wiring. Everything here can fail: each
 * test names a fact that a wrong implementation gets wrong, and the falsification is stated where it is not
 * obvious. What it deliberately cannot claim is that Electron *routes* `⌘Q` to these decisions:
 * `lifecycle-wiring.test.ts` reads the main process for that, and `docs/DOGFOODING` has the manual pass for
 * criteria 4 and 8, which need two live sessions and a real `⌘Q`.
 *
 * ## The defect family these prevent, in one sentence each
 *
 *   - Adopting a PID without proving it is the same process: the window shows a stranger's page, and the
 *     orchestrator that holds every session is never found. This is what `startedAt` and `identityHolds` are.
 *   - Trusting the record because it parsed: a `kill -9` leaves it behind, and "there is a record" is not
 *     evidence of anything (`readRuntimeRecord` refuses three shapes outright).
 *   - Asking "how many sessions" of the shell instead of the supervisor: the dialog names a count that was
 *     right on the day it was written (criterion 3).
 *   - Making the destructive button the default: the state that produced the dialog is "I have work running".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_STOP_CHOICE,
  LIVE_STATES,
  RECORD_VERSION,
  RUNTIME_FILE,
  RETRY_DELAY_MS,
  START_TIME_TOLERANCE_MS,
  STOP_CHOICES,
  UI_MARKERS,
  answerIsOurs,
  choiceIndex,
  decideAttach,
  decideStop,
  identityHolds,
  marksFromEtime,
  probeCommand,
  readRuntimeRecord,
  rememberedMarks,
  removeRuntimeRecord,
  runtimeRecordPath,
  stopDialog,
  stopQuestion,
  urlsFor,
  writeRuntimeRecord,
  type AttachEvidence,
  type ProbeAnswer,
  type RuntimeRecord,
  type SessionSummary,
} from "../src/runtime-record.ts";

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-central-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const NOW = 1_800_000_000_000;

function record(overrides: Partial<RuntimeRecord> = {}): RuntimeRecord {
  return { version: RECORD_VERSION, pid: 4242, port: 51234, startedAt: NOW - 60_000, recordedAt: NOW - 60_000, ...overrides };
}

function ours(overrides: Partial<{ status: number; body: string }> = {}): ProbeAnswer {
  return {
    ok: true,
    status: overrides.status ?? 200,
    location: undefined,
    body: overrides.body ?? `<!doctype html><html><head><link rel="apple-touch-icon" href="/apple-touch-icon.png" /><link rel="manifest" href="/manifest.webmanifest" /><title>Pi Central</title></head><body></body></html>`,
  };
}

const PRESENT = { status: "present" as const, marks: NOW - 60_000, summary: "01:00" };

function evidence(overrides: Partial<AttachEvidence> = {}): AttachEvidence {
  return { record: record(), marks: PRESENT, answer: ours(), expectsNewProcess: false, ...overrides };
}

// -----------------------------------------------------------------------------------------------------------
// Criterion 7 — the record itself: atomic write, tolerant read, removed on a clean quit.
// -----------------------------------------------------------------------------------------------------------

test("the record round-trips, and lands under the app's own data directory", (t) => {
  const dir = tempDir(t);
  const written = writeRuntimeRecord(dir, { pid: 4242, port: 51234, startedAt: NOW - 60_000 });
  assert.deepEqual(written, { ok: true });
  assert.equal(runtimeRecordPath(dir), join(dir, RUNTIME_FILE));

  const { record: read, note } = readRuntimeRecord(dir);
  assert.equal(note, undefined);
  assert.equal(read?.pid, 4242);
  assert.equal(read?.port, 51234);
  assert.equal(read?.startedAt, NOW - 60_000);
  assert.equal(read?.version, RECORD_VERSION);
});

test("the write is a rename, so a reader never sees a half-written record", (t) => {
  const dir = tempDir(t);
  const path = runtimeRecordPath(dir);
  writeRuntimeRecord(dir, { pid: 1, port: 1024, startedAt: 1 });

  const steps: string[] = [];
  const result = writeRuntimeRecord(dir, { pid: 4242, port: 51234, startedAt: NOW }, {
    mkdir: (where) => steps.push(`mkdir ${where}`),
    write: (where, body) => {
      steps.push(`write ${where}`);
      writeFileSync(where, body, "utf8");
    },
    rename: (from, to) => {
      steps.push(`rename ${from} -> ${to}`);
      renameSync(from, to);
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(steps, [
    `mkdir ${dir}`,
    `write ${path}.${process.pid}.tmp`,
    `rename ${path}.${process.pid}.tmp -> ${path}`,
  ]);
  assert.equal(readRuntimeRecord(dir).record?.pid, 4242);
  assert.deepEqual(readdirSync(dir), [RUNTIME_FILE], "the temporary name does not survive a successful write");
});

test("a write that fails at the rename leaves the PREVIOUS record, not a truncated one", (t) => {
  const dir = tempDir(t);
  writeRuntimeRecord(dir, { pid: 1111, port: 1024, startedAt: NOW - 10_000 });

  const result = writeRuntimeRecord(dir, { pid: 4242, port: 51234, startedAt: NOW }, {
    mkdir: () => undefined,
    write: (where, body) => writeFileSync(where, body, "utf8"),
    rename: () => {
      throw new Error("EIO: simulated");
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /could not write/);

  // The whole point of the rename: the old record is still readable, and the dead temporary is gone.
  assert.equal(readRuntimeRecord(dir).record?.pid, 1111);
  assert.deepEqual(readdirSync(dir), [RUNTIME_FILE], "a failed write cleans up its temporary file");
});

test("a clean quit removes the record", (t) => {
  const dir = tempDir(t);
  writeRuntimeRecord(dir, { pid: 4242, port: 51234, startedAt: NOW });
  assert.deepEqual(removeRuntimeRecord(dir), { ok: true });
  assert.deepEqual(readRuntimeRecord(dir), { record: undefined });
  // Removing it twice is not an error: `before-quit` and a crash path can both reach here.
  assert.deepEqual(removeRuntimeRecord(dir), { ok: true });
});

test("a file that does not parse is discarded with a note, never repaired or trusted", (t) => {
  const dir = tempDir(t);
  writeFileSync(runtimeRecordPath(dir), "{ not json", "utf8");
  const read = readRuntimeRecord(dir);
  assert.equal(read.record, undefined);
  assert.match(read.note ?? "", /not valid JSON/);
});

test("a record from another version is discarded, not interpreted", (t) => {
  const dir = tempDir(t);
  writeFileSync(runtimeRecordPath(dir), JSON.stringify({ ...record(), version: 2 }), "utf8");
  const read = readRuntimeRecord(dir);
  assert.equal(read.record, undefined);
  assert.match(read.note ?? "", /version 2/);
});

test("a record naming no process or no port is discarded", (t) => {
  const dir = tempDir(t);
  for (const broken of [
    { version: RECORD_VERSION, pid: 0, port: 1234, startedAt: 1 },
    { version: RECORD_VERSION, pid: 4242, port: 0, startedAt: 1 },
    { version: RECORD_VERSION, pid: 4242, port: 70_000, startedAt: 1 },
    { version: RECORD_VERSION, pid: 4242, port: 1234 },
    { version: RECORD_VERSION, pid: "4242", port: 1234, startedAt: 1 },
  ]) {
    writeFileSync(runtimeRecordPath(dir), JSON.stringify(broken), "utf8");
    assert.equal(readRuntimeRecord(dir).record, undefined, `${JSON.stringify(broken)} is not a usable record`);
  }
});

test("an absent record is the first-launch case, and carries no note", (t) => {
  const dir = tempDir(t);
  assert.deepEqual(readRuntimeRecord(dir), { record: undefined });
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 6 — a stale record is never trusted: gone, reused, or not listening.
// -----------------------------------------------------------------------------------------------------------

test("a PID that is gone yields a fresh spawn", () => {
  const decision = decideAttach(evidence({ marks: { status: "absent", reason: "no process with the recorded PID" } }));
  assert.equal(decision.verdict, "spawn");
  assert.match(decision.reason, /is gone/);
});

test("a PID that now belongs to a different process yields a fresh spawn, and says when it started", () => {
  // PID reuse: the process is alive, but it started AFTER the record says the orchestrator did. The window
  // must not load whatever that process happens to be listening on.
  const decision = decideAttach(
    evidence({ marks: { status: "present", marks: NOW - 5_000, summary: "00:05" } }),
  );
  assert.equal(decision.verdict, "spawn");
  assert.match(decision.reason, /belongs to a different process/);
});

test("a process whose start time cannot be read is alive but not adopted", () => {
  // An OS without `ps -o etime` (`/proc` fallback), or a permissions-restricted host. "A process holds this
  // PID" is not identity, and adopting on it is exactly the PID-reuse hole.
  const decision = decideAttach(evidence({ marks: { status: "present", marks: undefined, summary: "Y 1 2 3" } }));
  assert.equal(decision.verdict, "spawn");
});

test("a live, identified orchestrator that is not listening yields a fresh spawn", () => {
  const decision = decideAttach(
    evidence({ answer: { ok: false, reason: "connect ECONNREFUSED 127.0.0.1:51234", refused: true } }),
  );
  assert.equal(decision.verdict, "spawn");
  assert.equal(decision.delayMs, 0, "a refused port is closed, so binding immediately is safe");
  assert.match(decision.reason, /not listening/);
});

test("a hung socket makes the spawn wait, because the port may still be held", () => {
  const decision = decideAttach(
    evidence({ answer: { ok: false, reason: "the request timed out after 2000 ms", refused: false } }),
  );
  assert.equal(decision.verdict, "spawn");
  assert.equal(decision.delayMs, RETRY_DELAY_MS);
});

test("a port answered by something that is not the UI yields a spawn, after a wait", () => {
  // The case a bare `curl -f http://127.0.0.1:PORT` would call success: a dev server, another app, a leftover
  // `npm run serve`. Loading it would present a stranger's page as Pi Central's.
  const decision = decideAttach(
    evidence({ answer: { ok: true, status: 200, location: undefined, body: "<html><title>Some other app</title></html>" } }),
  );
  assert.equal(decision.verdict, "spawn");
  assert.equal(decision.delayMs, RETRY_DELAY_MS);
  assert.match(decision.reason, /not Pi Central's UI/);
});

test("an error status is not the UI even when the body carries the markers", () => {
  for (const status of [404, 500, 426]) {
    assert.equal(answerIsOurs({ ok: true, status, location: undefined, body: UI_MARKERS.join(" ") }), false);
  }
});

test("the markers are the UI's own head, read from the file that declares them", () => {
  // Pinned against `packages/ui/index.html` rather than a copy of the strings: a rename there must fail here
  // instead of quietly turning every attach into a spawn.
  const html = readFileSync(new URL("../../ui/index.html", import.meta.url), "utf8");
  for (const marker of UI_MARKERS) {
    assert.equal(html.includes(marker), true, `packages/ui/index.html no longer contains ${marker}`);
  }
});

test("a record whose probe could not be run is NOT discarded, and says what it did", () => {
  // The measured `EPERM` case: the shell's own `ps` spawn fails. The orchestrator may be alive holding every
  // session, so the record must survive for the next launch even though this one has to spawn.
  const decision = decideAttach(evidence({ marks: { status: "unknown", reason: "spawn /bin/sh EPERM" } }));
  assert.equal(decision.verdict, "spawn");
  assert.match(decision.reason, /cannot be checked from here/);
  assert.match(decision.reason, /two orchestrators now share your sessions/);
});

test("a re-launch that expects a new process does not adopt the old one", () => {
  // #217's shape: the shell restarted itself after an install. The live process is the OLD version.
  const decision = decideAttach(evidence({ expectsNewProcess: true }));
  assert.equal(decision.verdict, "spawn");
  assert.match(decision.reason, /told to start a new one/);
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 5 — reattach to a live, identified, serving orchestrator.
// -----------------------------------------------------------------------------------------------------------

test("a live, identified orchestrator serving this UI is adopted", () => {
  const decision = decideAttach(evidence());
  assert.equal(decision.verdict, "attach");
  assert.equal(decision.delayMs, 0);
  assert.match(decision.reason, /pid 4242, port 51234/);
});

test("the adoption verdict is reached only when every fact agrees", () => {
  // The falsification for the whole table: one broken fact at a time, and nothing is adopted.
  const broken: Partial<AttachEvidence>[] = [
    { record: undefined },
    { marks: undefined },
    { marks: { status: "absent", reason: "gone" } },
    { marks: { status: "unknown", reason: "EPERM" } },
    { marks: { status: "present", marks: undefined, summary: "?" } },
    { marks: { status: "present", marks: NOW - 1, summary: "00:01" } },
    { answer: undefined },
    { answer: { ok: false, reason: "ECONNREFUSED", refused: true } },
    { answer: ours({ status: 404 }) },
    { answer: ours({ body: "<html><body>hello</body></html>" }) },
    { expectsNewProcess: true },
  ];
  for (const override of broken) {
    assert.notEqual(decideAttach(evidence(override)).verdict, "attach", `adopted with ${JSON.stringify(override)}`);
  }
});

test("the URLs are derived from the port, so a record can never name a different listener than it adopts", () => {
  assert.deepEqual(urlsFor(51234), { url: "ws://127.0.0.1:51234", httpUrl: "http://127.0.0.1:51234" });
  // And the shape matches what the shell already parses from the child, so an adopted orchestrator and a
  // freshly spawned one take exactly the same path through `onAnnounced`.
  assert.equal(urlsFor(51234).httpUrl, `http://${urlsFor(51234).url.slice("ws://".length)}`);
});

// -----------------------------------------------------------------------------------------------------------
// The start-time reading — the fact criteria 5 and 6 both rest on.
// -----------------------------------------------------------------------------------------------------------

test("`ps -o etime=` is read into the same number the record stores", () => {
  assert.equal(marksFromEtime("01:00", NOW), NOW - 60_000);
  assert.equal(marksFromEtime("00:05\n", NOW), NOW - 5_000);
  assert.equal(marksFromEtime("1:00:00", NOW), NOW - 3_600_000, "an hour is `hh:mm:ss` once it exceeds 60 minutes");
  assert.equal(marksFromEtime("2-01:00:00", NOW), NOW - (2 * 86_400 + 3_600) * 1000);
  // Anything else is not a start time. Notably `ps`'s own `lstart` format, which this does NOT parse — the
  // record is written from `etime` so both sides are one measurement rather than two.
  assert.equal(marksFromEtime("Wed Nov  6 10:11:12 2026", NOW), undefined);
  assert.equal(marksFromEtime("", NOW), undefined);
});

test("two readings of one process agree within the tolerance, and a recycled PID does not", () => {
  const recorded = { startedAt: NOW - 60_000 };
  // The second reading is taken a moment after the first, so `etime` differs by up to a second.
  assert.equal(identityHolds(recorded, { status: "present", marks: NOW - 60_000 + 1_000, summary: "01:01" }), true);
  assert.equal(identityHolds(recorded, { status: "present", marks: NOW - 60_000 - 1_000, summary: "00:59" }), true);
  // A PID reused by a process that started a minute later is not the process we recorded.
  assert.equal(identityHolds(recorded, { status: "present", marks: NOW - 1_000, summary: "00:01" }), false);
  // And the tolerance is small enough to be useful: it is seconds, not the minute a reuse window would need.
  assert.ok(START_TIME_TOLERANCE_MS <= 5_000, "a tolerance of minutes would swallow a recycled PID");
});

test("a probe's outcomes are kept apart, including \"I may not look\"", () => {
  assert.deepEqual(rememberedMarks({ ok: true, output: "01:00\n" }, NOW), {
    status: "present",
    marks: NOW - 60_000,
    summary: "01:00",
  });
  // Alive, unidentifiable: the `/proc` fallback and its deliberate marker.
  assert.deepEqual(rememberedMarks({ ok: true, output: "Y 1 (sh) S 0 0 0" }, NOW), {
    status: "present",
    marks: undefined,
    summary: "Y 1 (sh) S 0 0 0",
  });
  // A `ps` that looked and found nothing: the only shape that means "there is nothing to adopt".
  assert.deepEqual(rememberedMarks({ ok: false, output: "" }, NOW), {
    status: "absent",
    reason: "no process with the recorded PID",
  });
  /*
   * And the measured one. This host answers `ps -o etime= -p <live pid>` with exit 1 and
   * `ps: ... Operation not permitted`, which is indistinguishable from "gone" unless the complaint is read —
   * and reading it as "gone" is what would start a second orchestrator over live sessions.
   */
  const refused = rememberedMarks({ ok: false, output: "ps: Operation not permitted\n" }, NOW);
  assert.equal(refused.status, "unknown");
  assert.match(refused.status === "unknown" ? refused.reason : "", /not permitted/);
  // And a probe that never ran is its own answer, never "absent".
  assert.equal(rememberedMarks(undefined, NOW).status, "unknown");
});

test("the probe command merges stderr, so `not permitted` and `no such process` can be told apart", () => {
  const [flag, script = ""] = probeCommand(4242);
  assert.equal(flag, "-c", "the probe runs through sh, because /bin/ps may not be spawnable on a restricted host");
  assert.match(script, /ps -o etime= -p 4242 2>&1/);
  assert.equal(script.includes("2>/dev/null"), false, "discarding the complaint is what makes EPERM look like gone");
  assert.match(script, /\/proc\/4242\/stat/, "and a host without ps still answers whether the PID exists");
});

// -----------------------------------------------------------------------------------------------------------
// Criteria 1–3 — what a close means and what `⌘Q` asks.
// -----------------------------------------------------------------------------------------------------------

test("`⌘Q` with nothing live quits without asking", () => {
  const decision = decideStop([
    { name: "one", cwd: "/a", state: "stopped" },
    { name: "two", cwd: "/b", state: "failed" },
  ]);
  assert.deepEqual(decision, { action: "quit", reason: "no session is running" });
});

test("`⌘Q` with live sessions asks, and the list IS the supervisor's list", () => {
  const sessions: SessionSummary[] = [
    { name: "fix the parser", cwd: "/Users/x/git/parser", state: "streaming" },
    { name: "notes", cwd: "/Users/x/notes", state: "idle" },
    { name: "old", cwd: "/Users/x/old", state: "stopped" },
  ];
  const decision = decideStop(sessions);
  assert.equal(decision.action, "ask");
  if (decision.action !== "ask") return;
  // Verbatim: same objects, same order, same fields — nothing re-derived, no count taken of its own.
  assert.deepEqual(decision.sessions, sessions.filter((session) => session.state !== "stopped"));
});

test("every live state is asked about, and only the two not-running states are not", () => {
  for (const state of LIVE_STATES) {
    assert.equal(decideStop([{ name: "n", cwd: "/c", state }]).action, "ask", `${state} has work to protect`);
  }
  for (const state of ["stopped", "failed"]) {
    assert.equal(decideStop([{ name: "n", cwd: "/c", state }]).action, "quit", `${state} has nothing to keep`);
  }
});

test("the question states the count, in the singular or plural that matches it", () => {
  const { message, detail } = stopQuestion([
    { name: "fix the parser", cwd: "/Users/x/git/parser", state: "streaming" },
    { name: "notes", cwd: "/Users/x/notes", state: "idle" },
  ]);
  assert.match(message, /^2 sessions are still running\. Quit anyway\?$/);
  // The rows are gone by design (see stopDialog); what replaced them is one sentence of context.
  assert.equal(detail.includes("•"), false);
  assert.match(detail, /owned by the orchestrator, not by this window/);
  // Singular, because "1 sessions are still running" is the wording a hurried implementation ships.
  assert.match(stopQuestion([{ name: "only", cwd: "/c", state: "idle" }]).message, /^1 session is still running/);
});

test("the three answers are the slice's words, and Keep is first and default", () => {
  assert.deepEqual(STOP_CHOICES.map((choice) => choice.label), ["Keep sessions running", "Stop them and quit", "Cancel"]);
  assert.equal(DEFAULT_STOP_CHOICE, "detach");
  assert.equal(choiceIndex(DEFAULT_STOP_CHOICE), 0, "the default is the button Electron will select");
  // The destructive answer is not the one Return reaches, and not the one a dismissal reaches.
  assert.notEqual(choiceIndex("stop"), choiceIndex(DEFAULT_STOP_CHOICE));
  assert.equal(choiceIndex("detach"), 0);
  assert.equal(choiceIndex("stop"), 1);
  assert.equal(choiceIndex("cancel"), 2);
});

// -----------------------------------------------------------------------------------------------------------
// Criterion 3 — the dialog Electron is actually handed, not a description of it.
// -----------------------------------------------------------------------------------------------------------

const TWO_LIVE: SessionSummary[] = [
  { name: "fix the parser", cwd: "/Users/x/git/parser", state: "streaming" },
  { name: "notes", cwd: "/Users/x/notes", state: "idle" },
];

test("the dialog handed to Electron has the three answers, Keep first, and Keep as the default", () => {
  const dialog = stopDialog(TWO_LIVE);
  assert.equal(dialog.type, "question");
  assert.deepEqual(dialog.buttons, ["Keep sessions running", "Stop them and quit", "Cancel"]);
  assert.equal(dialog.defaultId, 0, "Return keeps the sessions");
  assert.equal(dialog.buttons[dialog.defaultId], "Keep sessions running");
  assert.equal(dialog.noLink, true, "macOS must not rewrite the button titles");
});

test("Escape keeps the sessions, because `cancelId` is Cancel and not the default", () => {
  // The one mistake this dialog must not make: a dismissal that stops work. Asserted as an identity on the BUTTON, so a
  // reordering of the array cannot silently move what Escape selects.
  const dialog = stopDialog(TWO_LIVE);
  assert.equal(dialog.buttons[dialog.cancelId], "Cancel");
  assert.notEqual(dialog.cancelId, dialog.defaultId, "dismissing and pressing Return are different buttons");
});

test("the count is DERIVED from the list, which is the property criterion 3 was protecting", () => {
  /*
   * Criterion 3 asked for the sessions to be listed by name, and a real run at seven sessions showed why that is wrong:
   * the rail behind the dialog already lists them, better. The dialog now states only how many.
   *
   * What must NOT be lost with the rows is the guarantee underneath them: the number comes from the supervisor's list
   * and is never counted by the shell. That is asserted by feeding lists of known size and reading the sentence — a shell
   * that invented a tally, or cached one, cannot produce four different correct answers from four lists.
   */
  const many = Array.from({ length: 7 }, (_, index) => ({ name: `s${index + 1}`, cwd: `/c/${index + 1}`, state: "idle" }));
  for (const [list, expected] of [
    [many, /^7 sessions are still running/],
    [many.slice(0, 2), /^2 sessions are still running/],
    [many.slice(0, 1), /^1 session is still running/],
  ] as const) {
    assert.match(stopDialog(list).message, expected, `a list of ${list.length} must say ${String(expected)}`);
  }
  // And the singular is not "1 sessions", which is the wording a hurried implementation ships.
  assert.match(stopDialog(many.slice(0, 1)).message, /^1 session is still running/);
});

test("the dialog states the count and no rows, because the rail already shows them", () => {
  /*
   * The reported problem, pinned. At seven sessions the listed rows filled the dialog while the rail behind it showed the
   * same seven — a modal duplicating the app's primary surface, and hiding the sentence the dialog exists to say.
   *
   * A `•` is the shape a row takes, so its absence is the assertion rather than a byte count.
   */
  const many = Array.from({ length: 7 }, (_, index) => ({ name: `session ${index + 1}`, cwd: `/c/${index + 1}`, state: "idle" }));
  const dialog = stopDialog(many);
  assert.equal(dialog.detail.includes("•"), false, "no session rows in the dialog");
  for (const session of many) {
    assert.equal(dialog.detail.includes(session.name), false, `${session.name} must not be named in the dialog`);
    assert.equal(dialog.detail.includes(session.cwd), false, `${session.cwd} must not be printed in the dialog`);
  }
  // What it says instead, and it is the one thing the buttons cannot: the window is not what owns the sessions.
  assert.equal(
    dialog.detail,
    "Quitting the app does not stop them — they are owned by the orchestrator, not by this window.",
  );
});

test("the dialog does not restate its own buttons", () => {
  /*
   * Reported from the same run: the detail named each button, and the per-choice descriptions named them again, directly
   * above three buttons with those labels. A dialog that repeats what is below it is one the reader stops reading.
   */
  const dialog = stopDialog(TWO_LIVE);
  for (const choice of STOP_CHOICES) {
    assert.equal(
      dialog.detail.includes(`${choice.label}: ${choice.detail}`),
      false,
      `the dialog must not repeat "${choice.label}" — the button already says it`,
    );
    assert.equal(choice.detail.length > 0, true, `${choice.label} still documents its consequence, for the tests and the log`);
  }
});

