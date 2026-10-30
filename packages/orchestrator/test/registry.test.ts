import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSessionDir, discover, encodeSessionDir, sessionAt } from "../src/registry.ts";
import type { Config } from "../src/config.ts";

const root = mkdtempSync(join(tmpdir(), "pi-central-registry-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const config = (over: Partial<Config> = {}): Config => ({
  workspaceRoot: join(root, "workspaces"),
  stateRoot: join(root, "state"),
  sessionsRoot: root,
  safehouse: "safehouse",
  pi: "pi",
  agentRoot: join(root, "agent"),
  fragmentDir: join(root, "state", "policy"),
  agentRootManaged: true,
  installationRoot: undefined,
  providerAgentDir: join(root, "provider-agent"),
  home: "/Users/tester",
  ...over,
});

function writeSession(dir: string, file: string, records: unknown[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return path;
}

const header = (id: string, cwd: string, version = 3) => ({
  type: "session",
  version,
  id,
  timestamp: "2026-06-25T10:00:00.000Z",
  cwd,
});

const userMessage = (text: string) => ({
  type: "message",
  id: "m1",
  timestamp: "2026-06-25T10:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
});

test("encodeSessionDir mirrors Pi's directory encoding", () => {
  assert.equal(encodeSessionDir("/Users/x/git/repo"), "--Users-x-git-repo--");
  assert.equal(encodeSessionDir("/private/tmp"), "--private-tmp--");
});

test("decodeSessionDir round-trips a simple path", () => {
  assert.equal(decodeSessionDir(encodeSessionDir("/Users/x/git/repo")), "/Users/x/git/repo");
});

test("discovers a session, its name, first message, and message count", async () => {
  const dir = join(root, "proj-a");
  writeSession(dir, "s1.jsonl", [
    header("id-1", "/Users/x/proj-a"),
    { type: "session_info", name: "refactor auth" },
    userMessage("please refactor the auth module"),
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ]);

  const { sessions } = await discover(config());
  const found = sessions.find((s) => s.id === "id-1");
  assert.ok(found, "session should be discovered");
  assert.equal(found.name, "refactor auth");
  assert.equal(found.firstMessage, "please refactor the auth module");
  assert.equal(found.messageCount, 2, "user + assistant");
  assert.equal(found.cwd, "/Users/x/proj-a");
});

test("nested subagent runs are not discovered as sessions (ADR-0009)", async () => {
  const dir = join(root, "proj-trap");
  // The real session file...
  const file = writeSession(dir, "sess.jsonl", [header("id-real", "/Users/x/proj-trap")]);
  // ...and Pi's sidecar directory, named like the file WITHOUT the .jsonl suffix, holding a
  // subagent run. This mirrors the real layout on disk.
  const sidecar = file.slice(0, -".jsonl".length);
  mkdirSync(join(sidecar, "uuid", "run-0"), { recursive: true });
  writeFileSync(
    join(sidecar, "uuid", "run-0", "session.jsonl"),
    `${JSON.stringify(header("id-subagent", "/Users/x/proj-trap"))}\n`,
  );
  // Also a plain subagent-artifacts dir, as Pi creates alongside.
  mkdirSync(join(dir, "subagent-artifacts"), { recursive: true });

  const { sessions } = await discover(config());
  const ids = sessions.map((s) => s.id);
  assert.ok(ids.includes("id-real"), "the real session is found");
  assert.ok(!ids.includes("id-subagent"), "the nested subagent run must NOT be a session");
  assert.equal(sessions.filter((s) => s.cwd === "/Users/x/proj-trap").length, 1);
});

test("a file whose first record is not a session header is skipped with a reason", async () => {
  const dir = join(root, "proj-bad");
  writeSession(dir, "notasession.jsonl", [{ type: "message", message: { role: "user", content: "hi" } }]);

  const { sessions, skipped } = await discover(config());
  assert.ok(!sessions.some((s) => s.id === "notasession"));
  assert.ok(skipped.some((s) => s.path.includes("notasession.jsonl")));
});

test("an unknown session version is skipped, not guessed at", async () => {
  const dir = join(root, "proj-version");
  writeSession(dir, "future.jsonl", [header("id-future", "/Users/x/proj-version", 99)]);

  const { sessions, skipped } = await discover(config());
  assert.ok(!sessions.some((s) => s.id === "id-future"));
  assert.ok(skipped.some((s) => s.reason.includes("unknown session version 99")));
});

test("cwdExists is false for a session whose directory is gone (US-5, D-4)", async () => {
  const dir = join(root, "proj-gone");
  writeSession(dir, "gone.jsonl", [header("id-gone", "/nonexistent/volume/worktree")]);

  const { sessions } = await discover(config());
  const found = sessions.find((s) => s.id === "id-gone");
  assert.equal(found?.cwdExists, false);

  // And the counterpart: an existing dir reports true.
  const here = join(root, "proj-here");
  writeSession(here, "here.jsonl", [header("id-here", here)]);
  const { sessions: again } = await discover(config());
  assert.equal(again.find((s) => s.id === "id-here")?.cwdExists, true);
});

test("scratch marks sessions inside the app workspace (US-3)", async () => {
  const dir = join(root, "proj-scratch");
  const ws = join(root, "workspaces", "s1");
  mkdirSync(ws, { recursive: true });
  writeSession(dir, "scratch.jsonl", [header("id-scratch", ws)]);
  writeSession(dir, "real.jsonl", [header("id-real2", "/Users/x/real-repo")]);

  const { sessions } = await discover(config());
  assert.equal(sessions.find((s) => s.id === "id-scratch")?.scratch, true);
  assert.equal(sessions.find((s) => s.id === "id-real2")?.scratch, false);
});

test("a name beyond the head window is not detected -- a documented limitation", async () => {
  // Discovery caps its read (see HEAD_BYTES): it is a list operation over hundreds of files,
  // not a full transcript scan. A `session_info` set late in a very large session is
  // therefore missed. This pins that behavior so it is a known trade-off, not a surprise.
  const dir = join(root, "proj-late");
  const padding = Array.from({ length: 4000 }, (_, i) => ({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "x".repeat(100) }] },
    i,
  }));
  writeSession(dir, "late.jsonl", [
    header("id-late", "/Users/x/proj-late"),
    ...padding,
    { type: "session_info", name: "named very late" },
  ]);

  const { sessions } = await discover(config());
  assert.equal(sessions.find((s) => s.id === "id-late")?.name, undefined);
});

test("a missing sessions root yields an empty result, not an error", async () => {
  const { sessions } = await discover(config({ sessionsRoot: join(root, "nope") }));
  assert.deepEqual(sessions, []);
});

test("sessions are sorted newest first", async () => {
  const dir = join(root, "proj-sort");
  const older = writeSession(dir, "old.jsonl", [header("id-old", "/Users/x/sort")]);
  const newer = writeSession(dir, "new.jsonl", [header("id-new", "/Users/x/sort")]);
  // Set both mtimes explicitly and far apart, rather than relying on write ordering:
  // two writes microseconds apart can share a timestamp on some filesystems.
  const { utimesSync } = await import("node:fs");
  const base = 1_700_000_000;
  utimesSync(older, base, base);
  utimesSync(newer, base + 3600, base + 3600);

  const { sessions } = await discover(config());
  const sortIds = sessions.filter((s) => s.cwd === "/Users/x/sort").map((s) => s.id);
  assert.deepEqual(sortIds, ["id-new", "id-old"]);
});

test("discovery reports a true total, not the size of the returned page", async () => {
  // Observed on the real machine: 1115 session files, a limit of 500, and a rail stating
  // "500 sessions on disk" as a fact. A caller cannot tell a total from a page size unless the
  // two are separate values, and they previously were not.
  // A DEDICATED root, not the shared one: `root` accumulates sessions from other tests, so
  // counting against it asserted 16 instead of 7. A test that depends on test-ordering is a
  // test that fails for reasons unrelated to the code.
  const isolated = mkdtempSync(join(tmpdir(), "pi-central-total-"));
  try {
    const projectDir = join(isolated, encodeSessionDir("/Users/x/proj-total"));
    for (let i = 0; i < 7; i += 1) {
      writeSession(projectDir, `s${i}.jsonl`, [header(`id-${i}`, "/Users/x/proj-total")]);
    }

    const page = await discover(config({ sessionsRoot: isolated }), 3);
    assert.equal(page.sessions.length, 3, "the page must honour the limit");
    assert.equal(page.total, 7, "the total must be the real count, measured before the slice");
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

test("an empty or absent sessions root reports a total of zero", async () => {
  const empty = await discover(config({ sessionsRoot: join(root, "does-not-exist") }));
  assert.deepEqual(empty.sessions, []);
  assert.equal(empty.total, 0, "a missing store is not an error, and not an unknown total");
});

// --- Resuming a session that the discovery cap excludes (the reported bug) ------------------------

test("a session OLDER than the discovery cap can still be resumed", async () => {
  // The bug: `resume` looked the path up in `discover()`'s result, and `discover` returns `slice(0, 500)`.
  // On a machine with 867 sessions, resuming anything outside the newest 500 reported "no such session" —
  // an error naming the wrong cause, for a file that plainly exists.
  //
  // `sessionAt` reads one header instead of walking the store, so the cap cannot apply.
  const dir = join(root, "old-project");
  const ancient = writeSession(dir, "ancient.jsonl", [header("id-old", "/Users/x/old-project")]);

  // Pin it to the bottom by mtime, and cap discovery at ONE so it cannot be in the page.
  const { utimesSync } = await import("node:fs");
  utimesSync(ancient, new Date("2001-01-01"), new Date("2001-01-01"));
  for (let i = 0; i < 3; i += 1) {
    writeSession(dir, `recent-${i}.jsonl`, [header(`id-recent-${i}`, "/Users/x/old-project")]);
  }

  const page = await discover(config(), 1);
  assert.equal(page.sessions.length, 1, "the cap hides everything else");
  assert.ok(!page.sessions.some((s) => s.path === ancient), "the old one is NOT in the page");

  const found = await sessionAt(config(), ancient);
  assert.ok(found, "…but it is still resumable by path");
  assert.equal(found.id, "id-old");
  assert.equal(found.cwd, "/Users/x/old-project");
});

test("sessionAt refuses a path outside the sessions root", async () => {
  // The path arrives from the client, so it is not trusted. Resuming is a SPAWN — a containment failure here
  // does not just read the wrong file, it starts an agent in a directory the user never opened.
  const outside = mkdtempSync(join(tmpdir(), "pi-central-outside-"));
  process.on("exit", () => rmSync(outside, { recursive: true, force: true }));
  const escapee = writeSession(outside, "bad.jsonl", [header("id-bad", "/Users/x/elsewhere")]);

  assert.equal(await sessionAt(config(), escapee), undefined, "outside the store is refused");
  assert.equal(await sessionAt(config(), "../../etc/passwd"), undefined, "traversal is refused");
  assert.equal(await sessionAt(config(), ""), undefined, "an empty path is refused");
  assert.equal(await sessionAt(config(), `${escapee}\u0000`), undefined, "a NUL is refused");
});

test("a path that merely PREFIXES the root is refused", async () => {
  // `/a/bc` must not satisfy a boundary of `/a/b`: the unit of the boundary is the DIRECTORY (C15c), not a
  // string prefix. A sibling directory whose name starts with the root's name is outside.
  const sibling = `${root}-evil`;
  mkdirSync(sibling, { recursive: true });
  process.on("exit", () => rmSync(sibling, { recursive: true, force: true }));
  const sneaky = writeSession(sibling, "s.jsonl", [header("id-sneaky", "/Users/x/sneaky")]);
  assert.equal(await sessionAt(config(), sneaky), undefined);
});

test("a non-jsonl file or a directory is refused rather than described", async () => {
  const dir = join(root, "proj-b");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.txt"), "not a session");
  assert.equal(await sessionAt(config(), join(dir, "notes.txt")), undefined);
  assert.equal(await sessionAt(config(), dir), undefined);
});

test("a session file with an UNKNOWN version is refused, matching discover's rule", async () => {
  // One implementation of "is this a valid session file" — otherwise resume accepts what History refuses.
  const dir = join(root, "proj-c");
  const path = writeSession(dir, "future.jsonl", [header("id-future", "/Users/x/proj-c", 99)]);
  assert.equal(await sessionAt(config(), path), undefined);
  const { skipped } = await discover(config());
  assert.ok(skipped.some((s) => s.path === path), "discover skips it too");
});
