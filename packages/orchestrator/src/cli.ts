/**
 * Phase 1 smoke command (ROADMAP).
 *
 * Proves the headless orchestrator works end to end without a UI:
 * start a session (optionally in the app-owned default workspace), prompt it, watch it
 * settle, list history, and resume one.
 *
 * It SPAWNS REAL SANDBOXED SESSIONS, so it must run from a plain terminal. Seatbelt does not
 * nest: run inside another sandbox and `sandbox-exec` fails with EPERM (C1).
 */
import { createInterface } from "node:readline/promises";
import { defaultConfig, checkWorkspaceRoot } from "./config.ts";
import { discover } from "./registry.ts";
import { checkResumable } from "./resume.ts";
import { Supervisor } from "./supervisor.ts";

interface Options {
  cwd?: string;
  prompt?: string;
  mode: "sandboxed" | "direct";
}

function parseArgs(argv: string[]): Options & { command: string; target?: string } {
  const [command = "help", ...rest] = argv;
  const options: Options & { command: string; target?: string } = { command, mode: "sandboxed" };
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--cwd") {
      const value = rest[++i];
      if (value !== undefined) options.cwd = value;
    } else if (arg === "--prompt") {
      const value = rest[++i];
      if (value !== undefined) options.prompt = value;
    } else if (arg === "--direct") options.mode = "direct";
    else if (arg !== undefined && !arg.startsWith("--")) positionals.push(arg);
  }
  if (positionals[0] !== undefined) options.target = positionals[0];
  return options;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const config = defaultConfig();

  switch (options.command) {
    case "help":
      printHelp(config.workspaceRoot);
      return 0;
    case "history":
      return await history(config);
    case "run":
      return await run(config, options);
    case "resume":
      return await resume(config, options);
    default:
      console.error(`unknown command: ${options.command}\n`);
      printHelp(config.workspaceRoot);
      return 2;
  }
}

function printHelp(workspaceRoot: string): void {
  console.log(`pi-central orchestrator (Phase 1 smoke)

Usage:
  cli.ts history                       list discovered sessions
  cli.ts run [--cwd DIR] [--prompt S]  start a session and prompt it
  cli.ts run --prompt S                start in the app-owned default workspace
  cli.ts resume <id|path> [--prompt S]  resume a session in its own recorded directory
  cli.ts run --direct                  skip the sandbox (feasibility only)

The default workspace is ${workspaceRoot}

Run this from a plain terminal: Seatbelt does not nest, so a sandboxed session cannot be
started from inside another sandbox (C1).`);
}

async function history(config: ReturnType<typeof defaultConfig>): Promise<number> {
  const { sessions, skipped } = await discover(config);
  console.log(`${sessions.length} session(s) discovered; ${skipped.length} skipped\n`);
  for (const s of sessions.slice(0, 20)) {
    const flags = [!s.cwdExists ? "MISSING-CWD" : "", s.scratch ? "scratch" : ""].filter(Boolean).join(",");
    console.log(`  ${s.id.slice(0, 8)}  ${s.cwd}${flags ? `  [${flags}]` : ""}`);
    if (s.firstMessage) console.log(`            ${s.firstMessage.slice(0, 80)}`);
  }
  if (skipped.length > 0) {
    console.log("\nskipped:");
    for (const s of skipped.slice(0, 5)) console.log(`  ${s.path}: ${s.reason}`);
  }
  return 0;
}

/**
 * Resume a discovered session in its own recorded directory (US-5).
 *
 * The directory is validated BEFORE spawning, because RPC-mode Pi exits 1 on a missing cwd
 * rather than prompting (C2, `dist/main.js:558`). Pi Central never retargets the session
 * (ADR-0008): an unusable directory is refused, and the remedy is a new session.
 */
async function resume(config: ReturnType<typeof defaultConfig>, options: Options & { target?: string }): Promise<number> {
  if (!options.target) {
    console.error("usage: cli.ts resume <id|path> [--prompt S]");
    return 2;
  }

  const { sessions } = await discover(config);
  const match =
    sessions.find((s) => s.path === options.target) ??
    sessions.find((s) => s.id === options.target) ??
    sessions.find((s) => s.id.startsWith(options.target as string));

  if (!match) {
    console.error(`no session matches ${options.target}`);
    return 1;
  }

  // Pre-flight, before any spawn. This is the whole point of resume.ts.
  const readiness = checkResumable(match);
  if (!readiness.ok) {
    console.error(`\nCannot resume this session.\n\n${readiness.message}`);
    return 1;
  }

  const supervisor = new Supervisor(config);
  supervisor.on("error", (id: string, message: string) => console.error(`\n[session ${id} error] ${message}`));

  const result = supervisor.resume(match, { mode: options.mode });
  if (!result.ok) {
    console.error(`could not resume: ${result.message}`);
    return 1;
  }

  const session = result.session;
  console.log(`\nresumed ${match.id.slice(0, 8)} in ${session.cwd}`);
  console.log(`  isolation: ${session.isolation}`);
  console.log(`  history: ${match.messageCount} message(s) on disk`);

  const ready = await waitFor(() => session.state !== "starting", 30_000);
  if (!ready || session.state === "failed") {
    console.error(`\nsession failed to resume:\n${session.error ?? "(no detail)"}`);
    await supervisor.stopAll();
    return 1;
  }

  if (options.prompt) {
    await supervisor.prompt(session.id, options.prompt);
    await waitFor(
      () => session.state === "idle" || session.state === "awaiting-approval" || session.state === "failed",
      180_000,
    );
  }

  await supervisor.stopAll();
  return match.cwdExists ? 0 : 1;
}

async function run(config: ReturnType<typeof defaultConfig>, options: Options): Promise<number> {
  // Refuse a workspace that violates D-5 before spawning anything.
  const violations = checkWorkspaceRoot(config.workspaceRoot);
  if (!options.cwd && violations.length > 0) {
    console.error(`The configured workspace root violates D-5:\n${config.workspaceRoot}`);
    for (const v of violations) console.error(`  - ${v.reason}`);
    console.error("\nSet PI_CENTRAL_WORKSPACE to a safe path.");
    return 1;
  }

  const supervisor = new Supervisor(config);
  supervisor.on("error", (id: string, message: string) => {
    console.error(`\n[session ${id} error] ${message}`);
  });
  supervisor.on("update", (session) => {
    process.stdout.write(`\r  state=${session.state} msgs=${session.messageCount} pending=${session.pending}   `);
  });

  const result = supervisor.start({ ...(options.cwd ? { cwd: options.cwd } : {}), mode: options.mode });
  if (!result.ok) {
    console.error(`could not start: ${result.message}`);
    return 1;
  }
  const session = result.session;
  // Read state fresh from the supervisor each time. The session object is mutated as records
  // arrive, so a cached `session.state` comparison can be narrowed away by TypeScript across
  // an await even though the value genuinely changes underneath.
  const stateNow = () => supervisor.get(session.id)?.state;
  console.log(`\nstarted ${session.id} in ${session.cwd}`);
  console.log(`  isolation: ${session.isolation}`);
  if (session.warnings.length > 0) for (const w of session.warnings) console.log(`  warning: ${w}`);

  // Wait for the session to leave `starting`, so a spawn failure is reported before we prompt.
  const ready = await waitFor(() => stateNow() !== "starting", 30_000);
  if (!ready) {
    console.error(`\nsession did not become ready. state=${stateNow()}${session.error ? `\n${session.error}` : ""}`);
    await supervisor.stopAll();
    return 1;
  }
  if (stateNow() === "failed") {
    console.error(`\nsession failed to start:\n${session.error ?? "(no detail)"}`);
    await supervisor.stopAll();
    return 1;
  }

  const prompt = options.prompt ?? (await ask("prompt> "));
  if (!prompt.trim()) {
    console.log("no prompt; stopping");
    await supervisor.stopAll();
    return 0;
  }

  console.log("sending prompt...");
  await supervisor.prompt(session.id, prompt);

  // Completion is agent_settled, never agent_end (C8) -- wait for the settled state.
  const settled = await waitFor(
    () => ["idle", "awaiting-approval", "failed"].includes(stateNow() ?? ""),
    180_000,
  );
  console.log(`\n\nsettled=${settled} state=${stateNow()}`);
  if (session.error) console.log(`error: ${session.error}`);

  await supervisor.stopAll();
  console.log("stopped. sessions on disk are now resumable with `cli.ts history`.");
  return settled && stateNow() !== "failed" ? 0 : 1;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

// Exposed so `resume` can share the validation with any future caller.
export { checkResumable };

process.exitCode = await main();
