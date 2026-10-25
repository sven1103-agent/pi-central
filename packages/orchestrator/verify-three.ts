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
import { readStore } from "./src/agent-store.ts";
import type { LiveSession } from "@pi-central/protocol";

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

/** An observed fact with no pass/fail: it depends on configuration, not on isolation. */
function info(name: string, detail: string): void {
  console.log(`  \x1b[36mINFO\x1b[0m  ${name}  \x1b[2m— ${detail}\x1b[0m`);
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
        `  ${(probe.stderr || probe.stdout || "sandbox-exec refused").trim()}\n\n` +
        "Run it from a plain shell with:\n" +
        "  \x1b[1mpackages/orchestrator/verify-three.ts\x1b[0m\n" +
        "  (from the repo root: \x1b[1mnode packages/orchestrator/verify-three.ts\x1b[0m)\n",
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

/**
 * The credential boundary (ADR-0010, C4a, C11) — asked from *inside* a live session.
 *
 * Filesystem isolation is not the whole story: Safehouse's sanitized environment allowlist
 * still passes `SSH_AUTH_SOCK` (C4a), and its generated policy grants the host's gitconfig, gh
 * config, and all of `~/.pi` (C6). Each of those is a route to the *user's* credentials, so
 * each is probed here rather than assumed closed from the policy text.
 *
 * Paths are `$HOME`-relative because the session inherits the real HOME (Pi needs `~/.pi`).
 */
function credentialProbeFor(): string {
  return [
    // The environment boundary (C11). Safehouse alone would pass SSH_AUTH_SOCK through.
    `if [ -z "$SSH_AUTH_SOCK" ]; then echo ENV_SSH=absent; else echo ENV_SSH=present; fi`,
    `if [ -z "$HF_TOKEN_STRICT" ]; then echo ENV_TOKEN=absent; else echo ENV_TOKEN=present; fi`,
    // The appended policy fragment's denies.
    `if cat "$HOME/.gitconfig" >/dev/null 2>&1; then echo HOST_GITCONFIG=readable; else echo HOST_GITCONFIG=denied; fi`,
    `if ls "$HOME/.config/gh" >/dev/null 2>&1; then echo HOST_GH=readable; else echo HOST_GH=denied; fi`,
    `if cat "$HOME/.pi/agent/auth.json" >/dev/null 2>&1; then echo HOST_PIAUTH=readable; else echo HOST_PIAUTH=denied; fi`,
    `if ssh-add -l >/dev/null 2>&1; then echo SSHAGENT=reachable; else echo SSHAGENT=unreachable; fi`,
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

  // Plant known host secrets in THIS process, so the credential checks below have teeth.
  //
  // Without this the "is the token absent?" check passes trivially whenever the token is not
  // set in the first place — it would report success while proving nothing. Planting a
  // recognisable value means a regression in the sanitization would be *observed* as
  // `present`, which is the falsifier for ADR-0010 experiments 1 and 2.
  process.env["HF_TOKEN_STRICT"] = "PLANTED-HOST-SECRET-do-not-leak";
  process.env["SSH_AUTH_SOCK"] = "/private/tmp/com.apple.launchd.PLANTED/Listeners";

  const config = defaultConfig();
  const supervisor = new Supervisor(config);
  const problems: string[] = [];
  supervisor.on("error", (id, message) => problems.push(`${id}: ${message}`));

  // Report credential provisioning, since it changes what the checks below can prove. An
  // unprovisioned store is not a failure of isolation, but it does mean the agent has no
  // identity of its own yet (ADR-0010 §5).
  console.log("\n\x1b[1mAgent credential store\x1b[0m");
  const store = readStore(config.agentRoot, {
    ownership: config.agentRootManaged ? "managed" : "external",
  });
  info("agent root", `${config.agentRoot} (${config.agentRootManaged ? "managed" : "external"})`);
  if (store.exists) {
    info("identity", store.identity.email ?? "(no user.email set)");
    info("has", Object.entries(store.has).filter(([, v]) => v).map(([k]) => k).join(", ") || "(nothing)");
  } else {
    info(
      "not provisioned",
      "the agent has no credentials of its own yet; the boundary checks below still hold, " +
        "because a missing GH_CONFIG_DIR/GIT_CONFIG_GLOBAL fails closed rather than falling back",
    );
  }

  const started: { c: Case; session: LiveSession }[] = [];
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

  // The credential boundary, asked from inside one live session (ADR-0010). A single session
  // is enough: the controls are per-session but identical, and the filesystem checks above
  // already prove they are not shared.
  console.log("\n\x1b[1mCredential boundary (from inside session A)\x1b[0m");
  const credentialRpc = supervisor.rpcProcess(started[0]!.session.id);
  if (credentialRpc) {
    try {
      const response = (await credentialRpc.send(
        { type: "bash", command: credentialProbeFor(), excludeFromContext: true },
        60_000,
      )) as { output?: string };
      const vars = parseVars(response.output ?? "");

      // The environment boundary (C11). These fail on the pre-ADR-0010 code, where the spawn
      // inherited process.env and Safehouse's allowlist passed SSH_AUTH_SOCK through anyway.
      check(
        "the host ssh-agent is unreachable by env",
        vars.ENV_SSH === "absent",
        `SSH_AUTH_SOCK=${vars.ENV_SSH} (planted in the parent, so 'present' would be a leak)`,
      );
      check(
        "an ambient host token does not reach the session",
        vars.ENV_TOKEN === "absent",
        `HF_TOKEN_STRICT=${vars.ENV_TOKEN} (planted in the parent, so 'present' would be a leak)`,
      );
      check("the host ssh-agent is unreachable in practice", vars.SSHAGENT === "unreachable", `ssh-add -l: ${vars.SSHAGENT}`);

      // The appended policy fragment (ADR-0010). Each is granted by Safehouse's base policy.
      check("the host gitconfig is denied", vars.HOST_GITCONFIG === "denied", `~/.gitconfig: ${vars.HOST_GITCONFIG}`);
      check("the host gh config is denied", vars.HOST_GH === "denied", `~/.config/gh: ${vars.HOST_GH}`);
      check("Pi's auth store is denied (C6)", vars.HOST_PIAUTH === "denied", `~/.pi/agent/auth.json: ${vars.HOST_PIAUTH}`);

      if (vars.HOST_GITCONFIG === "readable" || vars.HOST_GH === "readable" || vars.HOST_PIAUTH === "readable") {
        info(
          "note",
          "a readable credential path means --append-profile was not applied: check the fragment " +
            "file exists and that the session ran with mode=sandboxed (not direct)",
        );
      }
    } catch (error) {
      check("credential probe ran", false, (error as Error).message);
    }
  } else {
    check("credential probe dispatched", false, "no process handle");
  }

  // Independent confirmation from outside every sandbox: a denied write left no file.  // Independent confirmation from outside every sandbox: a denied write left no file.
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
