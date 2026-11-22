#!/usr/bin/env node
/**
 * Phase 0D — does `pi --mcp-config <path>` point Pi at THAT file? **YES.**
 *
 * ## Why this took three attempts, which is the useful part
 *
 * 1. `pi mcp list --mcp-config X` → *"Unknown option"*. The flag is a SESSION option, and a subcommand
 *    rejects it. Nearly concluded the flag did not exist.
 * 2. A session in print mode that lists its own `mcp__` tools → **asked for the login keychain.** A model
 *    call resolves the provider key, so a question about a config file demanded a credential.
 * 3. A session with a throwaway agent dir and no `auth.json` → *"No models available"*, exit 1, before MCP
 *    loading ever happened. INCONCLUSIVE, which the probe correctly refused to read as a verdict.
 *
 * ## What actually answers it, with no model and no credential
 *
 * `pi mcp list` connects servers and exits. It needs no model. The flag goes **before** the subcommand:
 *
 *     pi --mcp-config /path/to/mcp.json mcp list
 *
 * The observable is a side effect outside the protocol: the marker server appends a line to $MARKER_LOG
 * when spawned. Its existence is the answer, and nothing in this file asks a model anything.
 *
 * ## Measured
 *
 *     control (no flag)      exit 0, marker ABSENT
 *     with the flag          exit 0, marker PRESENT
 *     ~/.pi/agent/mcp.json   untouched (it does not exist on this machine, and still does not)
 *
 * So shape C can point Pi at a config the agent cannot rewrite. ADR-0015 §2 stands, and the C6 defect
 * that would have followed from a `~/.pi`-only config does not apply.
 *
 * The script is kept because the three failures above are all re-runnable: a Pi upgrade could move the flag
 * back to subcommand-only, and the third attempt's silence is exactly what a future reader would misread.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pi-mcp-config-probe-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const logPath = join(dir, "started.log");
const configPath = join(dir, "mcp.json");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      mcpServers: {
        probemarker: {
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

/**
 * `pi mcp list` connects every enabled server, so no model is involved. The flag precedes the subcommand:
 * putting it after is what produced "Unknown option" and nearly a wrong conclusion.
 */
const list = (args) =>
  new Promise((done) => {
    const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], cwd: dir });
    let out = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (out += String(c)));
    child.once("error", (error) => done({ out: out + String(error) }));
    child.once("exit", (code) => done({ out, code }));
    // Bounded. A stdio server that never answers would otherwise hang the probe, which happened once.
    setTimeout(() => child.kill("SIGTERM"), 30_000);
  });

console.log("config: " + configPath + "\n");

console.log("control, without the flag…");
const without = await list(["mcp", "list"]);
const sawWithout = existsSync(logPath);
console.log("  marker started: " + sawWithout + "  (exit " + without.code + ")");
if (sawWithout) rmSync(logPath, { force: true });

console.log("with the flag BEFORE the subcommand…");
const withFlag = await list(["--mcp-config", configPath, "mcp", "list"]);
const sawWith = existsSync(logPath);
console.log("  marker started: " + sawWith + "  (exit " + withFlag.code + ")");

const results = [
  ["without the flag, Pi does not start the server", !sawWithout],
  ["with --mcp-config, Pi starts a server from a config outside ~/.pi", sawWith],
];
for (const [label, pass] of results) console.log((pass ? "PASS" : "FAIL") + "  " + label);
const failed = results.filter(([, pass]) => !pass).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " held");
if (failed === 0) {
  console.log("\nThe flag works. ADR-0015 §2 stands: the config lives outside agent-writable space.");
} else if (!sawWith && !sawWithout) {
  console.log("\nINCONCLUSIVE: neither run started the server, so Pi died before MCP loading.");
  console.log("That is a limit of the probe, not a verdict on the flag. Report it as such.");
  console.log("Measured cause on this machine: a throwaway agent dir has no auth.json, and Pi exits 1");
  console.log("with \"No models available\" before it reaches MCP configuration.");
  process.exit(2);
} else {
  console.log("\nThe flag did not behave as assumed. Do not build on it.");
}
process.exit(failed === 0 ? 0 : 1);
