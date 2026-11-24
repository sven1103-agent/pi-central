/**
 * Spawning a sidecar beside a session, and taking it down with it (ADR-0018 §1, §11).
 *
 * ## Why the lifetime needs code and not a signal
 *
 * macOS has no parent-death signal (C16 records the same gap for the orchestrator itself). A sidecar whose
 * orchestrator is `kill -9`ed becomes an orphan holding a browser and, worse, a live port. So the lifetime is
 * a **pipe**: the sidecar reads stdin, and exits on EOF when this process closes it. That is a kernel
 * property rather than a promise.
 *
 * ## Why the MCP config is a file and not an argument
 *
 * `pi --mcp-config <path>` is measured to work (Phase 0D) and to point Pi at a config **outside `~/.pi`**.
 * That placement is the security property: `~/.pi` is writable from inside every session (C6), so a config
 * there would let the agent choose which MCP server Pi talks to. The file is 0600 in a 0700 directory under
 * the state root, for the same reason a policy fragment is.
 *
 * ## What is NOT here
 *
 * No `cwd` from the caller, no `--enable` from the caller, and no origin from the caller. This module decides
 * *when* to spawn and *what to tell Pi*; it decides no grants — `composeSidecarPolicy` does, and it can
 * refuse.
 */
import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeSidecarPolicy, type SidecarSpec } from "./sidecar-policy.ts";
import { exitReason, failureTail } from "./child-output.ts";

export interface SidecarHandle {
  /**
   * The MCP config file Pi is pointed at. ONLY VALID once `ready` has resolved.
   *
   * It cannot be known at spawn time any more, and that is the fix rather than a wart: the file names the sidecar's
   * port, the port is chosen by the kernel when the child binds, so the file is written when the bind is announced.
   * A caller that reads this before awaiting `ready` gets a path that does not exist yet — which is why `piArgs`
   * below exists, so the argv can only be built from a handle that already waited.
   */
  configFile: string;
  /** The origin this sidecar serves, for the Inspector. Known once `ready` resolves. */
  origin: string;
  /** The dev-server port this session was assigned, which the sidecar's egress is pinned to. */
  devPort: number;
  /** The bearer token, for delivery to Pi's environment (never into the config file). */
  token: string;
  /** The port the sidecar actually bound, once it said so. */
  port: () => number | undefined;
  /**
   * Resolves once the sidecar has BOUND a port and its MCP config has been written, or rejects when it exits first.
   *
   * The port is the kernel's choice (`--port 0`), not arithmetic on the session id. That is what makes two fleets
   * unable to collide: with `47800 + ordinal` a second launch derived the same number for its own `s18` and lost
   * the bind to a sidecar left over from the first.
   */
  ready: Promise<number>;
  /** Stop it and wait. Idempotent. */
  stop: () => Promise<void>;
  /** True once the process has exited, so a caller can reap without guessing. */
  readonly gone: boolean;
  /**
   * Why it could not start, once that is known.
   *
   * Set by the supervisor, which owns the promise: `spawnSidecar` is synchronous and the death is not. Read again when
   * the session's argv is built, so a sidecar that died immediately is not handed to Pi as healthy.
   */
  failure?: string | undefined;
}

export interface SidecarSpawn {
  /** The session this sidecar belongs to. Used for paths and for logs, never for grants. */
  sessionId: string;
  /** The dev server's port. Egress is pinned to it, so it is the one thing that must be right. */
  port: number;
  /** Where the sidecar's state lives. Under the orchestrator's state root — never `/tmp` (D-5). */
  stateRoot: string;
  safehouse: string;
  /** The sidecar executable: a fixed binary (or an interpreter), driven by a fixed verb set. */
  sidecar: string;
  /**
   * The directory the sidecar's code lives in, granted read-only to the sandbox.
   *
   * Measured: without it a source-launched sidecar never starts — the interpreter cannot open a script
   * outside its workdir, and the failure is a silent hang with no output and no exit.
   */
  sidecarCodeDir: string;
  /** Arguments before the sidecar's own flags — the script path when `sidecar` is an interpreter. */
  sidecarArgs?: string[];
  /** The browser executable, resolved by configuration. */
  browser: string;
  onLog?: (line: string) => void;
}

/**
 * Spawn the sidecar and write the MCP config that points Pi at it.
 *
 * Order matters and it is the same order as a session's: compose the policy (which validates the id, the
 * profile location and the port, and RENDERS the fragment), then spawn, then hand Pi a config file. A
 * refusal from `composeSidecarPolicy` must happen before anything is written, so a bad spec leaves no
 * half-configured state behind.
 *
 * @throws if the policy refuses the spec, or the process fails to start. Both are launch-time refusals: a
 *   sidecar that exists but cannot be confined is worse than none.
 */
/** The first port a sidecar may use. High and uncommon, so it does not collide with a dev server. */
const SIDECAR_PORT_BASE = 47800;

/**
 * A stable, per-session offset into the sidecar port range.
 *
 * Derived from the session id (`s1`, `s2`, …) and bounded, so two sidecars cannot drift into the same port.
 * A session id that is not of that shape falls back to 0, which is safe: a collision then surfaces as a stated
 * bind failure rather than a silent mix-up.
 */
function sessionOrdinal(sessionId: string): number {
  const match = /^s(\d+)$/.exec(sessionId);
  return match === null ? 0 : Number(match[1]) % 200;
}

/**
 * The first port a session's dev server is assigned. Directly above the sidecar listen range
 * (`SIDECAR_PORT_BASE` .. +199), so the two can never meet.
 */
export const DEV_PORT_BASE = 48000;

/**
 * The dev-server port Pi Central assigns a session (ADR-0018 §14).
 *
 * Assigned rather than discovered, because the sidecar's egress is pinned to ONE port and an agent cannot know
 * its dev server's: frameworks default to 5173 or 3000 and silently move to the next free port, which in a
 * second session would be the OTHER session's server. A per-session port makes that collision impossible by
 * construction instead of by luck.
 */
export function devPortFor(sessionId: string): number {
  return DEV_PORT_BASE + sessionOrdinal(sessionId);
}

/**
 * Attach a no-op handler so a rejection nobody awaited is a recorded fact rather than a process-ending event.
 *
 * Node treats an unhandled rejection as fatal, and this promise rejects in a state the caller might not be watching — a
 * sidecar told to stop, or one whose spawn failed after the caller moved on. The returned promise still rejects for
 * anyone who awaits it; this only stops the timer running out from crashing a process that was not asking.
 */
function markHandled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/**
 * How long a sidecar has to announce its port before it is pronounced dead.
 *
 * Generous on purpose: a real sidecar under Safehouse announces in well under a second, and the cost of being wrong in
 * this direction is refusing a working browser rather than accepting a broken one.
 */
const READY_TIMEOUT_MS = 15_000;

/** The pids listening on a TCP port, via a fixed binary and a fixed argv. Empty when none, or when lsof cannot say. */
function listenerPids(port: number): number[] {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
    timeout: 3000,
  });
  // lsof exits 1 when nothing matches, which is the ordinary "free" answer, and fails to start when it is missing.
  if (result.error !== undefined || result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((token) => Number(token.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
}

/**
 * Whether anything is listening on a TCP port, on either address family.
 *
 * Best effort: when `lsof` is missing or fails, the answer is "no", which degrades to the unchecked assignment
 * rather than refusing to start a session. `lsof` exits 1 when nothing matches, which is the normal "free" case.
 */
export function portHasListener(port: number): boolean {
  return listenerPids(port).length > 0;
}

/**
 * Stop whatever is still listening on a dev port Pi Central ASSIGNED, and return the pids it signalled.
 *
 * Needed because a dev server an agent starts does not die with its session. Measured: three Python servers were
 * still listening after both harness runs had exited. The session's teardown signals its process group, and a
 * server started with `&` from Pi's bash tool is not in it — it is reparented to launchd and holds its port until
 * reboot. The port is the only handle left, and it is a safe one: the range is reserved, an assigned port belongs to
 * exactly one live session, and `pickDevPort` refused any port that already had a listener when it was handed out.
 *
 * Callers must pass ONLY an assigned port. An explicit or pinned port is the user's own (5173 is somebody's real
 * dev server), and signalling it would be a far worse defect than the leak.
 */
export function reapDevPort(port: number, self: number = process.pid): number[] {
  const signalled: number[] = [];
  for (const pid of listenerPids(port)) {
    if (pid === self) continue;
    try {
      process.kill(pid, "SIGTERM");
      signalled.push(pid);
    } catch {
      // Already gone, or not ours to signal: either way there is nothing more to do.
    }
  }
  return signalled;
}

/**
 * Remove an assigned port's sidecar directory: the config, the rendered fragment, and the browser profile.
 *
 * A sidecar's PROCESS is stopped on every path that ends a session, but its state was never removed. Measured on a dev
 * install: five session directories under `<state>/sidecars/`, and nothing ever read them again. Sessions are numbered
 * from `s1` on every launch, so the ids are REUSED -- the directories are overwritten rather than accumulating forever,
 * which is why the leak was invisible: a stale `s1` looks exactly like a current one, and its `mcp.json` names a port
 * and a token that no longer exist.
 *
 * Removed only for a port Pi Central ASSIGNED. A pinned port belongs to a session the reader configured by hand, and
 * this function cannot tell whether they still want the profile.
 *
 * Best effort, and silent on failure: a directory that cannot be removed is a startup-crash left behind, and failing a
 * session stop over it would trade a small leak for a lost session.
 */
export function removeSidecarState(stateRoot: string, sessionId: string): boolean {
  try {
    rmSync(join(stateRoot, "sidecars", sessionId), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The dev port a session is given: its own number if it is free, otherwise the next free one in the range.
 *
 * "Its own number" is not enough on its own. Session ids restart at `s1` with every orchestrator, so the same
 * session number gets the same port every time, and a dev server the previous run's agent left behind is still
 * holding it. Measured: the next session's sidecar probed that stale server, got a 404 page with no problems, and
 * reported `verdict: ok` for a page that overflowed by 720px — a clean answer about someone else's server, which
 * is the one failure the per-session assignment exists to prevent.
 *
 * `taken` is every port already assigned to a live session, which may not be listening yet. Returns undefined
 * when the whole range is exhausted, and the caller starts the session without a sidecar rather than guessing.
 */
export function pickDevPort(
  sessionId: string,
  taken: ReadonlySet<number>,
  listening: (port: number) => boolean = portHasListener,
): number | undefined {
  const first = sessionOrdinal(sessionId);
  for (let step = 0; step < 200; step += 1) {
    const port = DEV_PORT_BASE + ((first + step) % 200);
    if (taken.has(port) || listening(port)) continue;
    return port;
  }
  return undefined;
}

/**
 * What the agent is told about its browser, appended to Pi's system prompt.
 *
 * The number is written INTO the text rather than left as `$PI_CENTRAL_DEV_PORT`: an instruction the agent has to
 * expand itself is one it gets wrong. The variable exists too, for scripts. "Do not fall back" is the line that
 * matters: a server that moves to another port is simply unreachable for the sidecar, which is the whole point
 * of the pin.
 */
/**
 * Is this Pi Central's own checkout?
 *
 * Pi Central refuses to start inside a session (C1), so a session working on its own UI has one way to see anything:
 * serve only the UI, with no orchestrator. Measured: an agent asked to start the dev server and look at the login page
 * in a Pi Central checkout spent its whole turn discovering C1, offering three workarounds, and never showed a
 * screenshot -- correct reasoning to the wrong prompt.
 *
 * Detected by the manifest's name rather than a path: the checkout can live anywhere, and a project merely NAMED
 * pi-central is not the same thing. Advisory only -- it changes what the agent is TOLD, never what the sidecar does.
 */
export function isPiCentralCheckout(cwd: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
    return manifest.name === "pi-central";
  } catch {
    return false;
  }
}

export function sidecarInstruction(devPort: number, selfHosted = false): string {
  return [
    "## Your browser",
    "",
    "You have a UI sidecar: a browser in its own sandbox, reached through the `mcp__pi_central_sidecar__*` tools",
    "(`capture`, `probe`, `act`, `info`). It can reach exactly ONE address: http://localhost:" + devPort + ".",
    "",
    "- Start any dev server or preview you want to look at on port " + devPort + ", and do not let it fall back to",
    "  another port. For example `vite --port " + devPort + " --strictPort`, `next dev -p " + devPort + "`, or",
    "  `python3 -m http.server " + devPort + " --bind 127.0.0.1`. `$PI_CENTRAL_DEV_PORT` holds the same number.",
    "- **Not every project can be served from here, and the reason is C1.** A process inside a sandbox cannot apply",
    "  another Seatbelt profile, so an app whose own start script spawns a sandboxed child -- Pi Central itself is the",
    "  clear case -- fails with 'Pi Central cannot start: this process is inside a sandbox'. That is the guard working,",
    "  not a misconfiguration, and no flag makes it work. For such a project serve only the part you need to LOOK at:",
    "  a static build, a component harness, or a dev-server-only run. If the only way to see it is an orchestrator, say",
    "  so and stop -- do not spend turns looking for a way around a sandbox you are inside.",
    "- Prefer `probe` (a compact verdict on overflow, contrast, overlap and console errors) and use `capture` only",
    "  when that is not enough: a screenshot costs thousands of tokens.",
    "- To SEE a screenshot, call the typed function from a codemode script and show the image:",
    `  \`const r = await tools.mcp__pi_central_sidecar__capture({ url: "http://localhost:${devPort}/" }); image(r.content[0]);\``,
    "  The `mcp({ tool })` proxy forms return only the caption.",
    ...(selfHosted
      ? [
          "",
          "### This project IS Pi Central",
          "",
          "Its own orchestrator cannot start from here (C1 -- a sandbox cannot nest), so `npm run server` will refuse.",
          "Serve only the UI on the port above, with no orchestrator:",
          "",
          "  PI_CENTRAL_WS=ws://127.0.0.1:8787 npm run ui:dev -- --port " + String(devPort) + " --strictPort",
          "",
          "The socket is then dead, so the page renders its disconnected state. That is enough to review layout, styling",
          "and rendering, and it is all that is reviewable from inside a sandbox. Say plainly what you could not see.",
        ]
      : []),
  ].join("\n");
}

export function spawnSidecar(options: SidecarSpawn): SidecarHandle {
  const root = join(options.stateRoot, "sidecars", options.sessionId);
  const token = randomBytes(24).toString("hex");
  const spec: SidecarSpec = {
    id: options.sessionId,
    port: options.port,
    // Under the state root, not /tmp: the profile holds the endpoint file for a remote-control socket.
    profileDir: join(root, "profile"),
    fragmentDir: join(root, "policy"),
    safehouse: options.safehouse,
    // The sidecar is a NODE SCRIPT here rather than a compiled binary, because Phase 2 runs from source.
    // The argv shape is what matters and it is fixed: executable, then two flags with validated values.
    sidecar: options.sidecar,
    sidecarCodeDir: options.sidecarCodeDir,
    browser: options.browser,
    /*
     * PORT 0 — the kernel chooses, and the child announces what it got.
     *
     * The arithmetic was `SIDECAR_PORT_BASE + sessionOrdinal(id)`, justified as unique because session ids are
     * unique *per orchestrator*. That is true and it is not the property needed: ids restart at `s1` on every
     * launch, so a sidecar left over from an earlier run derives the same number for its own `s18` and wins the
     * bind. Reported from use as a failed session browser on port 47818 with no second window open.
     *
     * Probing before spawning does NOT fix it — measured, both fleets probe before either binds, see the port free,
     * and both pick it. The only thing that cannot be raced is the bind, so the kernel decides and two sidecars
     * cannot be handed the same port.
     *
     * The cost: the port is unknown until the child reports it, so `mcp.json` is written then, and the argv that
     * carries `--mcp-config` is built after. That is why `start`/`resume` are async now.
     */
    listenPort: 0,
    token,
    ...(options.sidecarArgs === undefined ? {} : { sidecarArgs: options.sidecarArgs }),
  };

  // Throws on a bad id, a shared temp root, or a port that is not a port. Before any file is written.
  const composed = composeSidecarPolicy(spec);

  mkdirSync(root, { recursive: true, mode: 0o700 });

  /**
   * The bearer token, generated here and never written into the config file.
   *
   * The config names it as `${PI_CENTRAL_SIDECAR_TOKEN}`, which Pi interpolates from its own environment — and
   * C15 is why it must: Safehouse runs a session under `env -i`, so a variable reaches Pi only when it is
   * requested by name via `--env-pass`. Putting the literal token in mcp.json would work and would also write a
   * secret to a file that outlives the session.
   */
  const child: ChildProcess = spawn(composed.launch.command, composed.launch.args, {
    // `stdin` is the lifetime mechanism: when this process dies or closes it, the sidecar exits on EOF.
    stdio: ["pipe", "pipe", "pipe"],
    cwd: composed.launch.cwd,
    // Explicit, never inherited (C4a/C11): the sidecar is a renderer and gets no ambient secrets.
    env: { ...composed.launch.env },
  });

  // Every line, kept for the failure message AND offered to the port announcement below.
  const pendingPortListeners: ((line: string) => void)[] = [];
  let stderrTail = "";
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    stderrTail = (stderrTail + text).slice(-4000);
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      options.onLog?.(line.trimEnd());
      for (const listener of pendingPortListeners) listener(line);
    }
  });
  child.stdout?.on("data", (chunk) => options.onLog?.(String(chunk).trimEnd()));

  let gone = false;
  /**
   * A failed spawn must surface, not escape.
   *
   * Node emits `error` and then `close` when the binary is missing. Without an `error` listener that event is
   * unhandled and the process dies — so an unavailable sidecar would take the orchestrator with it, which is
   * the opposite of a supervisor's job. Recorded and resolved into the same `exited` promise, so `stop()`
   * and `gone` stay truthful either way.
   */
  let spawnError: Error | undefined;
  /**
   * HOW it ended, kept for the failure message.
   *
   * The exit status used to be discarded here, so the only thing that could be said about a dead sidecar was "it
   * exited before it could listen" — true, and useless. It is recorded once (`??=`) because `exit` and `close`
   * both fire, and the first is the one that carries the status.
   */
  let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  /**
   * Resolves on `close`, which is the event that means "the process is gone AND its stdio is drained".
   *
   * This is NOT the same moment as `exit`, and the difference is the whole point of this fix. `exit` fires when
   * the process ends; `close` fires once the last of stderr has been delivered on the pipe. Measured: rejecting
   * on `exit` produced a failure message with NO tail at all for a sidecar that died on an uncaught exception —
   * the fatal line arrived on the next tick, after the promise had already been rejected. So the promise waits for
   * `close`, and `exit` only records the status.
   *
   * `stop()` awaited `exited` before this change too, so it already tolerated the extra tick: it is the same
   * condition, stated more precisely.
   */
  const exited = new Promise<void>((done) => {
    child.once("exit", (code, signal) => {
      ended ??= { code, signal };
      gone = true;
    });
    child.once("close", (code, signal) => {
      ended ??= { code, signal };
      gone = true;
      done();
    });
    child.once("error", (error) => {
      spawnError = error;
      gone = true;
      done();
    });
  });

  const stop = async (): Promise<void> => {
    if (gone) {
      if (spawnError !== undefined) throw spawnError;
      return;
    }
    // Closing stdin is the graceful path: the sidecar shuts its browser down and exits.
    child.stdin?.end();
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((done) => setTimeout(() => done(false), 3000)),
    ]);
    if (!graceful) {
      child.kill("SIGTERM");
      const terminated = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((done) => setTimeout(() => done(false), 2000)),
      ]);
      // A sidecar that outlives its session holds a browser and a port, which is the whole failure mode this
      // file exists to prevent. SIGKILL rather than a third wait.
      if (!terminated) child.kill("SIGKILL");
    }
    await exited;
    if (spawnError !== undefined) throw spawnError;
  };

  /**
   * PORT 0: the kernel chooses, and the child announces what it got.
   *
   * ## Why the arithmetic was wrong, measured two ways
   *
   * It was `SIDECAR_PORT_BASE + ordinal`, justified as unique because session ids are unique *per orchestrator*.
   * True, and not the property needed: ids restart at `s1` on every launch, so a second launch derives the same
   * port for its own `s18` — reported from use as a failed session browser on port 47818 with no second window
   * open. The port was held by a sidecar left over from an earlier launch, because nothing ever reaped a listen
   * port (there is a `reapDevPort` for the dev port and no equivalent here).
   *
   * ## Why probing first does not fix it
   *
   * Tried and measured: two fleets pumped a sidecar each, BOTH derived 47801, and the second died on EADDRINUSE.
   * A pre-bind probe answers "free now", so both conclude yes and both pick it. Two processes cannot agree on a
   * number by looking at it.
   *
   * ## What this does instead
   *
   * The only thing that cannot be raced is the bind itself, so the kernel picks. Two sidecars cannot be given the
   * same port, and a leftover from a dead launch simply holds a different one.
   *
   * ## The cost, stated
   *
   * The port is not known until the child announces, so `mcp.json` — which must name it — is written THEN, and the
   * argv that carries `--mcp-config` must be built after. That is why this file exposes `piArgs`/`mcpConfigArgs` as
   * promises and why `Supervisor.start`/`resume` became async. It was knowingly traded away before ("a large
   * change justified by a detail"); the detail turned out to be a shipped defect.
   */


  const configFile = join(root, "mcp.json");

  /** The port the child reported. Undefined until it does, which is the whole reason `ready` exists. */
  let bound: number | undefined;

  /**
   * Write the MCP config for a port that has actually been bound.
   *
   * The token is referenced by name, not written: Pi interpolates `${PI_CENTRAL_SIDECAR_TOKEN}` from its own
   * environment, and C15 is why the variable must also be requested through `--env-pass` — Safehouse runs a
   * session under `env -i`, so an inherited variable is discarded. A literal token here would work and would
   * also leave a secret in a file that outlives the session.
   *
   * Mode 0600, and 0700 on the directory: the file names a bearer-authenticated endpoint, so it is as private as
   * the token it refers to.
   */
  const writeConfig = (target: number): void => {
    writeFileSync(
      configFile,
      JSON.stringify(
        {
          mcpServers: {
            pi_central_sidecar: {
              // A URL, not a command: the orchestrator owns the process, so Pi CONNECTS rather than spawning it
              // inside the session's sandbox (which C1 makes impossible — measured as "Path does not exist").
              url: `http://127.0.0.1:${target}/mcp`,
              headers: { Authorization: "Bearer ${PI_CENTRAL_SIDECAR_TOKEN}" },
            },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  };

  return {
    configFile,
    /*
     * The Inspector's address is the DEV server the browser may reach, not the sidecar's own listening port.
     * Two different ports answering two different questions (ADR-0018 §12), and the reader wants the one they can
     * click. Known at spawn time, so it does not have to wait for the bind.
     */
    origin: `http://localhost:${options.port}`,
    devPort: options.port,
    token,
    port: () => (gone ? undefined : bound),
    /*
     * The spawn is already in flight, so "ready" must not be a resolved promise: a sidecar that died at launch was
     * handed to the supervisor as healthy, the session was launched with --mcp-config and a token for a server that
     * would never answer, and the failure surfaced only later as "Connection closed" -- or, worse, not at all, with a
     * session that reported a browser it could not reach.
     *
     * `race` rather than `exited`: the normal case is a process that outlives this promise, and that case must resolve.
     */
    ready: /* a promise whose rejection is the answer, not an accident: every caller that ignores it must still not
              turn a dead sidecar into a crashed orchestrator. Marked handled, and each caller attaches its own. */
    markHandled(new Promise<number>((resolve, reject) => {
      /*
       * THREE outcomes, and the middle one is the one that was missing: the sidecar announces its listening port, it
       * exits first, or it is still starting when a deadline passes. The first version raced the port against `exited`
       * and resolved on a microtask, which is not a success condition at all -- measured: with a safehouse path that does
       * not exist, `ready` still resolved. That made "it started" unfalsifiable, and every caller treating it as a
       * health check was reading a promise that could not say no.
       *
       * The deadline is deliberately generous: a real sidecar under Safehouse announces within a second, and the cost of
       * being wrong here is refusal of a working browser rather than acceptance of a broken one.
       */
      const timer = setTimeout(() => {
        reject(new Error(`the sidecar did not announce a port within ${READY_TIMEOUT_MS} ms`));
      }, READY_TIMEOUT_MS);
      timer.unref?.();
      void exited.then(() => {
        clearTimeout(timer);
        /*
         * THE message the reader and the agent both read, so it carries the evidence rather than a restatement of
         * the symptom.
         *
         * Measured: a reader saw "the sidecar exited before it could listen (port 47816)" and asked what went
         * wrong. Nothing in this process could answer, because the child's stderr was collected into `stderrTail`
         * and never read — the child had printed `listen EADDRINUSE` and the orchestrator threw it away. So the
         * exit status and the tail are both in the sentence now: the first because it distinguishes a crash from a
         * killed process, the tail because it names the cause.
         */
        reject(
          spawnError ??
            new Error(
              `${exitReason(ended?.code ?? null, ended?.signal ?? null, "the sidecar")} before it could listen` +
                `${failureTail(stderrTail) ? `:\n${failureTail(stderrTail)}` : ""}`,
            ),
        );
      });
      /*
       * The announcement is the ONLY way the port is known now, so this pattern is load-bearing.
       *
       * It arrives on stderr as `sidecar listening on 127.0.0.1:<port> origin=...`. The port is captured rather
       * than compared, because the kernel chose it — the old comparison against a predicted number cannot work at
       * all here. Anchored to that shape rather than to a bare number so a log line that happens to mention a port
       * cannot be mistaken for the bind.
       */
      pendingPortListeners.push((line: string) => {
        const match = /sidecar listening on 127\.0\.0\.1:(\d+)/.exec(line);
        if (match === null) return;
        const announced = Number(match[1]);
        if (!Number.isInteger(announced) || announced < 1 || announced > 65535) return;
        clearTimeout(timer);
        bound = announced;
        // Written HERE, not before the spawn: the file names the port, and the port did not exist until now.
        try {
          writeConfig(announced);
        } catch (error) {
          reject(error as Error);
          return;
        }
        resolve(announced);
      });
    })),
    stop,
    get gone() {
      return gone;
    },
  };
}

/**
 * The `--mcp-config` argument a session needs, or nothing when it has no sidecar.
 *
 * Returned as a list rather than a string so it is appended to Pi's argv without a shell, and so the
 * caller cannot accidentally place it after the subcommand — `pi mcp list --mcp-config X` reports
 * "Unknown option", which is how Phase 0D nearly concluded the flag did not exist.
 */
export function mcpConfigArgs(handle: SidecarHandle | undefined): Promise<string[]> {
  return Promise.resolve(handle === undefined ? [] : ["--mcp-config", handle.configFile]);
}

/**
 * The `--mcp-config` argument, once it CAN be named.
 *
 * The config file is written when the sidecar announces its bound port, so a caller that reads `configFile`
 * before that gets a path that does not exist and Pi reports "0 servers configured" — measured, and the exact
 * symptom that sent a session hunting `mcp-cache.json`.
 *
 * The wrong-right answer is to keep the file path static and write it early from a predicted port; that is the
 * defect this replaced. So the wait is explicit and happens HERE, at the one place the argv is assembled, rather
 * than being remembered at every call site.
 *
 * A sidecar that dies is not fatal to the session: the browser is a capability, so the rejection is swallowed and
 * the session is launched without `--mcp-config`. The absence is already reported on the session's warnings and to
 * the agent's system prompt (see `sidecarPromptArgs`), which is where the reader and the model both look.
 */
export async function readyMcpConfigArgs(handle: SidecarHandle | undefined): Promise<string[]> {
  if (handle === undefined) return [];
  try {
    await handle.ready;
  } catch {
    return [];
  }
  return ["--mcp-config", handle.configFile];
}

/** The system-prompt text for a session that has a sidecar, as Pi arguments. Nothing when it has none. */
/**
 * What a session with NO browser is told.
 *
 * Nothing, until a measured turn: a session asked to screenshot its dev server found no `pi_central_sidecar` server,
 * no `PI_CENTRAL_SIDECAR_TOKEN`, and a STALE entry for it in `mcp-cache.json` left by an earlier session. It then spent
 * the turn reading MCP configuration files and reporting "the sidecar isn't registered", which was accurate and useless:
 * the reader had simply started this session without the browser, and the session had no way to know that.
 *
 * Silence is what made a hundred plausible explanations equally available. So it says the one thing that is true and
 * actionable, and it says the FORBIDDEN diagnosis too, because a stale cache entry is a trap that looks like evidence.
 */
export const NO_SIDECAR_INSTRUCTION = [
  "## Your browser",
  "",
  "You have NO UI sidecar in this session, so `mcp__pi_central_sidecar__*` does not exist and you cannot capture or",
  "probe a page. This is a normal state, not a fault: the browser is per session and this one was started without it.",
  "",
  "- To get one, the reader ticks **Preview its work in a browser** in Settings, or the checkbox in the directory",
  "  picker, and starts a NEW session. A running session cannot gain one.",
  "- Do NOT investigate this. `mcp({})`, `mcp-adapter.json`, `mcp-cache.json` and your own environment will",
  "  suggest several explanations -- including a STALE \`pi_central_sidecar\` tool cache from an earlier session, which",
  "  is not evidence that the server is configured in this one. The answer is above, so report it and continue.",
  "- Without a browser, verify rendering by other means: read the code, ask the reader, or run whatever the project",
  "  already has for tests.",
].join("\n");

/**
 * The one sentence a reader sees when a session asked for a browser and did not get one.
 *
 * A FAULT, not a setting, and it says so: the other reason to have no browser is not asking, and conflating them sends the
 * reader looking for a switch they already turned on. The cause is named when it is known, because "it failed" without one
 * is what sent a measured session to `mcp-adapter.json` and `mcp-cache.json` for an explanation.
 */
export function sidecarFailureWarning(cause: string): string {
  return (
    `No session browser: ${cause}. This is a fault rather than a setting — sessions here get one normally. ` +
    `${sidecarFailureAdvice(cause)} This session cannot capture a page.`
  );
}

/**
 * What to DO about it, chosen from the cause.
 *
 * One sentence for every cause was the defect: it ended "the orchestrator's log has the detail", which is true for
 * a crash and actively wrong twice over for the other two. A C1 refusal is not a fault at all — the reader's setup
 * is fine and the product cannot work from where it was started — and nothing about it is in the orchestrator's
 * log, so the advice sent them to read a file that would not answer them.
 *
 * Matched on the child's own words, which is why this can only exist once the tail reaches the message (see the
 * rejection in `spawnSidecar`). Order matters: the C1 case is checked first because `safehouse` reports it before
 * anything else can fail.
 */
export function sidecarFailureAdvice(cause: string): string {
  if (/sandbox_apply|Operation not permitted/i.test(cause)) {
    return (
      "This is Seatbelt refusing to nest (C1): the orchestrator is itself sandboxed, so it cannot apply a policy " +
      "for the browser's sandbox. Run Pi Central from a plain terminal — not from an editor task, a sandboxed " +
      "agent harness, or another Safehouse session."
    );
  }
  if (/cannot listen|EADDRINUSE/i.test(cause)) {
    return (
      "The port is already in use — a previous Pi Central launch (or another session) is still holding this " +
      "session's browser port. Quit the other instance, or start this session again to be given a different port."
    );
  }
  if (/ENOENT|no such file|cannot find/i.test(cause)) {
    return (
      "A file the browser needs is missing: the browser executable or the sidecar bundle named in configuration " +
      "does not exist at that path."
    );
  }
  return "The orchestrator's log has the rest of the detail.";
}

export function sidecarPromptArgs(
  handle: SidecarHandle | undefined,
  cwd?: string,
  offered = false,
): string[] {
  // A session without a browser is TOLD it has none, because silence produced a whole turn of investigation. Only when
  // the installation OFFERS the capability: on a machine with no browser configured, a paragraph about a feature the
  // reader never had is noise in every session's prompt, and the orchestrator says so once at startup instead.
  if (handle === undefined) return offered ? ["--append-system-prompt", NO_SIDECAR_INSTRUCTION] : [];
  return [
    "--append-system-prompt",
    sidecarInstruction(handle.devPort, cwd === undefined ? false : isPiCentralCheckout(cwd)),
  ];
}
