import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PATH,
  PASSTHROUGH,
  agentRootFor,
  agentRoutingEnv,
  buildSessionEnv,
  leaksSshAgent,
} from "../src/env.ts";

/**
 * The environment boundary (C11, C4a). These tests are about what a session can *see*, which
 * no SBPL rule can constrain — so this module is the only control for it.
 *
 * Every test passes an explicit `source`, never the ambient `process.env`, so the suite does
 * not depend on the developer's shell (and so a planted secret is provable).
 */

test("a planted secret in the source never reaches the session", () => {
  const env = buildSessionEnv({
    source: { PATH: "/usr/bin", DEMO_SECRET: "leaked-value-123", HF_TOKEN: "hf_x" },
  });
  assert.equal(env["DEMO_SECRET"], undefined);
  assert.equal(env["HF_TOKEN"], undefined);
  assert.equal(env["PATH"], "/usr/bin");
});

test("SSH_AUTH_SOCK is dropped, which is the whole point (F4)", () => {
  // Safehouse's own sanitized allowlist passes this through, so the spawn env is the only
  // place it can be removed (C4a).
  const env = buildSessionEnv({
    source: { PATH: "/usr/bin", SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.x/Listeners" },
  });
  assert.equal(env["SSH_AUTH_SOCK"], undefined);
  assert.equal(leaksSshAgent(env), false);
});

test("SSH_AGENT_PID is dropped too: either one re-opens the agent", () => {
  const env = buildSessionEnv({ source: { SSH_AGENT_PID: "1234" } });
  assert.equal(leaksSshAgent(env), false);
});

test("the allowlist is what is forwarded, and nothing else", () => {
  const source: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH) source[name] = `value-of-${name}`;
  source["SOMETHING_ELSE"] = "nope";

  const env = buildSessionEnv({ source });
  for (const name of PASSTHROUGH) assert.equal(env[name], `value-of-${name}`);
  assert.equal(env["SOMETHING_ELSE"], undefined);
});

test("an absent allowlisted variable is omitted, not set to the string 'undefined'", () => {
  const env = buildSessionEnv({ source: {} });
  assert.equal("TERM" in env, false);
  assert.equal(env["TERM"], undefined);
});

test("PATH falls back rather than being empty, so a session stays usable", () => {
  assert.equal(buildSessionEnv({ source: {} })["PATH"], DEFAULT_PATH);
  assert.equal(buildSessionEnv({ source: {}, fallbackPath: "/custom" })["PATH"], "/custom");
});

test("injected values are the trusted channel and do arrive", () => {
  const env = buildSessionEnv({
    source: {},
    set: { GH_TOKEN: "agent-own-token", ANTHROPIC_API_KEY: "agent-key" },
  });
  assert.equal(env["GH_TOKEN"], "agent-own-token");
  assert.equal(env["ANTHROPIC_API_KEY"], "agent-key");
});

test("injecting the host ssh-agent is refused outright, not silently dropped", () => {
  // Silently dropping would surface later as a confusing auth failure; refusing is the point.
  assert.throws(
    () => buildSessionEnv({ set: { SSH_AUTH_SOCK: "/tmp/evil.sock" } }),
    /ssh-agent/,
  );
  assert.throws(() => buildSessionEnv({ set: { ssh_auth_sock: "/tmp/evil.sock" } }), /ssh-agent/);
});

test("a malformed injected name is refused", () => {
  assert.throws(() => buildSessionEnv({ set: { "BAD NAME": "x" } }), /malformed env var name/);
  assert.throws(() => buildSessionEnv({ set: { "A=B": "x" } }), /malformed env var name/);
});

test("a session can be given its OWN token under GH_TOKEN (provenance, not name)", () => {
  // The rule is provenance, not name: blocking *_TOKEN shapes would forbid the very thing
  // the injection channel exists to do (ADR-0010 §3).
  const env = buildSessionEnv({ set: { GH_TOKEN: "agent", GITHUB_TOKEN: "agent2" } });
  assert.equal(env["GH_TOKEN"], "agent");
  assert.equal(env["GITHUB_TOKEN"], "agent2");
});

test("agent routing points at the agent's own tree and never the host's", () => {
  const routing = agentRoutingEnv("/state/agents/default");
  assert.equal(routing["GH_CONFIG_DIR"], "/state/agents/default/gh");
  assert.equal(routing["GIT_CONFIG_GLOBAL"], "/state/agents/default/gitconfig");
  // Removes the host's system git config as an independent route to the login keychain (F12).
  assert.equal(routing["GIT_CONFIG_SYSTEM"], "/dev/null");
  // HOME is deliberately untouched: Pi needs the real home for ~/.pi (C6).
  assert.equal(routing["HOME"], undefined);
});

test("a relative agent root is refused: it would resolve unpredictably", () => {
  assert.throws(() => agentRoutingEnv("agents/default"), /absolute path/);
});

test("agent ids become paths only when they are path-safe", () => {
  assert.equal(agentRootFor("/s", "default"), "/s/agents/default");
  assert.throws(() => agentRootFor("/s", "../../etc"), /unsafe id/);
  assert.throws(() => agentRootFor("/s", "a/b"), /unsafe id/);
});
