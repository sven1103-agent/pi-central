#!/usr/bin/env node
/**
 * Phase 0D — does `pi --mcp-config <path>` point a session at THAT file?
 *
 * ## Why the observable is a startup log and not a model answer
 *
 * The first version asked a session to list its own `mcp__` tools. That requires a model call, which
 * resolves the provider key, which is a KEYCHAIN LOOKUP — so a question about a config flag prompted for
 * the user's login keychain. Unacceptable: a probe must not need a credential to answer a question that
 * has nothing to do with one, and C13a records that an unanswered keychain prompt is process-wide and can
 * wedge later lookups.
 *
 * So nothing here asks a model anything. The marker server appends a line to a log file the moment it is
 * spawned, and that log is the evidence: if Pi started the server, Pi read the config. A session is still
 * started (that is what loads MCP servers) but it is given a throwaway agent dir with a dummy key, so the
 * provider lookup fails locally instead of reaching the keychain.
 *
 * ## What a failure would not prove
 *
 * If no log appears, the flag might be ignored OR the servers might start after the point this session
 * dies. The control run (no flag) separates the first from the second only partly, and that limit is
 * stated rather than papered over.
 *
 * Run from a plain terminal. Exit: 0 the flag works, 1 it does not, 2 could not run.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_NAME = "probemarker";

const dir = mkdtempSync(join(tmpdir(), "pi-mcp-config-probe-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** A throwaway agent dir: no keychain indirection, so no prompt. */
const agentDir = join(dir, "agent");
mkdirSync(agentDir, { recursive: true });

/**
 * The log the marker server appends to. Existence is the whole answer, so the path is passed through the
 * server entry's own environment rather than being baked into the fixture.
 */
const logPath = join(dir, "started.log");

const configPath = join(dir, "mcp.json");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          command: process.execPath,
          args: [join(HERE, "marker-mcp-server.mjs")],
          env: { MARKER_LOG: logPath },
        },
      },
    },
    null,
    2,
  ),
);

const userConfig = join(homedir(), ".pi", "agent", "mcp.json");
const digest = () =>
  existsSync(userConfig) ? createHash("sha256").update(readFileSync(userConfig)).digest("hex") : "(absent)";
const before = digest();

/**
 * Start a session and let it die on the provider lookup.
 *
 * `PI_CODING_AGENT_DIR` points at the throwaway dir so `auth.json` (and therefore the `!security`
 * indirection) is absent, and `PI_OFFLINE` keeps it from trying a network auth path. The session will exit
 * non-zero; that is expected and irrelevant — the question is whether the marker server was ever spawned.
 */
const session = (extra) =>
  new Promise((done) => {
    const child = spawn(
      "pi",
      ["--print", "hi", "-ne", "-e", "builtin:mcp", "--no-tools", ...extra],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: dir,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
      },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (out += String(c)));
    child.once("error", (error) => done({ out: out + String(error) }));
    child.once("exit", () => done({ out }));
    // Bounded: this must not hang waiting on something that will not answer.
    setTimeout(() => child.kill("SIGTERM"), 45_000);
  });

const started = () => existsSync(logPath);

console.log("config:  " + configPath);
console.log("agent:   " + agentDir + "  (throwaway, so no keychain lookup)");
console.log("user:    " + userConfig + " (" + (before === "(absent)" ? "absent" : "present") + ")\n");

console.log("session WITHOUT the flag (the control)…");
await session([]);
const sawWithout = started();
console.log("  marker server started: " + sawWithout);
if (sawWithout) rmSync(logPath, { force: true });

console.log("session WITH --mcp-config…");
await session(["--mcp-config", configPath]);
const sawWith = started();
console.log("  marker server started: " + sawWith);

const after = digest();
console.log("~/.pi/agent/mcp.json unchanged: " + (before === after) + "\n");

const results = [
  ["without the flag, Pi does not start the server", !sawWithout],
  ["with --mcp-config, Pi starts the server from a config outside ~/.pi", sawWith],
  ["the user config was not touched", before === after],
];
for (const [label, pass] of results) console.log((pass ? "PASS" : "FAIL") + "  " + label);
const failed = results.filter(([, pass]) => !pass).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " held\n");
if (failed === 0) {
  console.log("The flag works. ADR-0015 §2 stands: the config lives outside agent-writable space.");
} else if (!sawWith && !sawWithout) {
  console.log("INCONCLUSIVE: neither run started the server, so this session died before MCP loading.");
  console.log("That is a limit of the probe, not a verdict on the flag. Report it rather than concluding.");
  process.exit(2);
} else {
  console.log("The flag did NOT behave as assumed. Do not build on it: the fallback is a config in");
  console.log("agent-writable ~/.pi (C6), which changes the security story and needs a decision.");
}
process.exit(failed === 0 ? 0 : 1);
