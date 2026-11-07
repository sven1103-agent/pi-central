/**
 * The orchestrator child: parsing, restart policy, argv and environment (issue #214, criteria 3–7).
 *
 * ## Why the timing rules are unit-tested rather than observed live
 *
 * Criteria 4 and 5 are about a *child that misbehaves*: one that never prints a URL, and one that exits
 * mid-run. Both are hard to provoke on purpose against the real orchestrator — it either works or the
 * machine is broken — and a test that needs a real GUI cannot provoke them reliably at all. So the
 * decisions live in `orchestrator-process.ts` with no `spawn` in sight, and this file drives them
 * directly.
 *
 * The one thing that is *not* mocked is the line format: `PI_CENTRAL_URL=` is read from
 * `packages/orchestrator/src/server.ts` at test time, so a rename there fails here instead of leaving a
 * shell that waits ten seconds for a line nobody prints any more.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INHERITED,
  LineAccumulator,
  MAX_CONSECUTIVE_FAILURES,
  composePath,
  decideAfterExit,
  keepTail,
  parseChildLine,
  planSpawn,
} from "../src/orchestrator-process.ts";
import type { FoundExecutable } from "../src/executables.ts";

function exe(name: string, path: string): FoundExecutable {
  return { name, path, source: "environment" };
}

/** A plausible shell environment: the process basics `env.ts` expects to find. */
const SHELL_ENV = {
  HOME: "/Users/someone",
  USER: "someone",
  LOGNAME: "someone",
  SHELL: "/bin/zsh",
  TMPDIR: "/var/folders/xx/T/",
  LANG: "en_US.UTF-8",
  // The two that must NOT be forwarded: the app is not a credential path (ADR-0010, C11).
  SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.xyz/Listeners",
  GITHUB_TOKEN: "ghp_secret",
};

function plan(overrides: Partial<Parameters<typeof planSpawn>[0]> = {}) {
  return planSpawn({
    node: exe("node", "/opt/homebrew/bin/node"),
    pkg: { root: "/p", bin: "/p/bin/pi-central.js" },
    pi: exe("pi", "/opt/homebrew/bin/pi"),
    safehouse: exe("safehouse", "/opt/homebrew/bin/safehouse"),
    sourceEnv: SHELL_ENV,
    ...overrides,
  });
}

test("the announcement the orchestrator prints is the one this parses", () => {
  // Pinned against the real source rather than a copy of the string: this is the contract between two
  // processes, and a copy in a test would agree with itself after a rename.
  const server = readFileSync(new URL("../../orchestrator/src/server.ts", import.meta.url), "utf8");
  assert.match(server, /console\.log\(`PI_CENTRAL_URL=\$\{address\.url\}`\)/);
});

test("a URL line becomes a URL, and the window's URL is the same listener over http", () => {
  const parsed = parseChildLine("PI_CENTRAL_URL=ws://127.0.0.1:54321");
  assert.deepEqual(parsed, {
    kind: "url",
    url: "ws://127.0.0.1:54321",
    httpUrl: "http://127.0.0.1:54321",
  });
});

test("startup chatter is a note, never protocol", () => {
  // The orchestrator prints its banner, its session root, its isolation mode… Only the prefixed line is
  // machine-readable, which is the same rule it applies to Pi's stdout (C7), one level up.
  assert.deepEqual(parseChildLine("  default workspace: /Users/x/.pi-central"), {
    kind: "note",
    text: "  default workspace: /Users/x/.pi-central",
  });
  assert.deepEqual(parseChildLine("   "), { kind: "ignored" });
});

test("a malformed announcement is reported as such, not treated as a URL", () => {
  // Both shapes matter: an empty URL would produce a window pointed at nothing, and an http:// URL is a
  // fact about the orchestrator that has changed — which must be loud, not silently rewritten.
  assert.equal(parseChildLine("PI_CENTRAL_URL=").kind, "bad-url");
  const http = parseChildLine("PI_CENTRAL_URL=http://127.0.0.1:1");
  assert.equal(http.kind, "bad-url");
  if (http.kind !== "bad-url") return;
  assert.match(http.reason, /expected a ws:\/\/ URL/);
});

test("a CRLF line still parses, because a chatty child may come through a pty", () => {
  assert.equal(parseChildLine("PI_CENTRAL_URL=ws://127.0.0.1:2\r\n").kind, "url");
});

test("a URL split across two chunks is assembled, not dropped", () => {
  // The chunk boundary is the classic bug: a naive `chunk.includes("PI_CENTRAL_URL=")` passes locally and
  // fails whenever the pipe happens to split, which is rare enough to reach a user.
  const acc = new LineAccumulator();
  assert.deepEqual(acc.push("PI_CENTRAL_UR"), []);
  assert.deepEqual(acc.push("L=ws://127.0.0.1:8080\n"), ["PI_CENTRAL_URL=ws://127.0.0.1:8080"]);
});

test("a child that printed its URL without a newline and died has still announced it", () => {
  const acc = new LineAccumulator();
  assert.deepEqual(acc.push("PI_CENTRAL_URL=ws://127.0.0.1:9"), []);
  assert.equal(acc.flush(), "PI_CENTRAL_URL=ws://127.0.0.1:9");
  assert.equal(acc.flush(), undefined, "flush is idempotent");
});

test("the first failure restarts immediately, then with backoff, then stops", () => {
  assert.deepEqual(decideAfterExit(0), { action: "restart", delayMs: 0, reason: "the orchestrator exited; restarting in 0 ms" });
  assert.equal(decideAfterExit(1).action, "restart");
  assert.equal(decideAfterExit(2).action, "restart");
  // The third consecutive failure is where it stops, and the reason must say so — a silent stop is how
  // the reader ends up staring at a window with no explanation.
  const stop = decideAfterExit(MAX_CONSECUTIVE_FAILURES);
  assert.equal(stop.action, "stop");
  if (stop.action !== "stop") return;
  assert.match(stop.reason, /3 times in a row/);
  assert.match(stop.reason, /Restart tries once more/);
});

test("the kept stderr is the END, and starts at a line boundary", () => {
  // A Node stack trace explains itself in its last lines; a startup banner does not. Trimming from the
  // front is also what keeps a chatty child from pushing the diagnosis out of the window.
  const banner = "starting\n".repeat(10_000);
  const trace = "Error: EPERM: operation not permitted, open '/Users/x/.pi/config'\n  at boot (/app/boot.js:1:1)\n";
  const kept = keepTail(banner, trace);
  assert.equal(kept.includes("EPERM"), true, "the diagnosis survives");
  assert.equal(kept.length <= 64 * 1024 + 64, true, "the bound holds");
  // Truncation is marked rather than left to look like a corrupt first line.
  assert.match(kept, /… earlier output omitted\n/);
});

test("a small stderr is kept verbatim, with no marker", () => {
  assert.equal(keepTail("a\n", "b\n"), "a\nb\n");
});

test("the child is spawned with --port 0 and never a chosen port", () => {
  // Criterion 3 as an argv assertion: the shell does not pick a port, so `EADDRINUSE` is unreachable
  // from the app. The port that results is whatever the child announces.
  const spawned = plan({
    pkg: { root: "/opt/homebrew/lib/node_modules/pi-central", bin: "/opt/homebrew/lib/node_modules/pi-central/bin/pi-central.js" },
  });
  assert.equal(spawned.command, "/opt/homebrew/bin/node");
  assert.deepEqual(spawned.args, ["/opt/homebrew/lib/node_modules/pi-central/bin/pi-central.js", "--port", "0"]);
  assert.equal(spawned.cwd, "/opt/homebrew/lib/node_modules/pi-central");
});

test("the child's environment is an allowlist, and PATH is the resolved one", () => {
  // Criterion 7: `process.env` is never passed through wholesale. But the first version of this test
  // asserted the exact KEY SET, which is how the real defect got in: the set was correct and too small.
  // `HOME` was missing, so `env.ts` could not read it, so `pi` refused to start in EVERY session with
  // "HOME is not set". A test that pinned the shape could not see it, because the shape was what was
  // wrong — so this now asserts about NAMES AND EXCLUSIONS, both of which a regression must break.
  const spawned = plan();
  assert.equal(spawned.env["PI_CENTRAL_PI"], "/opt/homebrew/bin/pi");
  assert.equal(spawned.env["PI_CENTRAL_SAFEHOUSE"], "/opt/homebrew/bin/safehouse");
  assert.equal(spawned.env["PATH"]?.startsWith("/opt/homebrew/bin"), true);
  assert.equal(spawned.env["PATH"]?.includes("/usr/bin"), true, "the standard set is appended, not replaced");

  // The process basics the orchestrator cannot manufacture for itself: it forwards its own environment
  // to sessions, so a name absent here does not exist anywhere downstream.
  for (const name of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"]) {
    assert.equal(spawned.env[name], SHELL_ENV[name as keyof typeof SHELL_ENV], `${name} must be forwarded`);
  }

  // And the credential-shaped names are still excluded. This is the half that makes it an allowlist
  // rather than an inheritance, and it is independent of the half above.
  assert.equal(spawned.env["SSH_AUTH_SOCK"], undefined, "the app is not an ssh-agent path (C4a)");
  assert.equal(spawned.env["GITHUB_TOKEN"], undefined, "the app is not a credential path (ADR-0010)");
});

test("a name the shell has unset is omitted rather than forwarded as an empty string", () => {
  // `HOME=` (present, empty) is not the same as `HOME` absent, and passing the empty string through
  // would make the orchestrator believe it has a home directory that is nowhere.
  const spawned = plan({ sourceEnv: { ...SHELL_ENV, TERM: "" } });
  assert.equal(spawned.env["TERM"], undefined);
});

test("the forwarded list is the one env.ts expects, name for name", () => {
  // Pinned against the orchestrator rather than against a copy: the failure that got in — every session
  // failing on a missing HOME — was a list in one package disagreeing with a list in another, with
  // nothing comparing them.
  const envSource = readFileSync(new URL("../../orchestrator/src/env.ts", import.meta.url), "utf8");
  const passthrough = /export const PASSTHROUGH = \[([\s\S]*?)\] as const;/.exec(envSource);
  assert.ok(passthrough, "env.ts still declares PASSTHROUGH");
  const names = [...passthrough[1]!.matchAll(/"([A-Z_a-z]+)"/g)].map((m) => m[1]!);
  for (const name of INHERITED) {
    // `PATH` is composed rather than forwarded, so it is expected to be in PASSTHROUGH and not in
    // INHERITED; every OTHER name the orchestrator reads must be forwarded by the shell.
    assert.equal(names.includes(name), true, `${name} is forwarded but env.ts does not read it`);
  }
  const required = names.filter((name) => name !== "PATH" && !name.startsWith("PI_"));
  for (const name of required) {
    assert.equal(
      (INHERITED as readonly string[]).includes(name),
      true,
      `env.ts reads ${name} from its own environment, so the shell must forward it or it disappears`,
    );
  }
});

test("the composed PATH dedupes, and keeps the node directory first", () => {
  // Ordering is not cosmetic: a version manager's `node` shim must win over a system copy, or the
  // orchestrator runs on a Node that does not match the one the reader installed it with.
  const path = composePath([
    exe("node", "/Users/x/.nvm/versions/node/v24/bin/node"),
    exe("pi", "/Users/x/.nvm/versions/node/v24/bin/pi"),
    exe("safehouse", "/opt/homebrew/bin/safehouse"),
  ]);
  assert.deepEqual(path.split(":"), [
    "/Users/x/.nvm/versions/node/v24/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]);
});

test("the session's PATH carries no shim directory", () => {
  // The second half of the exit-126 fix. Safehouse APPENDS its dev paths to the PATH it inherits, so
  // anything composed here reaches every session — and `node_modules/.bin` is a directory sessions are
  // usually sandboxed away from. A resolved executable is never in a shim (resolution skips them), so
  // this passes only because `composePath` also refuses to ADD one.
  const path = composePath([
    exe("node", "/Users/x/project/node_modules/.bin/node"),
    exe("pi", "/opt/homebrew/bin/pi"),
  ]);
  assert.equal(path.includes("node_modules/.bin"), false);
  assert.equal(path.startsWith("/opt/homebrew/bin"), true);
});
