import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The loopback endpoint, which is the only thing between a session and a browser it does not own.
 *
 * Measured constraint this file exists for: loopback is NOT a boundary (C5). Every session on the machine can
 * connect to every other session's sidecar port, so the bearer token is the access control -- not hygiene, not
 * defence in depth. Without these tests, "the token protects it" is a comment.
 *
 * Two properties, and both are needed:
 *
 *   1. A request without the token, or with the wrong one, is refused -- including `initialize`, because a
 *      handshake that succeeds before the check teaches a client that the endpoint is open.
 *   2. One session's token does not open ANOTHER session's sidecar. Tokens differ per session, so this is the
 *      claim that the sidecar checks the token it was launched with.
 *
 * Every request below is refused before a verb runs, so no browser is ever launched. That is what makes this
 * file runnable in CI, where there is no `sandbox-exec` (C10).
 */

const ENTRY = join(import.meta.dirname, "..", "src", "sidecar.ts");
const ROOT = process.env["PI_CENTRAL_TEST_PRIVATE_ROOT"];
const skip = ROOT === undefined ? "# skip: set PI_CENTRAL_TEST_PRIVATE_ROOT to start a real sidecar" : undefined;

interface Running {
  port: number;
  stop: () => Promise<void>;
}

async function startSidecar(token: string, ambientToken?: string): Promise<Running> {
  const dir = mkdtempSync(join(ROOT as string, "sidecar-server-"));
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: dir,
    ...(ambientToken === undefined ? {} : { PI_CENTRAL_SIDECAR_TOKEN: ambientToken }),
  };
  // spawn with a fixed binary and a fixed argv: the repo's invariant, and the same shape the orchestrator uses.
  const child = spawn(
    process.execPath,
    [
      ENTRY,
      "--executable", join(dir, "no-such-chrome"),
      "--profile", dir,
      "--origin", "http://localhost:49100",
      "--token", token,
      "--port", "0",
    ],
    { stdio: ["pipe", "ignore", "pipe"], env },
  );
  const port = await new Promise<number>((done, fail) => {
    let seen = "";
    const timer = setTimeout(() => fail(new Error("the sidecar never announced a port: " + seen)), 20_000);
    child.stderr.on("data", (chunk) => {
      seen += String(chunk);
      const match = /sidecar listening on 127\.0\.0\.1:(\d+)/.exec(seen);
      if (match) { clearTimeout(timer); done(Number(match[1])); }
    });
    child.once("exit", (code) => { clearTimeout(timer); fail(new Error("the sidecar exited with " + String(code) + ": " + seen)); });
  });
  const stop = async (): Promise<void> => {
    // stdin is the lifetime mechanism (ADR-0018 §11): closing it is how the orchestrator says "you are alone now".
    child.stdin.end();
    await new Promise<void>((done) => {
      if (child.exitCode !== null) return done();
      child.once("exit", () => done());
      setTimeout(() => { child.kill("SIGKILL"); done(); }, 3000);
    });
    rmSync(dir, { recursive: true, force: true });
  };
  return { port, stop };
}

async function call(port: number, authorization: string | undefined, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch("http://127.0.0.1:" + port + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };

test("a sidecar refuses every request that does not present its own token", async () => {
  if (skip) return console.log(skip);
  const a = await startSidecar("token-of-session-a");
  const b = await startSidecar("token-of-session-b");
  try {
    // No header at all: what a session that simply guesses a port presents.
    assert.equal((await call(a.port, undefined, INITIALIZE)).status, 401, "a missing token must be refused");
    assert.equal((await call(a.port, undefined, TOOLS_LIST)).status, 401, "and not only for initialize");
    assert.equal((await call(a.port, "Bearer wrong", INITIALIZE)).status, 401, "a wrong token must be refused");
    assert.equal((await call(a.port, "Bearer " + "x".repeat(48), TOOLS_LIST)).status, 401);
    // SESSION B AGAINST SESSION A. A sidecar that accepted any token it could see, or one from the environment
    // rather than its argv, is exactly what this passes for and should not.
    assert.equal(
      (await call(a.port, "Bearer token-of-session-b", TOOLS_LIST)).status,
      401,
      "one session's token must not open another session's sidecar",
    );
    assert.equal((await call(a.port, "Bearer token-of-session-a" + "x", TOOLS_LIST)).status, 401, "a prefix must not pass");

    // The positive control. Without it every assertion above would also hold for a server that refuses
    // everything, including its own session.
    const ok = await call(a.port, "Bearer token-of-session-a", TOOLS_LIST);
    assert.equal(ok.status, 200, "the owning session must be able to list tools; got " + ok.text.slice(0, 200));
    assert.match(ok.text, /capture/, "and the reply must be the tool list");
    assert.equal((await call(b.port, "Bearer token-of-session-b", INITIALIZE)).status, 200, "each sidecar accepts its own");
  } finally {
    await Promise.all([a.stop(), b.stop()]);
  }
});

test("the endpoint accepts only /mcp, and only POST", async () => {
  if (skip) return console.log(skip);
  const a = await startSidecar("token-of-session-a");
  try {
    const wrongPath = await fetch("http://127.0.0.1:" + a.port + "/anything", { method: "POST", body: "{}" });
    assert.equal(wrongPath.status, 404, "a path that is not /mcp must not exist");
    const get = await fetch("http://127.0.0.1:" + a.port + "/mcp", { headers: { authorization: "Bearer token-of-session-a" } });
    assert.equal(get.status, 405, "a GET must be refused rather than answered");
  } finally {
    await a.stop();
  }
});

test("the token the sidecar accepts is the one it was launched with, not an ambient variable", async () => {
  if (skip) return console.log(skip);
  // Guards the delivery path. The orchestrator puts the token in the environment AND forwards it with --env-pass,
  // and the sidecar falls back to the environment when no flag is given. If the flag were ever dropped, an ambient
  // variable of the same name must not silently become the accepted token -- so this starts a sidecar with a
  // conflicting value in the environment and asserts the FLAG wins.
  const a = await startSidecar("flag-token", "ambient-token");
  try {
    assert.equal((await call(a.port, "Bearer ambient-token", TOOLS_LIST)).status, 401, "an ambient variable must not be accepted");
    assert.equal((await call(a.port, "Bearer flag-token", TOOLS_LIST)).status, 200, "the launched token must be the one accepted");
  } finally {
    await a.stop();
  }
});
