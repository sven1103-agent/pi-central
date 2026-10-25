/**
 * Tests for the agent-capability check (issue #28).
 *
 * The whole point of this module is that "the capability is missing" has two causes with opposite
 * fixes — *not provisioned* (a setup step) and *provisioned but unreachable* (a bug in Pi Central) —
 * and that conflating them is what made the original `gh` failure mislead. So the tests are
 * organised around that distinction rather than around the function's branches.
 *
 * The fixture is a real directory tree with real permissions, not a mocked snapshot: the check reads
 * the filesystem, and a mock would prove only that the mock was constructed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProviderAuth, readStore, KEYCHAIN_FILE } from "../src/agent-store.ts";
import { assessAgentCapabilities, agentKeychainPath } from "../src/capabilities.ts";
import { renderPolicyFragment } from "../src/fragment.ts";

const base = mkdtempSync(join(tmpdir(), "pi-central-capabilities-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

let counter = 0;

interface Fixture {
  /** The agent root. */
  root: string;
  /** What the fragment grants. `undefined` means no fragment at all (as direct mode has none). */
  agentRootGranted: string | undefined;
}

/**
 * Build an agent tree.
 *
 * `with` names the pieces to create. Anything omitted is genuinely absent, so the
 * "not provisioned" path is exercised by leaving it out rather than by a flag.
 */
function makeTree(withParts: { gitconfig?: boolean; gh?: boolean; ssh?: boolean; keychain?: boolean } = {}): string {
  const root = join(base, `t${++counter}`);
  mkdirSync(root, { recursive: true });
  if (withParts.gitconfig) {
    writeFileSync(join(root, "gitconfig"), "[user]\n\tname = sven1103-agent\n\temail = a@b.c\n");
  }
  if (withParts.gh) mkdirSync(join(root, "gh"), { recursive: true });
  if (withParts.ssh) {
    mkdirSync(join(root, "ssh"), { recursive: true });
    writeFileSync(join(root, "ssh", "github_login_ed25519"), "KEY\n");
  }
  if (withParts.keychain) writeFileSync(join(root, KEYCHAIN_FILE), "not-a-real-keychain\n");
  return root;
}

function assess(fixture: Fixture, overrides: Partial<Parameters<typeof assessAgentCapabilities>[0]> = {}) {
  const store = readStore(fixture.root, { ownership: "external" });
  const fragment =
    fixture.agentRootGranted === undefined
      ? undefined
      : renderPolicyFragment({ agentRoot: fixture.agentRootGranted });
  return assessAgentCapabilities({
    store,
    sandboxed: true,
    // An inline key by default, so the keychain branch does not fire unless a test opts in.
    providerAuth: { path: "/nonexistent/auth.json", readable: false, providers: [], commandProviders: [], needsKeychain: false },
    keychainPath: agentKeychainPath(fixture.root),
    ...(fragment !== undefined ? { fragment } : {}),
    ...overrides,
  });
}

function find(assessment: ReturnType<typeof assess>, id: string) {
  return assessment.findings.find((f) => f.id === id);
}

// --- The distinction the module exists for -----------------------------------------------------

test("a complete, granted, readable store is usable with no warnings", () => {
  const root = makeTree({ gitconfig: true, gh: true, ssh: true });
  const assessment = assess({ root, agentRootGranted: root });
  assert.deepEqual(assessment.warnings, []);
  assert.equal(assessment.usable, true);
});

test("a MISSING gitconfig is 'not provisioned' — a setup step", () => {
  const root = makeTree({ gh: true, ssh: true });
  const finding = find(assess({ root, agentRootGranted: root }), "gitconfig");
  assert.ok(finding);
  assert.equal(finding.state, "not-provisioned");
  assert.match(finding.message, /no gitconfig at/);
  // It must name the path and how to fix it, not just assert absence.
  assert.match(finding.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a PRESENT gitconfig that the policy does not grant is 'unreachable' — a Pi Central bug", () => {
  // The C15 defect, reproduced in miniature: the file exists and the environment points at it,
  // while the sandbox denies it. The fix is in the policy, not the user's setup.
  const root = makeTree({ gitconfig: true, gh: true, ssh: true });
  const finding = find(assess({ root, agentRootGranted: undefined }), "gitconfig");
  assert.ok(finding);
  assert.equal(finding.state, "unreachable");
  assert.match(finding.message, /Pi Central bug/);
  assert.ok(!/Provision it/.test(finding.message), "an unreachable file must not be reported as a setup step");
});

test("a PRESENT gh config with no grant is 'unreachable' and explains the fallback", () => {
  const root = makeTree({ gitconfig: true, gh: true, ssh: true });
  const finding = find(assess({ root, agentRootGranted: undefined }), "gh-config");
  assert.ok(finding);
  assert.equal(finding.state, "unreachable");
  // The message should name the mechanism that produced the confusing original error.
  assert.match(finding.message, /host's config/);
});

test("a missing gh config is 'not provisioned' and predicts the host-fallback failure", () => {
  const root = makeTree({ gitconfig: true, ssh: true });
  const finding = find(assess({ root, agentRootGranted: root }), "gh-config");
  assert.ok(finding);
  assert.equal(finding.state, "not-provisioned");
  assert.match(finding.message, /fall back to the host's config/);
});

test("the two states never collapse into one message", () => {
  // The failure mode this module exists to prevent: the same wording for both causes.
  const missing = assess({ root: makeTree({ gh: true }), agentRootGranted: undefined });
  const unreachable = assess({ root: makeTree({ gitconfig: true }), agentRootGranted: undefined });
  const missingGit = find(missing, "gitconfig");
  assert.equal(missingGit?.state, "not-provisioned");
  const unreachableGit = find(unreachable, "gitconfig");
  assert.equal(unreachableGit?.state, "unreachable");
  assert.notEqual(missingGit?.message, unreachableGit?.message);
});

// --- Never blocks, and never claims the wrong thing --------------------------------------------

test("it never blocks: a store with nothing in it still returns an assessment", () => {
  const root = makeTree({});
  const assessment = assess({ root, agentRootGranted: root });
  assert.equal(assessment.usable, false);
  assert.ok(assessment.warnings.length > 0, "a non-usable store must say so");
  // A session with no identity is still useful, so this reports rather than refuses. There is no
  // throw and no failure result here — the caller always gets a session.
  assert.ok(assessment.findings.every((f) => typeof f.message === "string" && f.message.length > 0));
});

test("no message names a HOST credential path", () => {
  // The original error named `~/.config/gh/config.yml`, a host path, which read as "the sandbox is
  // blocking my config". Every message here must name a path inside the agent root instead, or the
  // same misdiagnosis comes back.
  const root = makeTree({});
  const assessment = assess({ root, agentRootGranted: undefined });
  for (const warning of assessment.warnings) {
    assert.ok(
      !warning.includes("/.config/gh/config.yml") && !warning.includes("/.gitconfig"),
      `a host path leaked into a capability message: ${warning}`,
    );
    assert.ok(!warning.includes("/Users/"), `a host home path leaked: ${warning}`);
  }
});

test("a warning is prefixed with the capability and which of the two states it is in", () => {
  const root = makeTree({});
  const assessment = assess({ root, agentRootGranted: root });
  const gitWarning = assessment.warnings.find((w) => w.includes("agent git identity"));
  assert.ok(gitWarning, `expected a git identity warning, got: ${JSON.stringify(assessment.warnings)}`);
  assert.match(gitWarning, /not provisioned/);
});

// --- Permissions are a different problem from absence -------------------------------------------

test("an unreadable gitconfig is 'unreachable' and named as a permissions problem", { skip: process.getuid?.() === 0 }, () => {
  const root = makeTree({ gitconfig: true, gh: true, ssh: true });
  chmodSync(join(root, "gitconfig"), 0o000);
  try {
    const finding = find(assess({ root, agentRootGranted: root }), "gitconfig");
    assert.ok(finding);
    assert.equal(finding.state, "unreachable");
    assert.match(finding.message, /permissions problem/);
    assert.ok(!/Provision it/.test(finding.message));
  } finally {
    // Restore so the temp tree can be removed.
    chmodSync(join(root, "gitconfig"), 0o600);
  }
});

// --- Keychain: reported only when it matters -----------------------------------------------------

test("a keychain warning appears only when the provider config needs one", () => {
  const root = makeTree({ gitconfig: true, gh: true, ssh: true });
  const inlineKey = assessAgentCapabilities({
    store: readStore(root, { ownership: "external" }),
    sandboxed: true,
    fragment: renderPolicyFragment({ agentRoot: root }),
    providerAuth: { path: "/a/auth.json", readable: true, providers: ["litellm"], commandProviders: [], needsKeychain: false },
    keychainPath: agentKeychainPath(root),
  });
  assert.equal(find(inlineKey, "keychain"), undefined, "an inline key needs no keychain and must not warn");

  const commandKey = assessAgentCapabilities({
    store: readStore(root, { ownership: "external" }),
    sandboxed: true,
    fragment: renderPolicyFragment({ agentRoot: root }),
    providerAuth: { path: "/a/auth.json", readable: true, providers: ["litellm"], commandProviders: ["litellm"], needsKeychain: true },
    keychainPath: agentKeychainPath(root),
  });
  const finding = find(commandKey, "keychain");
  assert.ok(finding, "a command-based key with no keychain grant must warn (C13)");
  assert.equal(finding.state, "unreachable");
  assert.match(finding.message, /unable to reach a model/);
});

test("a keychain grant WITHOUT the search list is reported as unreachable", () => {
  // C13: without the search-list file, `security` silently falls back to [login, System], never
  // sees the agent keychain, and every lookup fails with no useful error. A grant that looks right
  // and is not is exactly the case worth catching.
  const root = makeTree({ gitconfig: true, gh: true, ssh: true, keychain: true });
  const withSearchList = renderPolicyFragment({ agentRoot: root, keychain: true, keychainPath: agentKeychainPath(root) });
  assert.ok(withSearchList.includes('(home-literal "/Library/Preferences/com.apple.security.plist")'));
  // Remove the RULE, keeping the comment that describes it — which is the shape that broke the
  // first version of the check (a bare substring match passed on prose alone).
  const withoutRule = withSearchList.replace(/^.*\(home-literal "\/Library\/Preferences.*\n/m, "");
  assert.ok(!/^.*\(home-literal "\/Library\/Preferences/m.test(withoutRule), "the rule must be gone");
  assert.match(withoutRule, /The search list lives in com\.apple\.security\.plist/, "the comment must remain");

  const providerAuth = { path: "/a/auth.json", readable: true, providers: ["p"], commandProviders: ["p"], needsKeychain: true };
  const ok = assessAgentCapabilities({
    store: readStore(root, { ownership: "external" }),
    sandboxed: true,
    fragment: withSearchList,
    providerAuth,
    keychainPath: agentKeychainPath(root),
  });
  assert.equal(find(ok, "keychain"), undefined, "the full grant is fine");

  const broken = assessAgentCapabilities({
    store: readStore(root, { ownership: "external" }),
    sandboxed: true,
    fragment: withoutRule,
    providerAuth,
    keychainPath: agentKeychainPath(root),
  });
  assert.equal(find(broken, "keychain")?.state, "unreachable");
});

test("a fragment that only DESCRIBES the search list in a comment does not count as granting it", () => {
  // The specific regression: the generated fragment documents the search list in prose, so a
  // substring check on the filename passes on a fragment with no such rule. Found by removing the
  // rule and watching the check stay green, which is the whole reason this test exists separately.
  const root = makeTree({ gitconfig: true, gh: true, ssh: true });
  const proseOnly = [
    "(allow mach-lookup",
    '    (global-name "com.apple.SecurityServer")',
    ")",
    ";; The search list lives in com.apple.security.plist - but this fragment grants nothing for it.",
  ].join("\n");
  const assessment = assessAgentCapabilities({
    store: readStore(root, { ownership: "external" }),
    sandboxed: true,
    fragment: proseOnly,
    providerAuth: { path: "/a/auth.json", readable: true, providers: ["p"], commandProviders: ["p"], needsKeychain: true },
    keychainPath: agentKeychainPath(root),
  });
  assert.equal(find(assessment, "keychain")?.state, "unreachable");
});

test("direct mode never reports a policy problem, because there is no policy", () => {
  const root = makeTree({ gitconfig: true, gh: true, ssh: true });
  const assessment = assessAgentCapabilities({
    store: readStore(root, { ownership: "external" }),
    sandboxed: false,
    providerAuth: { path: "/a/auth.json", readable: true, providers: ["p"], commandProviders: ["p"], needsKeychain: true },
    keychainPath: agentKeychainPath(root),
  });
  // No fragment is passed, and none should be required: nothing can deny the lookup.
  assert.equal(assessment.warnings.length, 0, JSON.stringify(assessment.warnings));
});

// --- The probe against the real, adopted agent tree ---------------------------------------------

test("the real agent tree on this machine is assessed without reading a secret", () => {
  // A metadata-only check against whatever ~/.agent holds. It asserts an INVARIANT rather than a
  // particular outcome: the assessment must produce findings, not throw, and its warnings must
  // never contain a credential value.
  const home = process.env["HOME"] ?? "";
  const realRoot = join(home, ".agent");
  let store;
  try {
    store = readStore(realRoot, { ownership: "external" });
  } catch {
    return; // no adopted tree on this machine; nothing to assert
  }
  const providerAuth = inspectProviderAuth(join(home, ".pi", "agent"));
  const assessment = assessAgentCapabilities({
    store,
    sandboxed: true,
    fragment: renderProviderFragmentFor(realRoot, providerAuth.needsKeychain),
    providerAuth,
    keychainPath: agentKeychainPath(realRoot),
  });
  assert.ok(Array.isArray(assessment.warnings));
  // Nothing secret may appear: the SSH key file's contents, a gh token, or a keychain dump.
  for (const warning of assessment.warnings) {
    assert.ok(!/BEGIN OPENSSH PRIVATE KEY/.test(warning), "a private key leaked into a warning");
    assert.ok(!/gho_|ghp_|github_pat_/.test(warning), "a token leaked into a warning");
  }
});

function renderProviderFragmentFor(agentRoot: string, keychain: boolean): string {
  return renderPolicyFragment({
    agentRoot,
    ...(keychain ? { keychain: true, keychainPath: agentKeychainPath(agentRoot) } : {}),
  });
}
