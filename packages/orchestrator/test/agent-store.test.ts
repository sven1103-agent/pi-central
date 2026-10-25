import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDrift, isSecretBearing, planImport, readStore } from "../src/agent-store.ts";

/**
 * The agent credential store (ADR-0010 §5): inspection, ownership, drift.
 *
 * The security property under test is that **inspection never reads a secret**. That is
 * asserted by planting a recognisable secret and proving it appears nowhere in the snapshot —
 * a passing "it works" test would not catch a regression that starts reading tokens.
 */

const dir = mkdtempSync(join(tmpdir(), "pi-central-store-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const SECRET_TOKEN = "ghp_PLANTED_SECRET_VALUE_0123456789";
const SECRET_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nPLANTED\n-----END OPENSSH PRIVATE KEY-----";

/** Build a store shaped like the hardening project's ~/.agent tree. */
function makeStore(name: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, "gh"), { recursive: true });
  mkdirSync(join(root, "ssh"), { recursive: true });
  writeFileSync(join(root, "gh", "hosts.yml"), `github.com:\n  oauth_token: ${SECRET_TOKEN}\n`, { mode: 0o600 });
  writeFileSync(join(root, "ssh", "id_ed25519"), SECRET_KEY, { mode: 0o600 });
  writeFileSync(join(root, "ssh", "known_hosts"), "github.com ssh-ed25519 AAAA\n");
  writeFileSync(join(root, "ssh", "allowed_signers"), "agent@example.com ssh-ed25519 AAAA\n");
  writeFileSync(
    join(root, "gitconfig"),
    ["[user]", "\tname = sven1103-agent", "\temail = 1234+sven1103-agent@users.noreply.github.com", ""].join("\n"),
    { mode: 0o600 },
  );
  return root;
}

test("inspection reads metadata only — no secret value appears in the snapshot", () => {
  const root = makeStore("store-a");
  const snapshot = readStore(root);

  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes(SECRET_TOKEN), "the gh token must never be read");
  assert.ok(!serialized.includes("PLANTED"), "the private key must never be read");
  assert.ok(!serialized.includes("BEGIN OPENSSH"), "the private key must never be read");
});

test("the snapshot still reports what is present, so it is useful without the values", () => {
  const snapshot = readStore(makeStore("store-b"));
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.has.gitconfig, true);
  assert.equal(snapshot.has.ghConfig, true);
  assert.equal(snapshot.has.sshKey, true);
  assert.equal(snapshot.has.knownHosts, true);
  assert.equal(snapshot.has.sshSigningKey, true);
  assert.equal(snapshot.has.keychain, false);
});

test("the agent's non-secret identity is read from gitconfig", () => {
  const snapshot = readStore(makeStore("store-c"));
  assert.equal(snapshot.identity.name, "sven1103-agent");
  assert.equal(snapshot.identity.email, "1234+sven1103-agent@users.noreply.github.com");
});

test("a credential helper in gitconfig is not read as identity", () => {
  // A helper line can embed a token, which is exactly what this module must not surface.
  const root = join(dir, "store-helper");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "gitconfig"),
    ["[user]", "\tname = agent", "[credential]", `\thelper = !echo ${SECRET_TOKEN}`, ""].join("\n"),
  );
  const snapshot = readStore(root);
  assert.equal(snapshot.identity.name, "agent");
  assert.ok(!JSON.stringify(snapshot).includes(SECRET_TOKEN));
});

test("file modes are captured, so a world-readable secret is visible as drift-worthy", () => {
  const root = makeStore("store-modes");
  chmodSync(join(root, "gh", "hosts.yml"), 0o644);
  const snapshot = readStore(root);
  const hosts = snapshot.files.find((f) => f.relPath === "gh/hosts.yml");
  assert.ok(hosts);
  assert.equal(hosts.mode, 0o644);
});

test("a missing root is reported, not thrown", () => {
  const snapshot = readStore(join(dir, "nope"));
  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.files.length, 0);
  assert.equal(snapshot.has.gitconfig, false);
});

test("the fingerprint is stable for identical state and changes when state changes", () => {
  const root = makeStore("store-fp");
  const before = readStore(root).fingerprint;
  assert.equal(before, readStore(root).fingerprint, "identical state hashes identically");

  // A token rotation changes the file length, so drift is detected without reading it.
  writeFileSync(join(root, "gh", "hosts.yml"), `github.com:\n  oauth_token: ${SECRET_TOKEN}EXTRA\n`, {
    mode: 0o600,
  });
  assert.notEqual(readStore(root).fingerprint, before, "a size change must move the fingerprint");
});

test("a mode change alone moves the fingerprint (a loosened secret is drift)", () => {
  const root = makeStore("store-fp-mode");
  const before = readStore(root).fingerprint;
  chmodSync(join(root, "gh", "hosts.yml"), 0o644);
  assert.notEqual(readStore(root).fingerprint, before);
});

test("drift is reported with a reason, and without exposing values", () => {
  const root = makeStore("store-drift");
  const imported = readStore(root);

  writeFileSync(join(root, "gh", "hosts.yml"), "x".repeat(200), { mode: 0o600 });
  writeFileSync(join(root, "ssh", "new_key"), "new");
  const current = readStore(root);

  const drift = detectDrift(imported, current);
  assert.equal(drift.drifted, true);
  assert.ok(drift.entries.some((e) => e.relPath === "gh/hosts.yml" && e.kind === "changed"));
  assert.ok(drift.entries.some((e) => e.relPath === "ssh/new_key" && e.kind === "added"));
  assert.ok(!JSON.stringify(drift).includes(SECRET_TOKEN));
});

test("a removed file is reported as removed", () => {
  const root = makeStore("store-removed");
  const imported = readStore(root);
  rmSync(join(root, "ssh", "known_hosts"));
  const drift = detectDrift(imported, readStore(root));
  assert.ok(drift.entries.some((e) => e.relPath === "ssh/known_hosts" && e.kind === "removed"));
});

test("an unchanged store reports no drift", () => {
  const root = makeStore("store-same");
  const drift = detectDrift(readStore(root), readStore(root));
  assert.equal(drift.drifted, false);
  assert.deepEqual(drift.entries, []);
});

test("a changed identity is drift even when no file changed size", () => {
  const root = makeStore("store-ident");
  const imported = readStore(root);
  writeFileSync(join(root, "gitconfig"), "[user]\n\tname = someone-else\n\temail = 1234+sven1103-agent@users.noreply.github.com\n");
  const drift = detectDrift(imported, readStore(root));
  assert.ok(drift.entries.some((e) => e.relPath === "gitconfig" && e.detail.includes("someone-else")));
});

test("import plans report what is missing and say the external tree is never written", () => {
  const root = makeStore("store-plan");
  const plan = planImport({ root, ownership: "external" });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.missing, []);
  assert.ok(plan.notes.some((n) => /never writes/.test(n)));
});

test("a store without gh config is reported as incomplete", () => {
  const root = join(dir, "store-partial");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "gitconfig"), "[user]\n\tname = agent\n");
  const plan = planImport({ root, ownership: "managed" });
  assert.equal(plan.ok, false);
  assert.ok(plan.missing.some((m) => m.startsWith("gh/")));
  assert.ok(plan.notes.some((n) => /no SSH key/.test(n)));
});

test("a missing root is a missing requirement, not a crash", () => {
  const plan = planImport({ root: join(dir, "absent"), ownership: "managed" });
  assert.equal(plan.ok, false);
  assert.ok(plan.missing.some((m) => m.includes("does not exist")));
});

test("secret-bearing paths are named, so inspection code can refuse to open them", () => {
  assert.equal(isSecretBearing("gh/hosts.yml"), true);
  assert.equal(isSecretBearing("ssh/id_ed25519"), true);
  assert.equal(isSecretBearing("agent.keychain-db"), true);
  assert.equal(isSecretBearing("gitconfig"), false);
});

test("the module never imports a write operation it should not use", () => {
  // `external` ownership is a promise that Pi Central does not write. This test fails the
  // moment someone adds a write to inspection code, which is the point.
  const source = readFileSync(new URL("../src/agent-store.ts", import.meta.url), "utf8");
  for (const forbidden of ["writeFileSync", "mkdirSync", "chmodSync", "rmSync", "appendFileSync", "unlinkSync"]) {
    assert.ok(
      !source.includes(forbidden),
      `${forbidden} has no place in the store module: inspection must not mutate a tree it may not own`,
    );
  }
});

test("stats are readable for a secret file, confirming presence is known without content", () => {
  const root = makeStore("store-stat");
  const stats = statSync(join(root, "ssh", "id_ed25519"));
  assert.ok(stats.size > 0);
  assert.equal(readStore(root).has.sshKey, true);
});
