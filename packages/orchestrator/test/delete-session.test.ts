/**
 * Deleting a session's transcript (issue #150).
 *
 * ## Why every refusal here is a test rather than a comment
 *
 * This is the **only irreversible operation in the program**. A stopped session can be resumed, a renamed one keeps
 * its history, a rejected prompt costs a retype — a deleted transcript is gone. So the checks are not "does the happy
 * path work" but "can this be made to delete the wrong thing", and each one is a case:
 *
 *   - a path outside the store, spelled `..` or absolute or through a SYMLINK;
 *   - an entry inside the store that is not a session file;
 *   - a directory;
 *   - and the sidecar, which is the half that would otherwise leave the store growing invisibly.
 *
 * The symlink test is the one worth reading: containment is checked on the RESOLVED path, so a link inside the store
 * pointing at `~/.ssh` fails. Testing the unresolved path would pass and then delete whatever it pointed at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSessionFile } from "../src/delete-session.ts";

/** A store shaped like the real one: `<root>/<project-dir>/<stem>.jsonl` plus an optional `<stem>/` sidecar. */
function store() {
  const root = mkdtempSync(join(tmpdir(), "pi-central-delete-"));
  const project = join(root, "--Users-x-git-project--");
  mkdirSync(project, { recursive: true });
  return { root, project };
}

function sessionFile(project: string, stem = "2026-11-01T10-00-00-000Z_abc") {
  const path = join(project, `${stem}.jsonl`);
  writeFileSync(path, '{"type":"session","version":3}\n');
  return path;
}

test("a stopped session's transcript and its sidecar are both removed", () => {
  const { root, project } = store();
  try {
    const path = sessionFile(project);
    const stem = path.slice(0, -".jsonl".length);
    // The sidecar is a DIRECTORY named after the transcript's stem — measured on a real store.
    mkdirSync(join(stem, "subagent-run"), { recursive: true });
    writeFileSync(join(stem, "subagent-run", "log.txt"), "x");
    // Resolved BEFORE the delete: the sidecar is gone afterwards, so `realpathSync` here would be asking a deleted
    // path what its canonical form is.
    const canonicalStem = realpathSync(stem);

    const result = deleteSessionFile({ sessionsRoot: root }, path);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Compared canonically: macOS resolves the temp root through `/private`, so the reported path is the resolved
    // one — which is exactly what the function should report, since it deleted the resolved path.
    assert.equal(result.sidecar, canonicalStem, "the sidecar is reported as removed");
    assert.equal(existsSync(path), false, "the transcript is gone");
    assert.equal(existsSync(stem), false, "and so is the sidecar — leaving it would grow the store invisibly");
    assert.equal(result.sidecarFailure, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session with no sidecar deletes cleanly and does not invent one", () => {
  const { root, project } = store();
  try {
    const path = sessionFile(project);
    const result = deleteSessionFile({ sessionsRoot: root }, path);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.sidecar, undefined);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path OUTSIDE the store is refused, and nothing is removed", () => {
  const { root } = store();
  const outside = mkdtempSync(join(tmpdir(), "pi-central-outside-"));
  try {
    const victim = join(outside, "important.jsonl");
    writeFileSync(victim, "do not delete\n");

    const result = deleteSessionFile({ sessionsRoot: root }, victim);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "outside-store");
    assert.equal(existsSync(victim), true, "the file is untouched — this is the point of the check");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a SYMLINK inside the store pointing outside it is refused, and its target survives", () => {
  // The reason containment is tested on the RESOLVED path. A link is a contained-looking name for an uncontained
  // file, and this operation cannot be undone.
  const { root, project } = store();
  const outside = mkdtempSync(join(tmpdir(), "pi-central-outside-"));
  try {
    const victim = join(outside, "id_rsa.jsonl");
    writeFileSync(victim, "secret\n");
    const link = join(project, "innocent.jsonl");
    symlinkSync(victim, link);

    const result = deleteSessionFile({ sessionsRoot: root }, link);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "outside-store");
    assert.equal(existsSync(victim), true, "the link's target must survive");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("`..` cannot climb out of the store", () => {
  const { root, project } = store();
  try {
    const victim = join(root, "sibling.jsonl");
    writeFileSync(victim, "x\n");
    // A path that resolves one level up from a project directory, still spelled relative to a real file.
    const traversal = join(project, "..", "sibling.jsonl");
    const result = deleteSessionFile({ sessionsRoot: root }, traversal);
    // It IS inside the store, so this one is allowed — the assertion is that the ANSWER is about containment, not
    // that the string was rejected. A `..` that stays inside is legitimate (the same rule `resolveWithin` applies).
    assert.equal(result.ok, true);
    assert.equal(existsSync(victim), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-session file inside the store is refused", () => {
  const { root, project } = store();
  try {
    const notes = join(project, "notes.txt");
    writeFileSync(notes, "keep me\n");
    const result = deleteSessionFile({ sessionsRoot: root }, notes);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "not-a-session");
    assert.equal(existsSync(notes), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a DIRECTORY is refused rather than removed recursively", () => {
  // `rmSync` without `recursive` throws on a directory, but the explicit check states the intent: this deletes a
  // transcript, and a directory is not one.
  const { root, project } = store();
  try {
    const dir = join(project, "sidecar-without-a-session");
    mkdirSync(dir);
    const result = deleteSessionFile({ sessionsRoot: root }, dir);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "not-a-file");
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file that is not there is a plain not-found, not a failure", () => {
  const { root, project } = store();
  try {
    const result = deleteSessionFile({ sessionsRoot: root }, join(project, "never-existed.jsonl"));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "not-found");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a NUL byte is malformed input, not an escape attempt", () => {
  const { root } = store();
  try {
    const result = deleteSessionFile({ sessionsRoot: root }, `/x\0/y.jsonl`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "not-a-file", "named as what it is, so nobody hunts for a traversal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing store reports that, rather than an empty success", () => {
  const root = join(tmpdir(), "pi-central-store-that-is-not-there");
  const result = deleteSessionFile({ sessionsRoot: root }, join(root, "a.jsonl"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not-found");
  assert.match(result.message, /store does not exist/);
});

test("deleting one session leaves its siblings alone", () => {
  // The cheapest way for this to go catastrophically wrong is a glob or a recursive remove on the project directory.
  const { root, project } = store();
  try {
    const first = sessionFile(project, "2026-11-01T10-00-00-000Z_aaa");
    const second = sessionFile(project, "2026-11-01T11-00-00-000Z_bbb");
    const result = deleteSessionFile({ sessionsRoot: root }, first);
    assert.equal(result.ok, true);
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), true, "the other session in the same directory survives");
    assert.deepEqual(readdirSync(project), ["2026-11-01T11-00-00-000Z_bbb.jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The supervisor's entry goes with the file (reported from use).
 *
 * > "When I stop a session and click delete, they are still in the roster."
 *
 * Unlinking the file was not enough: the supervisor still held an entry for it, which the next snapshot re-broadcast,
 * and the client's "every live session belongs in the roster" effect restored the row. Deleting is therefore
 * forget-and-delete as one act — the reader is not asked to do both.
 */
test("forgetFile drops a stopped entry, so a snapshot cannot restore it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-central-forget-file-"));
  try {
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(root, "sessions"), { recursive: true });
    const { Supervisor } = await import("../src/supervisor.ts");
    const supervisor = new Supervisor({
      workspaceRoot: join(root, "w"),
      stateRoot: join(root, "s"),
      sessionsRoot: join(root, "sessions"),
      safehouse: "safehouse-not-present",
      pi: "pi-not-present",
      agentRoot: join(root, "agent"),
      fragmentDir: join(root, "s", "policy"),
      agentRootManaged: true,
      providerAgentDir: join(root, "provider"),
      home: root,
      installationRoot: undefined,
    });
    supervisor.on("error", () => {});

    const started = supervisor.start({ cwd });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const file = join(root, "sessions", "--work--", "x.jsonl");
    started.session.sessionFile = file;
    // Stopped, which is the state a delete is allowed from.
    await supervisor.stop(started.session.id);

    assert.equal(supervisor.list().length, 1, "the entry exists");
    supervisor.forgetFile(file);
    assert.deepEqual(supervisor.list(), [], "and is gone, so no snapshot can re-broadcast it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forgetFile refuses a RUNNING session, so a live process is never orphaned", async () => {
  // The delete path already refuses a live session; this is the second guard. Forgetting a running entry would leave a
  // process writing to a file nothing tracks, which is the branch point ADR-0004 prevents.
  const root = mkdtempSync(join(tmpdir(), "pi-central-forget-live-"));
  try {
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(root, "sessions"), { recursive: true });
    const { Supervisor } = await import("../src/supervisor.ts");
    const supervisor = new Supervisor({
      workspaceRoot: join(root, "w"),
      stateRoot: join(root, "s"),
      sessionsRoot: join(root, "sessions"),
      safehouse: "safehouse-not-present",
      pi: "pi-not-present",
      agentRoot: join(root, "agent"),
      fragmentDir: join(root, "s", "policy"),
      agentRootManaged: true,
      providerAgentDir: join(root, "provider"),
      home: root,
      installationRoot: undefined,
    });
    supervisor.on("error", () => {});
    const started = supervisor.start({ cwd });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const file = join(root, "sessions", "--work--", "x.jsonl");
    started.session.sessionFile = file;
    started.session.state = "streaming";

    supervisor.forgetFile(file);
    assert.equal(supervisor.list().length, 1, "a running session is not forgotten");
    await supervisor.stopAll({ forget: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
