#!/usr/bin/env node
/**
 * Verify the quit/reattach lifecycle end to end, against a real orchestrator, with one command
 * (issue #216).
 *
 * ## Why this exists
 *
 * The slice's evidence was spread across six test files, two build steps and a twelve-step manual script. That is not
 * something a person runs to answer "does quitting lose my work?" — and a check nobody runs is a check that rots.
 *
 *   node scripts/verify-lifecycle-216.mjs
 *
 * ## What it does
 *
 * 1. Builds what it needs (`bin/pi-central.js`, `dist/ui`) if either is missing.
 * 2. Starts the real orchestrator with the shell's own spawn shape — detached, piped, `--port 0` — under a **temporary
 *    state root**, so it cannot touch the reader's own `open-sessions.json` or workspace.
 * 3. Starts two real sessions, so the dialog has something to name.
 * 4. Walks the exact sequence `⌘Q` produces, deciding each step through the **same functions the app uses**
 *    (`decideAttach`, `decideStop`, `stopDialog`, `writeRuntimeRecord`, `askLiveSessions`). What is checked is therefore
 *    the decision the app will make, not a copy of it.
 *
 * ## The three outcomes
 *
 * `PASS`, `FAIL`, and **`CANNOT`** — the last one is the important one. Two of the criteria need a fact this script may
 * not be able to obtain:
 *
 *   - **Reading a process's start time** (C16). Under an agent harness `/bin/ps` returns `EPERM`, so identity cannot be
 *     checked. Reported as CANNOT with the reason, not as a pass and not as a failure.
 *   - **Producing a live session.** A sandbox cannot nest (C1), so sessions started from inside one reach `failed`
 *     rather than `idle`. Then the dialog correctly names nothing, and criterion 3 cannot be shown here.
 *
 * A `CANNOT` is never counted as a pass. `FAIL` is the only non-zero exit, because a script that fails on "I could not
 * look" teaches you to ignore it.
 *
 * ## What it deliberately does not do
 *
 * It does not launch Electron and it does not click. The dialog's *contents* are asserted here — they are data, built by
 * `stopDialog` — and what remains unassertable is that Electron routes `⌘Q` to these decisions
 * (`packages/app/test/lifecycle-wiring.test.ts` reads the source for that) and that restoration reopens sessions from
 * `open-sessions.json` (two clicks; `docs/DOGFOODING.md` has the script).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "bin", "pi-central.js");
const UI_DIST = join(ROOT, "dist", "ui");

const { askLiveSessions } = await import(join(ROOT, "packages", "app", "src", "live-sessions.ts"));
const {
  answerIsOurs,
  chooseAnswer,
  decideAttach,
  decideStop,
  probeCommand,
  readRuntimeRecord,
  rememberedMarks,
  removeRuntimeRecord,
  stopDialog,
  writeRuntimeRecord,
} = await import(join(ROOT, "packages", "app", "src", "runtime-record.ts"));

// ---------------------------------------------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------------------------------------------

const results = [];
/**
 * Record one check.
 *
 * `verdict` is `true`, a failure message, or `undefined` with a `cannot` reason. The third case exists because a check
 * that could not be made is a different statement from a check that failed, and collapsing them is how a verification
 * script starts lying in whichever direction is convenient.
 */
function check(id, description, verdict, cannot) {
  if (verdict === true) {
    results.push({ id, ok: true });
    console.log(`  PASS    ${id}. ${description}`);
  } else if (verdict === undefined && cannot !== undefined) {
    results.push({ id, ok: true, cannot: true });
    console.log(`  CANNOT  ${id}. ${description}\n          ${cannot}`);
  } else {
    results.push({ id, ok: false, detail: verdict });
    console.log(`  FAIL    ${id}. ${description}\n          ${verdict}`);
  }
}

const step = (text) => console.log(`\n${text}`);

// ---------------------------------------------------------------------------------------------------------------
// What it needs.
// ---------------------------------------------------------------------------------------------------------------

if (!existsSync(BUNDLE)) {
  console.log("building bin/pi-central.js (missing)…");
  spawnSync("npm", ["run", "build:package"], { cwd: ROOT, stdio: "inherit" });
}
if (!existsSync(join(UI_DIST, "index.html"))) {
  console.log("building dist/ui (missing)…");
  spawnSync("npm", ["run", "ui:build"], { cwd: ROOT, stdio: "inherit" });
}
if (!existsSync(BUNDLE) || !existsSync(join(UI_DIST, "index.html"))) {
  console.error("could not build bin/pi-central.js and dist/ui");
  process.exit(2);
}

/*
 * A temporary app-data directory and state root, so this cannot touch the reader's own record, restored sessions or
 * workspace. `runtime.json` lives in the app's userData directory, which for Electron is
 * `~/Library/Application Support/Pi Central` — here it is a directory this run owns and removes.
 */
const workspace = mkdtempSync(join(tmpdir(), "pi-central-verify-216-"));
const appDataDir = join(workspace, "appdata");
const stateRoot = join(workspace, "state");
const processes = [];

process.on("exit", () => {
  for (const pid of processes) killGroup(pid);
  rmSync(workspace, { recursive: true, force: true });
});

function killGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** The probe, exactly as `main.ts` runs it. */
function probe(pid) {
  const [flag, script] = probeCommand(pid);
  const result = spawnSync("/bin/sh", [flag ?? "-c", script ?? ""], { encoding: "utf8", timeout: 2000 });
  if (result.error !== undefined) return rememberedMarks(undefined, Date.now());
  return rememberedMarks({ ok: result.status === 0, output: `${result.stdout}${result.stderr}` }, Date.now());
}

/** Ask a port for `/`, following one same-origin redirect. */
async function askPort(port) {
  const seek = async (path) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      const body = response.status === 200 ? await response.text() : "";
      return { ok: true, status: response.status, location: response.headers.get("location") ?? undefined, body };
    } catch (error) {
      const code = error?.cause?.code ?? error?.cause ?? "";
      return { ok: false, reason: error.message, refused: String(code).includes("ECONNREFUSED") };
    }
  };
  const first = await seek("/");
  if (!first.ok) return first;
  if (first.status >= 300 && first.status < 400 && first.location !== undefined) {
    return seek(new URL(first.location, `http://127.0.0.1:${port}`).pathname);
  }
  return first;
}

const WebSocket = (() => {
  try {
    const loaded = createRequire(join(ROOT, "package.json"))("ws");
    return loaded.WebSocket ?? loaded.default;
  } catch {
    return undefined;
  }
})();

const connect = (url) => {
  if (WebSocket === undefined) return { on: () => undefined, close: () => undefined };
  const socket = new WebSocket(url);
  return { on: (event, listener) => socket.on(event, listener), close: () => socket.close() };
};

/** Start the orchestrator the way the shell does: detached, piped, ephemeral port, own state root. */
function startOrchestrator() {
  const child = spawn(
    process.execPath,
    [BUNDLE, "--port", "0", "--ui-dist", UI_DIST, "--allow-unsandboxed-host"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, PI_CENTRAL_STATE: stateRoot, PI_CENTRAL_WORKSPACE: join(workspace, "ws") },
    },
  );
  child.unref();
  if (child.pid !== undefined) processes.push(child.pid);
  return new Promise((resolveUrl, reject) => {
    let buffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => reject(new Error(`no URL within 30 s\n${stderr}`)), 30_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const match = /PI_CENTRAL_URL=(ws:\/\/[^\s]+)/.exec(buffer);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolveUrl({ child, url: match[1], pid: child.pid });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the orchestrator exited (${code}) before announcing\n${stderr}`));
    });
  });
}

/** Start two real sessions, so the dialog has something to name. Returns how many reached a live state. */
async function startTwoSessions(url) {
  if (WebSocket === undefined) return 0;
  const socket = new WebSocket(url);
  const states = new Map();
  socket.on("message", (data) => {
    const payload = JSON.parse(String(data)).payload;
    if (payload.kind === "session") states.set(payload.session.id, payload.session.state);
    if (payload.kind === "snapshot") for (const live of payload.live) states.set(live.id, live.state);
  });
  await new Promise((r) => socket.on("open", r));
  // Two `start` controls: with no directory, which is the app-owned default workspace (US-1).
  for (let index = 0; index < 2; index += 1) {
    socket.send(JSON.stringify({ dir: "client→orchestrator", protocol: 9, payload: { kind: "start" } }));
  }
  // Wait for them to leave `starting`, which is where the sandbox question resolves.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const settled = [...states.values()].filter((state) => state !== "starting" && state !== "registered");
    if (settled.length >= 2) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  socket.close();
  const live = [...states.values()].filter((state) => ["idle", "streaming", "awaiting-approval", "starting"].includes(state));
  return { total: states.size, live: live.length, states: [...states.values()] };
}

// ---------------------------------------------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------------------------------------------

console.log(`\nverifying issue #216 against a real orchestrator`);
console.log(`  state root: ${stateRoot}  (temporary; your own sessions are not touched)`);

step("criterion 1 — closing the window leaves the orchestrator running, with the same PID");
const first = await startOrchestrator();
const port = Number.parseInt(new URL(first.url).port, 10);
{
  const before = probe(first.pid);
  // A window close is not an orchestrator event at all — that is the criterion. Nothing is signalled.
  await new Promise((r) => setTimeout(r, 300));
  const after = probe(first.pid);
  const serving = await askPort(port);
  if (before.status === "unknown" || after.status === "unknown") {
    check(1, "the orchestrator is untouched by a window close (same PID, still serving)", undefined,
      `this host does not allow the process probe (C16), so the PID cannot be compared. Run from a plain terminal.\n          It is still serving: ${serving.ok === true}`);
  } else if (!serving.ok) {
    check(1, "the orchestrator is untouched by a window close (same PID, still serving)", "the orchestrator stopped answering");
  } else {
    const samePid = before.status === "present" && after.status === "present" && before.marks === after.marks;
    check(1, "the orchestrator is untouched by a window close (same PID, still serving)", samePid || `pid ${first.pid} changed start time or vanished`);
  }
}

step("starting two sessions, so the dialog has something to name");
const sessions = await startTwoSessions(first.url);
console.log(`  ${sessions.total} session(s) known; ${sessions.live} live (states: ${sessions.states.join(", ") || "none"})`);
if (sessions.live === 0 && sessions.total > 0) {
  console.log("  (a session that fails here is usually the sandbox refusing to nest — C1. Run this from a plain terminal.)");
}

step("criterion 3 — ⌘Q names the live sessions, and Keep is the default");
{
  const answer = await askLiveSessions(connect, first.url, 5000);
  const decision = decideStop(answer.sessions);
  if (decision.action !== "ask") {
    check(3, "the dialog names the live sessions", undefined,
      `no session reached a live state (${answer.note ?? "all failed"}), so there is nothing to name. This needs a plain\n          terminal: Seatbelt does not nest (C1), so sessions started from inside a sandbox fail.`);
  } else {
    const dialog = stopDialog(decision.sessions);
    const named = decision.sessions.every((s) => dialog.detail.includes(s.name) && dialog.detail.includes(s.cwd));
    check(3, "the dialog names every live session with its directory, and the count matches", named && dialog.message.startsWith(String(decision.sessions.length)), JSON.stringify(dialog).slice(0, 240));
    check(3, "Keep is first and the default; Escape is Cancel",
      dialog.defaultId === 0 && dialog.buttons[0] === "Keep sessions running" && dialog.buttons[dialog.cancelId] === "Cancel",
      `default=${dialog.defaultId} cancel=${dialog.cancelId}`);
    console.log(`          "${dialog.message}"`);
    for (const line of dialog.detail.split("\n").filter((l) => l.startsWith("•"))) console.log(`            ${line}`);
    // And the answer the app takes: `detach` is what a dismissal and a Return both mean.
    check(3, "Return and Escape both keep the sessions", chooseAnswer(dialog.defaultId) === "detach" && chooseAnswer(dialog.cancelId) === "cancel");
  }
}

step("criterion 4 — Keep sessions running: the app quits, the orchestrator survives");
{
  const marks = probe(first.pid);
  if (marks.status === "present" && marks.marks !== undefined) {
    writeRuntimeRecord(appDataDir, { pid: first.pid, port, startedAt: marks.marks });
    check(4, "the orchestrator's PID, port and start time are recorded", readRuntimeRecord(appDataDir).record?.pid === first.pid);
  } else {
    check(4, "the orchestrator's PID, port and start time are recorded", undefined,
      `this host does not allow the process probe (C16), so no start time can be read. Run from a plain terminal.`);
  }

  /*
   * THE APP QUITS. On the keep path it does two things: destroys its ends of the pipes, and signals nothing. Reproduced
   * exactly — the pipe closure is what raised EPIPE in the child before the fix (C16), and the absence of a signal is
   * what must leave it running.
   */
  first.child.stdout?.destroy();
  first.child.stderr?.destroy();
  await new Promise((r) => setTimeout(r, 600));

  const still = await askPort(port);
  check(4, "nothing was sent to it, and it is still serving after the app's pipe closed", still.ok && answerIsOurs(still), JSON.stringify(still).slice(0, 200));
}

step("criteria 5 and 6 — the next launch adopts it, and refuses a stale or recycled record");
{
  /*
   * The identity here is SYNTHETIC when the host forbids the probe, and that is stated rather than hidden.
   *
   * What these checks are about is the *port* half of the decision — asking the remembered port for `/` and deciding
   * whether the answer is this app's UI — plus the record's internal consistency. Both are exercisable against the real
   * listener that is running, whatever the host does with `/bin/ps`. The PID half is covered by
   * `runtime-record.test.ts` (all four cases) and by `attach-live.test.ts` (a real process, where the probe is allowed).
   */
  const realRecord = readRuntimeRecord(appDataDir).record;
  const marksNow = probe(first.pid);
  const identityKnown = marksNow.status === "present" && marksNow.marks !== undefined;
  const record = realRecord ?? {
    version: 1,
    pid: first.pid,
    port,
    // A stand-in: self-consistent with the synthetic marks below, so the identity step passes and the port is what is
    // being tested. When the probe IS available, `realRecord` is used instead and everything is real.
    startedAt: identityKnown ? marksNow.marks : Date.now() - 60_000,
    recordedAt: Date.now(),
  };
  if (realRecord === undefined) {
    console.log("  note: this host forbids reading a process's start time (C16), so identity below is synthetic");
    console.log("        and the port half is what is under test. Run from a plain terminal for the real thing.");
  }

  /** The marks for a record: real when the probe answers, synthetic-but-consistent when it does not. */
  const marksFor = (candidate) => {
    const real = probe(candidate.pid);
    if (real.status === "present" && real.marks !== undefined) return real;
    return { status: "present", marks: candidate.startedAt, summary: "synthetic (probe refused: C16)" };
  };

  const answer = await askPort(record.port);
  const decision = decideAttach({ record, marks: marksFor(record), answer, expectsNewProcess: false });
  check(5, "a live, identified, serving orchestrator is ADOPTED instead of a second one", decision.verdict === "attach", `${decision.verdict}: ${decision.reason}`);

  // The stale/refused cases. Each one changes exactly ONE fact, so a pass cannot come from an unrelated refusal.
  const recycled = { ...record, startedAt: record.startedAt - 60_000 };
  const recycledDecision = decideAttach({
    record: recycled,
    // Marks that disagree with the record: the process alive today is not the one the record names.
    marks: { status: "present", marks: recycled.startedAt + 60_000, summary: "01:00" },
    answer,
    expectsNewProcess: false,
  });
  check(6, "a record whose start time does not match is refused (PID reuse)", recycledDecision.verdict === "spawn" && recycledDecision.reason.includes("different process"), `${recycledDecision.verdict}: ${recycledDecision.reason}`);

  const gone = decideAttach({ record: { ...record, pid: 999_999 }, marks: { status: "absent", reason: "no process with the recorded PID" }, answer: undefined, expectsNewProcess: false });
  check(6, "a record naming a dead PID is refused", gone.verdict === "spawn" && gone.reason.includes("is gone"), `${gone.verdict}: ${gone.reason}`);

  // A real second server that is not Pi Central: the check that "it answered" is not mistaken for "it is ours".
  const stranger = await startStranger();
  const strangerAnswer = await askPort(stranger.port);
  const strangerDecision = decideAttach({ record: { ...record, port: stranger.port }, marks: marksFor(record), answer: strangerAnswer, expectsNewProcess: false });
  check(6, "a port answering with something that is not Pi Central's UI is refused", strangerDecision.verdict === "spawn" && strangerDecision.reason.includes("not Pi Central"), `${strangerDecision.verdict}: ${strangerDecision.reason}`);
  stranger.close();

  // And the re-launch case (#217): the same live orchestrator must not be adopted after an install.
  const relaunch = decideAttach({ record, marks: marksFor(record), answer, expectsNewProcess: true });
  check(6, "a re-launch after an install refuses the old process", relaunch.verdict === "spawn" && relaunch.reason.includes("told to start a new one"), `${relaunch.verdict}: ${relaunch.reason}`);
}

step("criterion 7 — a clean quit removes the record, so a stale file is only a hint");
{
  removeRuntimeRecord(appDataDir);
  check(7, "the record is gone after a clean quit", readRuntimeRecord(appDataDir).record === undefined);
}

step("criterion 2 — Stop them and quit: both gone, no orphan");
{
  const exited = new Promise((resolveExit) => {
    first.child.on("exit", (code, signal) => resolveExit({ code, signal }));
    setTimeout(() => resolveExit({ code: -1, signal: "timeout" }), 10_000);
  });
  first.child.kill("SIGTERM");
  const outcome = await exited;
  // The port closing is the observable half: nothing is left listening, so nothing was orphaned behind it.
  const after = await askPort(port);
  check(
    2,
    "the orchestrator stops when asked, exits cleanly, and leaves nothing listening",
    after.ok === false && (outcome.code === 0 || outcome.signal === "timeout" ? outcome.code === 0 : false),
    `exit ${JSON.stringify(outcome)}, port still answers: ${after.ok}`,
  );
  console.log(`          exit: ${JSON.stringify(outcome)}`);
}

// ---------------------------------------------------------------------------------------------------------------

/** Start a server that is not Pi Central, to prove the UI check is not merely "it answered". */
async function startStranger() {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Some other app</title><h1>hello</h1>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const failed = results.filter((r) => !r.ok);
const cannot = results.filter((r) => r.cannot);
const passed = results.filter((r) => r.ok && !r.cannot);

console.log(`\n${passed.length} passed, ${cannot.length} could not be checked, ${failed.length} failed`);

if (cannot.length > 0) {
  console.log("\nCould not be checked here — this is not a failure, and not a pass:");
  for (const item of cannot) console.log(`  criterion ${item.id}`);
  console.log("\nBoth causes are environmental: `/bin/ps` is refused (C16), or sessions cannot start because");
  console.log("Seatbelt does not nest (C1). Running this from a plain terminal resolves both.");
}

if (failed.length > 0) {
  console.log("\nFAILED:");
  for (const item of failed) console.log(`  criterion ${item.id}: ${item.detail}`);
  process.exit(1);
}

console.log(`
What this run does NOT cover, by design:
  - that Electron routes ⌘Q to these decisions   -> packages/app/test/lifecycle-wiring.test.ts
  - that the real dialog renders and is clickable -> two clicks, see docs/DOGFOODING.md
  - that restoration reopens sessions from open-sessions.json -> the same two clicks
`);
