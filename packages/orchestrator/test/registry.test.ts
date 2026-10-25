import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSessionDir, discover, encodeSessionDir } from "../src/registry.ts";
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
  providerAgentDir: join(root, "provider-agent"),
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
