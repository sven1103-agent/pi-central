#!/usr/bin/env node
/**
 * Checkpoint B — one command: a real session, a real dev server, a real sidecar.
 *
 * Four things had to happen at once for this feature to be testable by hand, and that was the design defect:
 * the orchestrator had to be armed with a port, a dev server had to be listening on exactly that port, a NEW
 * session had to be created (existing ones were spawned unarmed), and only then could a prompt do anything.
 * Four steps, two of them invisible, and the failure mode of every one of them was silence.
 *
 * So this drives the Supervisor directly — no Electron, no UI, no clicking, no environment to remember:
 *
 *   node checkpoint-b.mjs                 # uses a fixture dev server on 4173
 *   node checkpoint-b.mjs --port 5173     # or a real project already listening there
 *   node checkpoint-b.mjs --url http://localhost:5173/   # and a different page
 *
 * It prints, in order: whether the sidecar was armed, whether the session saw the tool, and what the tool
 * answered. Any of those failing is stated where it fails rather than at the end.
 *
 * Requires a plain terminal (C1): the session is a sandboxed `safehouse` child, and a nested sandbox cannot
 * apply a policy.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf("--" + name);
  return index === -1 ? fallback : argv[index + 1];
};
const PORT = Number(opt("port", "4173"));
const URL_TO_CAPTURE = opt("url", "http://localhost:" + PORT + "/");

const { defaultConfig } = await import(join(REPO, "packages/orchestrator/src/config.ts"));
const { Supervisor } = await import(join(REPO, "packages/orchestrator/src/supervisor.ts"));

const results = [];
const record = (name, pass, detail) => {
  results.push(pass);
  console.log((pass ? "PASS" : "FAIL") + "  " + name + (detail ? "  -- " + detail : ""));
};

// --- 1. A dev server on the pinned port, unless one is already there. ----------------------------
let fixture;
const listening = await new Promise((done) => {
  const probe = createServer();
  probe.once("error", () => done(true));
  probe.listen(PORT, () => probe.close(() => done(false)));
});
if (listening) {
  console.log(`dev server: already listening on :${PORT}`);
} else {
  // The Phase 0 fixture: a page with deliberate horizontal overflow, so the verdict has something to say.
  const page = readFileSync(join(HERE, "page.html"));
  fixture = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
  });
  await new Promise((done) => fixture.listen(PORT, done));
  console.log(`dev server: started the fixture on :${PORT}`);
}

// --- 2. A supervisor, with a workspace that is private and a state root that is not /tmp. ---------
const root = mkdtempSync(join(homedir(), ".pi-central-checkpoint-b-"));
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // A throwaway under $HOME; a cleanup race must not turn a result into a stack trace.
  }
});

const config = {
  ...defaultConfig(),
  stateRoot: join(root, "state"),
  workspaceRoot: join(root, "workspaces"),
  fragmentDir: join(root, "state", "policy"),
};
const supervisor = new Supervisor(config, { rememberOpenSessions: false });
supervisor.on("error", () => {});
supervisor.on("log", (_id, line) => {
  if (/sidecar/i.test(line)) console.log("  [session log] " + line);
});

// --- 3. Start a session WITH the port. This is the per-session option: one command, no env arming. ----
const started = supervisor.start({ cwd: root, mode: "sandboxed", sidecarPort: PORT });
if (!started.ok) {
  console.error("could not start a session: " + started.message);
  process.exit(1);
}
const id = started.session.id;
console.log("session: " + id + " in " + root);

const configFile = join(config.stateRoot, "sidecars", id, "mcp.json");
record("the session was armed with a sidecar", existsSync(configFile), configFile);
record(
  "the session argv carries --mcp-config",
  started.session.command.includes("--mcp-config"),
  "without it Pi never learns the server exists",
);

// --- 4. Ask the session to use it. ---------------------------------------------------------------
// The prompt is the product question, not a protocol probe: can the agent see its own UI work?
const prompt =
  `Call the tool mcp__pi_central_sidecar__capture with url ${URL_TO_CAPTURE}, then tell me what you see. ` +
  `If that tool does not exist, say exactly "NO SIDECAR TOOL" and list the mcp__ tools you do have.`;
console.log("\nprompting the session (this makes one model call, and may use your provider key)…\n");

let said = "";
try {
  await supervisor.prompt(id, prompt);
  // Wait for the turn to settle rather than for a fixed time: `agent_settled` is the only event that means
  // Pi will not continue on its own (C8). The timeout is a backstop, not the mechanism.
  // Wait for the turn to SETTLE by reading the session state, not by guessing a duration.
  //
  // `agent_settled` is the only event that means Pi will not continue on its own (C8), and the supervisor
  // reflects it in the session state it patches. Reading the authoritative state beats listening for one event
  // name out of many — the first version of this waited on an "event" channel that does not exist.
  said = await new Promise((done) => {
    const deadline = Date.now() + 180_000;
    const tick = () => {
      // `get`, not `session`: the accessor is `Supervisor#get`. An earlier draft of this file used a name that
      // does not exist, and the resulting TypeError was reported as "the prompt was accepted: FAIL" — so the one
      // line that would have named the mistake was the failing assertion, not a hint.
      const session = supervisor.get(id);
      if (session !== undefined && session.state === "idle" && (session.messageCount ?? 0) > 0) {
        done("(the session settled; see its transcript in the UI, or the record count below)");
        return;
      }
      if (Date.now() > deadline) {
        done("(timed out waiting for the session to settle)");
        return;
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
} catch (error) {
  record("the prompt was accepted", false, String(error));
}

// The transcript is the evidence, so fetch it rather than paraphrasing. `fetchTranscript` is the same call the
// UI's file viewer makes, so what is printed here is what a reader would see.
const transcript = await supervisor.fetchTranscript(id).catch(() => undefined);
const reply = (transcript?.messages ?? [])
  .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  .filter((block) => block?.type === "text")
  .map((block) => String(block.text ?? ""))
  .join("\n")
  .trim();

record("the session produced a reply", reply !== "", said);
if (reply !== "") {
  console.log("\n--- the session's reply ---");
  console.log(reply.slice(0, 1500));
  record("the reply does not report a missing sidecar tool", !/NO SIDECAR TOOL/i.test(reply));
  record("the reply describes what was captured", /captur|screenshot|png|image/i.test(reply));
}

await supervisor.stopAll();
fixture?.close();

const failed = results.filter((pass) => !pass).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " expectations held");
if (failed !== 0) {
  console.log("\nA failure above is one of four things, in this order of likelihood:");
  console.log("  1. the sidecar spawn failed -- look for a [session log] line naming the reason");
  console.log("  2. Pi did not read the config -- check --mcp-config in the printed argv");
  console.log("  3. the browser could not start under the policy -- the session log carries its stderr");
  console.log("  4. the model ignored the instruction -- the transcript above shows what it did instead");
}
process.exit(failed === 0 ? 0 : 1);
