/**
 * Phase 0 — prove that two sessions in different working directories hold
 * independent Safehouse policies.
 *
 * This is THE load-bearing claim of Pi Central. Everything else in the design
 * assumes it. If session A can read session B's working directory, the premise
 * is false and the architecture needs rethinking (docs/ROADMAP.md).
 *
 * It exercises the real production path: it composes policy with the same
 * `composePolicy` the dashboard uses, spawns real `safehouse -- pi --mode rpc`
 * processes, and asks each session to read the other's files through the RPC
 * `bash` command — i.e. through the model-facing shell tool, inside the sandbox.
 *
 * MUST BE RUN UNSANDBOXED. Seatbelt does not nest (C1): if this runs inside a
 * sandbox, sandbox-exec fails with EPERM and every check is meaningless.
 *
 * Usage:
 *   node spikes/phase-0/verify.ts            # run the test
 *   node spikes/phase-0/verify.ts --dry-run  # compose + print policy only
 *   node spikes/phase-0/verify.ts --keep     # leave fixtures for inspection
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RpcSession } from "../../prototype/src/rpc.ts";
import { composePolicy, describe, type LaunchMode } from "../../prototype/src/policy.ts";

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has("--dry-run");
const KEEP = argv.has("--keep");

const C = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * Fixtures must NOT live under /tmp or /var/folders: the base profile grants
 * read/write on both, so a cross-workdir read there would succeed for reasons
 * unrelated to the workdir grant, producing a false pass.
 *
 * Override with PHASE0_ROOT when $HOME is not writable.
 */
const ROOT = process.env.PHASE0_ROOT ?? join(homedir(), `.pi-central-phase0-${process.pid}`);
const DIR_A = join(ROOT, "repo-a");
const DIR_B = join(ROOT, "repo-b");
const SECRET_A = "A-SECRET-VALUE";
const SECRET_B = "B-SECRET-VALUE";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  const tag = pass ? C.green("PASS") : C.red("FAIL");
  console.log(`  ${tag}  ${name}${detail ? C.dim(`  — ${detail}`) : ""}`);
}

function makeFixtures(): void {
  rmSync(ROOT, { recursive: true, force: true });
  try {
    mkdirSync(DIR_A, { recursive: true });
    mkdirSync(DIR_B, { recursive: true });
  } catch (err) {
    console.log(
      C.red(`\n  ✗ Cannot create fixtures at ${ROOT}`) +
        `\n    ${C.dim((err as Error).message)}` +
        "\n\n    Run this from a plain terminal where $HOME is writable, or point it\n" +
        "    elsewhere with:\n" +
        C.dim("      PHASE0_ROOT=/path/you/can/write node verify.ts") +
        "\n\n    Do not use /tmp or /var/folders: Safehouse grants both globally, so a\n" +
        "    cross-workdir read there would pass for the wrong reason.\n",
    );
    process.exit(2);
  }
  writeFileSync(join(DIR_A, "own-secret.txt"), `${SECRET_A}\n`);
  writeFileSync(join(DIR_B, "own-secret.txt"), `${SECRET_B}\n`);
}

/**
 * The probe runs *inside* the sandbox, via the model-facing `bash` tool.
 * Reading is judged by `cat` exit status; writing by whether a file appears.
 */
function probeScript(own: string, other: string): string {
  return [
    `if cat ${own}/own-secret.txt >/dev/null 2>&1; then echo OWN_READ=ok; else echo OWN_READ=denied; fi`,
    `if cat ${other}/own-secret.txt >/dev/null 2>&1; then echo OTHER_READ=ok; else echo OTHER_READ=denied; fi`,
    `if touch ${own}/canary-own 2>/dev/null; then echo OWN_WRITE=ok; else echo OWN_WRITE=denied; fi`,
    `if touch ${other}/canary-other 2>/dev/null; then echo OTHER_WRITE=ok; else echo OTHER_WRITE=denied; fi`,
    `if ls ${other} >/dev/null 2>&1; then echo OTHER_LIST=ok; else echo OTHER_LIST=denied; fi`,
  ].join("; ");
}

function parseProbe(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const m = line.trim().match(/^([A-Z_]+)=(ok|denied)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function runProbe(label: string, cwd: string, own: string, other: string, otherDir: string): Promise<void> {
  const spec = {
    id: label,
    name: label,
    cwd,
    mode: "sandboxed" as LaunchMode,
  };
  const policy = composePolicy(spec);
  console.log(C.dim(`\n  $ ${describe(policy)}`));

  const rpc = new RpcSession(label, policy.launch);
  let settled = false;
  rpc.on("exit", () => { settled = true; });
  rpc.start();

  try {
    const result = (await rpc.send(
      { type: "bash", command: probeScript(own, other), excludeFromContext: true },
      60_000,
    )) as { output?: string; exitCode?: number; cancelled?: boolean };

    const output = result.output ?? "";
    const r = parseProbe(output);
    if (Object.keys(r).length === 0) {
      record(
        `${label}: session produced probe output`,
        false,
        `no parsed results — stderr: ${rpc.stderrTail.split("\n").slice(-2).join(" / ")}`,
      );
      return;
    }

    record(`${label}: reads its OWN working directory`, r.OWN_READ === "ok", `OWN_READ=${r.OWN_READ}`);
    record(
      `${label}: reads the OTHER working directory`,
      r.OTHER_READ === "denied",
      `OTHER_READ=${r.OTHER_READ} ${r.OTHER_READ === "ok" ? C.red("(LEAK!)") : ""}`,
    );
    record(`${label}: writes its OWN working directory`, r.OWN_WRITE === "ok", `OWN_WRITE=${r.OWN_WRITE}`);
    record(
      `${label}: writes the OTHER working directory`,
      r.OTHER_WRITE === "denied",
      `OTHER_WRITE=${r.OTHER_WRITE} ${r.OTHER_WRITE === "ok" ? C.red("(LEAK!)") : ""}`,
    );
    record(
      `${label}: lists the OTHER working directory`,
      r.OTHER_LIST === "denied",
      `OTHER_LIST=${r.OTHER_LIST}`,
    );

    // Independent confirmation from outside the sandbox: a denied write must
    // leave no file behind, not merely report failure.
    const escaped = existsSync(join(otherDir, "canary-other"));
    record(
      `${label}: no file appeared in the other workdir`,
      !escaped,
      escaped ? C.red(`found ${join(otherDir, "canary-other")}`) : "verified from outside",
    );
  } catch (err) {
    record(
      `${label}: session stayed usable`,
      false,
      `${(err as Error).message} — stderr: ${rpc.stderrTail.split("\n").slice(-3).join(" / ")}`,
    );
  } finally {
    await rpc.stop();
    void settled;
  }
}

/* ------------------------------------------------------------------ */

console.log(C.bold("\nPi Central — Phase 0 isolation verification\n"));
console.log(C.dim(`fixtures: ${ROOT}`));

if (process.env.PI_CODING_AGENT === "true") {
  console.log(
    C.yellow(
      "\n  ⚠  It looks like this is running from inside Pi, which is normally\n" +
        "     launched under Safehouse. Seatbelt does not nest (C1), so sandboxed\n" +
        "     sessions cannot start from here. Run this from a plain terminal.\n",
    ),
  );
}

makeFixtures();

if (DRY_RUN) {
  console.log(C.bold("\nDry run — composing policy only, nothing is spawned.\n"));
  for (const [label, cwd] of [["A", DIR_A], ["B", DIR_B]] as const) {
    const policy = composePolicy({ id: label, name: label, cwd, mode: "sandboxed" });
    console.log(`  ${C.bold(label)} ${C.dim(cwd)}`);
    console.log(`    isolation: ${policy.isolation}`);
    console.log(`    $ ${describe(policy)}\n`);
  }
  console.log(C.dim("  Fixtures created; run without --dry-run to execute the probes."));
  process.exit(0);
}

// Fail fast and clearly: a dry-run tells you nothing about whether sandbox-exec
// can actually apply a policy, so probe it once up front.
const sandboxProbe = spawnSync(
  "/usr/bin/sandbox-exec",
  ["-p", "(version 1)(allow default)", "--", "/usr/bin/true"],
  { encoding: "utf8" },
);
if (sandboxProbe.status !== 0) {
  console.log(
    C.red("\n  ✗ sandbox-exec cannot apply a policy in this environment.") +
      `\n    ${C.dim((sandboxProbe.stderr || "").trim() || `exit ${sandboxProbe.status}`)}\n` +
      "\n    This usually means the shell is already inside a sandbox (C1).\n" +
      "    Run this script from a plain, unsandboxed terminal.\n",
  );
  if (KEEP) console.log(C.dim(`  fixtures kept at ${ROOT}`));
  else rmSync(ROOT, { recursive: true, force: true });
  process.exit(2);
}

console.log(C.bold("\nSession A") + C.dim(`  workdir ${DIR_A}`));
await runProbe("A", DIR_A, DIR_A, DIR_B, DIR_B);

console.log(C.bold("\nSession B") + C.dim(`  workdir ${DIR_B}`));
await runProbe("B", DIR_B, DIR_B, DIR_A, DIR_A);

const failed = checks.filter((c) => !c.pass);
console.log(C.bold("\n────────────────────────────────────────"));
console.log(`  ${checks.length - failed.length}/${checks.length} checks passed`);

if (failed.length > 0) {
  console.log(C.red(C.bold("\n  ✗ PHASE 0 FAILED — per-session isolation is NOT holding.\n")));
  console.log("  The architecture rests on this. Do not build further until it passes.");
  console.log(C.dim(`  Fixtures kept for inspection: ${ROOT}\n`));
  process.exit(1);
}

console.log(C.green(C.bold("\n  ✓ PHASE 0 PASSED — each session is confined to its own workdir.\n")));
const pwned = [join(DIR_A, "canary-other"), join(DIR_B, "canary-other")].filter(existsSync);
if (pwned.length > 0) console.log(C.red(`  (unexpected leftovers: ${pwned.join(", ")})`));
void readFileSync;

if (KEEP) console.log(C.dim(`  Fixtures kept at ${ROOT}`));
else rmSync(ROOT, { recursive: true, force: true });
