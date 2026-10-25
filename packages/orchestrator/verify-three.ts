/**
 * Phase 1 verification: three concurrent sessions, three working directories, no cross-talk.
 *
 * Phase 0 proved isolation for two sessions at the *policy* level. This drives the real
 * Supervisor — the code the product will use — with three live sessions at once, and asks
 * each one (through its own sandboxed `bash`) whether it can reach the others.
 *
 * Run from a PLAIN terminal: Seatbelt does not nest, so a sandboxed session cannot start from
 * inside another sandbox (C1). The harness refuses rather than reporting a false failure.
 *
 *   node packages/orchestrator/verify-three.ts            # fixtures in $HOME, cleaned up
 *   node packages/orchestrator/verify-three.ts --keep     # leave fixtures for inspection
 *
 * Fixtures must NOT live under /tmp or /var/folders: the base profile grants those globally,
 * so a pass there would be a false pass. The harness uses $HOME and says so.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./src/config.ts";
import { Supervisor } from "./src/supervisor.ts";

const KEEP = process.argv.includes("--keep");
const ROOT = process.env.PHASE1_ROOT ?? join(homedir(), `.pi-central-phase1-${process.pid}`);

interface Case {
  dir: string;
  label: string;
  secret: string;
}

const CASES: Case[] = [
  { dir: join(ROOT, "repo-a"), label: "A", secret: "SECRET-A-3f9c" },
  { dir: join(ROOT, "repo-b"), label: "B", secret: "SECRET-B-71d2" },
  { dir: join(ROOT, "repo-c"), label: "C", secret: "SECRET-C-a508" },
];

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}${detail ? `  \x1b[2m— ${detail}\x1b[0m` : ""}`);
  if (!ok) failures += 1;
}

function refuseIfSandboxed(): void {
  // A canary: if sandbox-exec cannot apply a trivial policy, we are boxed in and every check
  // below would be meaningless rather than failing honestly.
  const probe = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)(allow default)", "--", "/usr/bin/true"],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) {
    console.error(
      "\n\x1b[33mThis harness must run from a plain terminal.\x1b[0m\n" +
        "It looks sandboxed, and Seatbelt does not nest (C1):\n" +
        `  ${(probe.stderr || probe.stdout || "sandbox-exec refused").trim()}\n`,
    );
    process.exit(2);
  }
}

function makeFixtures(): void {
  rmSync(ROOT, { recursive: true, force: true });
  for (const c of CASES) {
    mkdirSync(c.dir, { recursive: true });
    writeFileSync(join(c.dir, "secret.txt"), `${c.secret}\n`);
  }
}

/** A probe run *inside* a session, through the model-facing bash tool. */
function probeFor(self: Case, other: Case): string {
  return [
    `if cat ${self.dir}/secret.txt >/dev/null 2>&1; then echo SELF_READ=ok; else echo SELF_READ=denied; fi`,
    `if cat ${other.dir}/secret.txt >/dev/null 2>&1; then echo OTHER_READ=ok; else echo OTHER_READ=denied; fi`,
    `if touch ${other.dir}/canary 2>/dev/null; then echo OTHER_WRITE=ok; else echo OTHER_WRITE=denied; fi`,
    `if ls ${other.dir} >/dev/null 2>&1; then echo OTHER_LIST=ok; else echo OTHER_LIST=denied; fi`,
  ].join("; ");
}

function parseVars(output: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const match of output.matchAll(/([A-Z_]+)=(\w+)/g)) {
    if (match[1] && match[2]) vars[match[1]] = match[2];
  }
  return vars;
}

async function main(): Promise<number> {
  console.log("\n\x1b[1mPi Central — Phase 1: three sessions, three directories, no cross-talk\x1b[0m");
  console.log(`\x1b[2mfixtures: ${ROOT}\x1b[0m`);

  refuseIfSandboxed();
  makeFixtures();

  const config = defaultConfig();
  const supervisor = new Supervisor(config);
  const problems: string[] = [];
  supervisor.on("error", (id, message) => problems.push(`${id}: ${message}`));

  const started = [];
  for (const c of CASES) {
    const result = supervisor.start({ cwd: c.dir, name: `phase1-${c.label}` });
    if (!result.ok) {
      console.error(`\n\x1b[31mcould not start ${c.label}: ${result.message}\x1b[0m`);
      await supervisor.stopAll();
      rmSync(ROOT, { recursive: true, force: true });
      return 1;
    }
    started.push({ c, session: result.session });
  }

  // Wait for all three to leave `starting`.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && started.some((s) => supervisor.get(s.session.id)?.state === "starting")) {
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("\n\x1b[1mIsolation in force\x1b[0m");
  for (const { c, session } of started) {
    const live = supervisor.get(session.id)!;
    console.log(`  ${c.label}  ${live.isolation}`);
    check(`${c.label}: started sandboxed (not "NONE")`, !live.isolation.startsWith("NONE"), live.isolation.slice(0, 60));
    check(`${c.label}: reached the idle state`, live.state === "idle" || live.state === "streaming", live.state);
  }

  // Each session probes one sibling, chosen so every pair is exercised in one direction.
  const pairs: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 0],
  ];

  console.log("\n\x1b[1mCross-directory probes (through each session's own sandbox)\x1b[0m");
  await Promise.all(
    pairs.map(async ([selfIdx, otherIdx]) => {
      const self = started[selfIdx]!;
      const other = started[otherIdx]!;
      const rpc = supervisor.rpcProcess(self.session.id);
      if (!rpc) {
        check(`${self.c.label} → ${other.c.label}: probe dispatched`, false, "no process handle");
        return;
      }
      try {
        const response = (await rpc.send(
          { type: "bash", command: probeFor(self.c, other.c), excludeFromContext: true },
          60_000,
        )) as { output?: string };
        const vars = parseVars(response.output ?? "");
        check(`${self.c.label} reads its OWN secret`, vars.SELF_READ === "ok", `SELF_READ=${vars.SELF_READ}`);
        check(`${self.c.label} reads ${other.c.label}'s secret`, vars.OTHER_READ === "denied", `OTHER_READ=${vars.OTHER_READ}`);
        check(`${self.c.label} writes into ${other.c.label}`, vars.OTHER_WRITE === "denied", `OTHER_WRITE=${vars.OTHER_WRITE}`);
        check(`${self.c.label} lists ${other.c.label}`, vars.OTHER_LIST === "denied", `OTHER_LIST=${vars.OTHER_LIST}`);
      } catch (error) {
        check(`${self.c.label} → ${other.c.label}: probe ran`, false, (error as Error).message);
      }
    }),
  );

  // Independent confirmation from outside every sandbox: a denied write left no file.
  console.log("\n\x1b[1mIndependent confirmation (outside all sandboxes)\x1b[0m");
  for (const c of CASES) {
    check(`${c.label}: no canary file appeared`, !existsSync(join(c.dir, "canary")));
    check(`${c.label}: its own secret is intact`, existsSync(join(c.dir, "secret.txt")));
  }

  // Stopping one must not disturb the others.
  console.log("\n\x1b[1mIndependent lifetimes\x1b[0m");
  await supervisor.stop(started[0]!.session.id);
  check("A reports stopped", supervisor.get(started[0]!.session.id)?.state === "stopped");
  check("B is unaffected", supervisor.get(started[1]!.session.id)?.state !== "stopped");
  check("C is unaffected", supervisor.get(started[2]!.session.id)?.state !== "stopped");

  await supervisor.stopAll();
  check("all sessions stopped", supervisor.list().every((s) => s.state === "stopped" || s.state === "failed"));

  if (problems.length > 0) {
    console.log("\n\x1b[33mSupervisor reported errors:\x1b[0m");
    for (const p of problems) console.log(`  ${p}`);
  }

  if (KEEP) console.log(`\n\x1b[2mfixtures kept: ${ROOT}\x1b[0m`);
  else rmSync(ROOT, { recursive: true, force: true });

  console.log(
    failures === 0
      ? "\n\x1b[32m\x1b[1mAll checks passed.\x1b[0m Three sessions, three policies, no cross-talk.\n"
      : `\n\x1b[31m\x1b[1m${failures} check(s) failed.\x1b[0m\n`,
  );
  return failures === 0 && problems.length === 0 ? 0 : 1;
}

process.exitCode = await main();
