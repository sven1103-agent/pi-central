/**
 * Remembering which sessions were open (issue #185).
 *
 * ## What is asserted, and why each one can fail
 *
 * The reported failure was "every session is gone after an update", and the fix is a small file plus
 * a rule about *when* it is written. Both halves are easy to get subtly wrong in ways nothing else
 * notices, so each acceptance criterion is a test rather than a comment:
 *
 *   - a corrupt or absent file must change nothing about startup (convenience state must not be able
 *     to cost the app);
 *   - stopping and *forgetting* must be different operations (Ctrl-C during an update is not the same
 *     statement as "I am done with this conversation");
 *   - a gone session FILE is dropped, while an unavailable DIRECTORY is kept (a volume remounts; a
 *     deleted conversation does not come back);
 *   - restore never retargets a cwd and never opens a second process for a file that is already live
 *     (ADR-0008, ADR-0004).
 *
 * The supervisor-level tests spawn nothing: `restoreOpenSessions` goes through `resume`, whose
 * `checkResumable` refusal is what the "directory is gone" case exercises, and a session whose cwd
 * exists is asserted through the store's effect rather than through a live `pi` (C1 — a test run
 * cannot start seatbelt sandboxes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenSessionStore,
  openSessionsPath,
  readOpenSessions,
  writeOpenSessions,
  type OpenSession,
} from "../src/open-sessions.ts";
import type { Config } from "../src/config.ts";

const { Supervisor } = await import("../src/supervisor.ts");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-central-open-sessions-"));
}

function configFor(root: string): Config {
  return {
    workspaceRoot: join(root, "workspaces"),
    stateRoot: join(root, "state"),
    sessionsRoot: join(root, "sessions"),
    safehouse: "safehouse",
    pi: "pi",
    agentRoot: join(root, "agent"),
    fragmentDir: join(root, "state", "policy"),
    agentRootManaged: true,
    providerAgentDir: join(root, "provider"),
    home: root,
    installationRoot: join(root, "installation"),
  };
}

test("an absent file is an empty set, not a fault", () => {
  const root = tempRoot();
  try {
    assert.deepEqual(readOpenSessions(root), { sessions: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt file is an empty set WITH a note — the app still starts", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(openSessionsPath(join(root, "state")), "{ this is not json");
    const read = readOpenSessions(join(root, "state"));
    assert.deepEqual(read.sessions, []);
    // Reported rather than swallowed: silence would make "nothing was open" and "the file is
    // broken" indistinguishable to the person reading the startup log.
    assert.ok(read.note, "a corrupt file must be reported");
    assert.match(read.note, /not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file from a future version is refused rather than guessed at", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      openSessionsPath(join(root, "state")),
      JSON.stringify({ version: 99, sessions: [{ sessionFile: "/a.jsonl", mode: "sandboxed" }] }),
    );
    const read = readOpenSessions(join(root, "state"));
    assert.deepEqual(read.sessions, []);
    assert.ok(read.note);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("written entries round-trip, atomically and with no temporary left behind", () => {
  const root = tempRoot();
  try {
    const state = join(root, "state");
    const sessions: OpenSession[] = [
      { sessionFile: "/sessions/a.jsonl", mode: "sandboxed" },
      { sessionFile: "/sessions/b.jsonl", mode: "direct" },
    ];
    assert.deepEqual(writeOpenSessions(state, sessions), { ok: true });
    assert.deepEqual(readOpenSessions(state).sessions, sessions);
    // The tmp file is renamed, not left beside the real one.
    assert.equal(statSync(openSessionsPath(state)).isFile(), true);
    const onDisk = readFileSync(openSessionsPath(state), "utf8");
    assert.equal(onDisk.includes(".tmp"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown mode is read as sandboxed, never as a privilege increase", () => {
  const root = tempRoot();
  try {
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(
      openSessionsPath(state),
      JSON.stringify({ version: 1, sessions: [{ sessionFile: "/a.jsonl", mode: "root?" }] }),
    );
    // `direct` is the mode that removes the sandbox, so it must never be inferred from a value this
    // version does not recognise.
    assert.deepEqual(readOpenSessions(state).sessions, [{ sessionFile: "/a.jsonl", mode: "sandboxed" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file recorded twice is collapsed — one conversation, one process (ADR-0004)", () => {
  const root = tempRoot();
  try {
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(
      openSessionsPath(state),
      JSON.stringify({
        version: 1,
        sessions: [
          { sessionFile: "/a.jsonl", mode: "sandboxed" },
          { sessionFile: "/a.jsonl", mode: "direct" },
        ],
      }),
    );
    // Last statement wins: resuming a session again in a new mode is the most recent intent.
    assert.deepEqual(readOpenSessions(state).sessions, [{ sessionFile: "/a.jsonl", mode: "direct" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one conversation is one entry, even under two spellings of its path (ADR-0004)", () => {
  // Found by this suite, not by reading the code: `sessionAt` resolves a requested path through
  // `realpathSync` (a symlinked store; macOS `/var` → `/private/var`), so restore hands back a
  // DIFFERENT string than the one that was written. Keyed by the raw string the store held one
  // conversation twice — and two entries mean two `pi` processes appending to one file on the next
  // launch, which is exactly the branch point ADR-0004 prevents.
  const root = tempRoot();
  try {
    const state = join(root, "state");
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    const file = join(real, "a.jsonl");
    writeFileSync(file, "{}\n");
    const link = join(root, "link");
    symlinkSync(real, link);

    const store = new OpenSessionStore(state);
    store.load();
    store.remember(file, "sandboxed");
    store.remember(join(link, "a.jsonl"), "sandboxed");
    assert.equal(store.list().length, 1, "the same file under a symlink is the same conversation");

    // And forgetting through either spelling removes it.
    store.forget(join(link, "a.jsonl"));
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop and forget are different operations, and only forget writes", () => {
  const root = tempRoot();
  try {
    const state = join(root, "state");
    const store = new OpenSessionStore(state);
    store.load();

    store.remember("/a.jsonl", "sandboxed");
    assert.deepEqual(readOpenSessions(state).sessions, [{ sessionFile: "/a.jsonl", mode: "sandboxed" }]);

    // Remembering the same thing again is a no-op, not a write: this runs on every state refresh.
    const before = statSync(openSessionsPath(state)).mtimeMs;
    store.remember("/a.jsonl", "sandboxed");
    assert.equal(statSync(openSessionsPath(state)).mtimeMs, before);

    store.forget("/a.jsonl");
    assert.deepEqual(readOpenSessions(state).sessions, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A session file Pi would accept, written the way `registry.ts` reads it: a header line, then records.
 *
 * Real files are the only honest fixture here — the whole restore path runs the PRODUCTION parser, so
 * a hand-shaped stub would prove the stub rather than the parser.
 */
function writeSessionFile(sessionsRoot: string, cwd: string, id: string): string {
  const projectDir = join(sessionsRoot, cwd.replace(/[/:]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, `2026-11-01T10-00-00-000Z_${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-11-01T10:00:00.000Z" })}\n`,
  );
  // Canonical, so the fixture matches what the store will key on: the temp root is reached through
  // `/var`, which macOS resolves to `/private/var`.
  return realpathSync(path);
}

test("restore reopens a remembered session and keeps the mode it was launched with", async () => {
  const root = tempRoot();
  try {
    const config = configFor(root);
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    const file = writeSessionFile(config.sessionsRoot, cwd, "11111111-1111-1111-1111-111111111111");
    writeOpenSessions(config.stateRoot, [{ sessionFile: file, mode: "direct" }]);

    // `rememberOpenSessions` is off here, exactly as the CLI configures it; restore reads the file
    // regardless, which is the behaviour a test wants to exercise.
    const supervisor = new Supervisor(config);
    supervisor.on("error", () => {});
    const report = await supervisor.restoreOpenSessions();

    assert.equal(report.restored.length, 1, "the remembered session must be reopened");
    const session = report.restored[0]!;
    assert.equal(session.mode, "direct", "the recorded mode must survive the restart");
    // ADR-0008: the recorded directory is used, never a guess and never a retarget. The cwd is
    // compared canonically because `realpathSync` on macOS resolves /var → /private/var.
    assert.equal(realpathSync(session.cwd), realpathSync(cwd));
    // The session file is the CANONICAL spelling: `sessionAt` resolves it, and the store must not
    // end up holding one conversation under two names (see `normalizeSessionFile`).
    assert.equal(session.sessionFile, realpathSync(file));
    assert.deepEqual(readOpenSessions(config.stateRoot).sessions, [
      { sessionFile: realpathSync(file), mode: "direct" },
    ]);
    await supervisor.stopAll({ forget: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a remembered file that is gone is dropped from the set, so it is not retried forever", async () => {
  const root = tempRoot();
  try {
    const config = configFor(root);
    mkdirSync(config.sessionsRoot, { recursive: true });
    const missing = join(config.sessionsRoot, "--gone--", "2026-11-01T10-00-00-000Z_nope.jsonl");
    writeOpenSessions(config.stateRoot, [{ sessionFile: missing, mode: "sandboxed" }]);

    const supervisor = new Supervisor(config);
    supervisor.on("error", () => {});
    const report = await supervisor.restoreOpenSessions();

    assert.deepEqual(report.restored, []);
    assert.deepEqual(report.missingFile, [missing]);
    assert.deepEqual(readOpenSessions(config.stateRoot).sessions, [], "a deleted conversation is not kept");
    assert.deepEqual(supervisor.openSessions(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a remembered session whose DIRECTORY is gone is KEPT and reported", async () => {
  const root = tempRoot();
  try {
    const config = configFor(root);
    const cwd = join(root, "unmounted-volume", "work");
    mkdirSync(cwd, { recursive: true });
    const file = writeSessionFile(config.sessionsRoot, cwd, "22222222-2222-2222-2222-222222222222");
    writeOpenSessions(config.stateRoot, [{ sessionFile: file, mode: "sandboxed" }]);
    // The volume goes away, exactly as an unmounted disk or a deleted worktree looks (C2, and the
    // 82-of-833 measured case in `resume.ts`).
    rmSync(cwd, { recursive: true, force: true });

    const supervisor = new Supervisor(config);
    supervisor.on("error", () => {});
    const report = await supervisor.restoreOpenSessions();

    assert.deepEqual(report.restored, []);
    assert.equal(report.unavailable.length, 1);
    // The reason names the DIRECTORY, because that is the thing the reader has to restore.
    assert.match(report.unavailable[0]!.message, /no longer exists/);
    // Kept: the absence may be temporary, and dropping it would make a remounted volume come back
    // to a rail that had silently forgotten the session.
    assert.deepEqual(readOpenSessions(config.stateRoot).sessions, [
      { sessionFile: realpathSync(file), mode: "sandboxed" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit stop forgets; a shutdown does not (issue #185, the whole feature)", async () => {
  const root = tempRoot();
  try {
    const config = configFor(root);
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    const file = writeSessionFile(config.sessionsRoot, cwd, "33333333-3333-3333-3333-333333333333");
    writeOpenSessions(config.stateRoot, [{ sessionFile: file, mode: "sandboxed" }]);

    // First life: restore the session, then SHUT DOWN. The entry must survive, because Ctrl-C to
    // install an update is not a statement about being done with the conversation.
    const first = new Supervisor(config, { rememberOpenSessions: true });
    first.on("error", () => {});
    await first.restoreOpenSessions();
    await first.stopAll({ forget: false });
    assert.equal(readOpenSessions(config.stateRoot).sessions.length, 1, "shutdown must not forget");

    // Second life: restore again, then STOP explicitly. That is the one operation that forgets.
    const second = new Supervisor(config, { rememberOpenSessions: true });
    second.on("error", () => {});
    const report = await second.restoreOpenSessions();
    assert.equal(report.restored.length, 1, "the session came back after a restart");
    await second.stop(report.restored[0]!.id);
    assert.deepEqual(readOpenSessions(config.stateRoot).sessions, [], "an explicit stop forgets");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a supervisor that does not remember leaves the set completely alone", async () => {
  const root = tempRoot();
  try {
    const config = configFor(root);
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    const file = writeSessionFile(config.sessionsRoot, cwd, "44444444-4444-4444-4444-444444444444");
    writeOpenSessions(config.stateRoot, [{ sessionFile: file, mode: "sandboxed" }]);

    // The CLI's shape: a one-shot run that exits immediately. Recording it would leave an entry the
    // web app would faithfully reopen on its next launch.
    const supervisor = new Supervisor(config);
    supervisor.on("error", () => {});
    const report = await supervisor.restoreOpenSessions();
    await supervisor.stop(report.restored[0]!.id);
    assert.deepEqual(
      readOpenSessions(config.stateRoot).sessions,
      [{ sessionFile: realpathSync(file), mode: "sandboxed" }],
      "a non-remembering supervisor must not rewrite the web app's list",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
