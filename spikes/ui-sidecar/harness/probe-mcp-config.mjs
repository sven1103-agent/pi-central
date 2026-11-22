#!/usr/bin/env node
/**
 * Phase 0D — does `pi --mcp-config <path>` actually point a session at THAT file?
 *
 * Why this is worth a script: `--mcp-config` appears in `pi --help` and in NONE of Pi's documentation, so
 * its precedence over `~/.pi/agent/mcp.json` is an assumption. Shape C (ADR-0015) depends on it: if the
 * config must live in `~/.pi/agent/mcp.json`, the isolation rests on a file every session can WRITE (C6) —
 * the exact defect this design exists to avoid.
 *
 * The first version of this probe asked `pi mcp list --mcp-config …` and got "Unknown option". That is a
 * subcommand, and the flag belongs to a SESSION: `pi --mcp-config X`. So the probe now starts a real
 * session in print mode and asks it to list its own MCP tools. The correction matters — a probe that
 * reports a flag broken because it was passed to the wrong command is how a design gets abandoned for a
 * reason that does not exist.
 *
 * Run from a plain terminal (C1: a session cannot spawn a nested Pi with its own policy).
 *
 * Exit: 0 the flag works, 1 it does not.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_NAME = "probe_marker_tool";
const SERVER_NAME = "probemarker";

const dir = mkdtempSync(join(tmpdir(), "pi-mcp-config-probe-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const configPath = join(dir, "mcp.json");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: { command: process.execPath, args: [join(HERE, "marker-mcp-server.mjs")] },
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
 * Start a real session in print mode and ask it to enumerate its own tools.
 *
 * `--no-tools` keeps built-ins out of the picture, and `-e builtin:mcp` loads only the MCP support, so the
 * answer is about the config file rather than about whatever extensions this machine has installed.
 */
const session = (extra) =>
  new Promise((done) => {
    const args = [
      "--print",
      "List every tool you have whose name starts with mcp__ . Reply with the names only, or NONE.",
      "--no-tools",
      "-e",
      "builtin:mcp",
      "-ne",
      ...extra,
    ];
    const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], cwd: dir });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (err += String(c)));
    child.once("error", (error) => done({ out, err: String(error) }));
    child.once("exit", () => done({ out, err }));
    setTimeout(() => child.kill("SIGTERM"), 120_000);
  });

const shows = (text) => text.includes(SERVER_NAME) || text.includes(TOOL_NAME);

console.log("config: " + configPath);
console.log("user:   " + userConfig + " (" + (before === "(absent)" ? "absent" : "present") + ")\n");

console.log("starting a session WITH --mcp-config (this makes one model call)…");
const withFlag = await session(["--mcp-config", configPath]);
const sawWithFlag = shows(withFlag.out);
console.log("  mentions the server: " + sawWithFlag);
if (!sawWithFlag) {
  console.log("  --- reply ---");
  for (const line of (withFlag.out + withFlag.err).trim().split("\n").slice(0, 10)) console.log("  " + line);
}

console.log("starting a session WITHOUT it (the control)…");
const without = await session([]);
const sawWithout = shows(without.out);
console.log("  mentions the server: " + sawWithout);

const after = digest();
console.log("\n~/.pi/agent/mcp.json unchanged: " + (before === after));

const results = [
  ["a session with the flag sees a config outside ~/.pi", sawWithFlag],
  ["a session without it does not, so the flag is what did it", !sawWithout],
  ["the user config was not touched", before === after],
];
console.log("");
for (const [label, pass] of results) console.log((pass ? "PASS" : "FAIL") + "  " + label);
const failed = results.filter(([, pass]) => !pass).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " held\n");
if (failed === 0) {
  console.log("Shape C can point Pi at a config the agent cannot rewrite. ADR-0015 §2 stands.");
} else {
  console.log("The flag did NOT behave as assumed. Do not build on it.");
  console.log("The fallback is a config in agent-writable ~/.pi (C6), which changes the security");
  console.log("story and needs a decision before Phase 2 continues.");
}
process.exit(failed === 0 ? 0 : 1);
