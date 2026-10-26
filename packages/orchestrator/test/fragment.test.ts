import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fragmentPath, renderPolicyFragment } from "../src/fragment.ts";

/**
 * The appended policy fragment (ADR-0010). Content assertions run everywhere; the SBPL syntax
 * check needs `sandbox-exec` (macOS-only, C10) and skips when it is absent.
 *
 * **What that costs, stated plainly:** on Linux these two tests skip, so a suite run there proves
 * the fragment is *built* correctly but never that it *parses*. CI says so on every run rather
 * than reporting a green tick over a gap. The macOS-only path is where a policy syntax error would
 * actually be caught, and a syntax error is a session that will not start.
 */

const dir = mkdtempSync(join(tmpdir(), "pi-central-fragment-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

test("the host's credential paths are denied", () => {
  const fragment = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  // Each of these is granted by Safehouse's generated policy, so a deny must override it.
  assert.match(fragment, /\(deny file-read\*\s*\n\s*\(home-prefix "\/\.gitconfig"\)/);
  assert.match(fragment, /\(home-subpath "\/\.config\/gh"\)/);
  assert.match(fragment, /\(home-subpath "\/\.ssh\/agent"\)/);
  // The host's PRIVATE KEYS, which is the signing-specific half of the same boundary (issue #27):
  // `user.signingkey` is a path, so a reachable host key is what would let an agent sign as the
  // user. Every common key name must match, not only the one this machine happens to use.
  // Matched as the SBPL regex strings the fragment actually contains, rather than as a loose
  // pattern: a check that passes on a *mention* of a deny in a comment would be worthless here.
  const denials = fragment.split("\n").filter((line) => line.includes("(regex #")).join("\n");
  assert.ok(denials.includes("id_[^/]*$"), "every ~/.ssh/id_* key must be denied");
  assert.ok(denials.includes(".*_ed25519$"), "an ed25519 host key must be denied");
  assert.ok(denials.includes(".*_rsa$"), "an RSA host key must be denied");
});

test("Pi's auth store is NOT denied (C12, ADR-0010 Amendment 1)", () => {
  // Denying it made every session exit 1: Pi reads it at startup, and a policy deny produces
  // EPERM where ENOENT would have been tolerated. It also holds `!command` indirections, not
  // secrets. This test fails if the deny is ever reintroduced.
  const fragment = renderPolicyFragment({
    agentRoot: "/state/agents/default",
    keychain: true,
    keychainPath: "/a/db",
  });
  // Read **rules**, not prose: the comments mention auth.json precisely to record why it is
  // not denied, so matching the whole text would be a false positive.
  const rules = fragment
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(";;"))
    .join("\n");
  assert.ok(!rules.includes("auth.json"), "auth.json must not appear in any rule");
  assert.ok(!/\(deny[^)]*\.pi/.test(rules), "nothing under ~/.pi may be denied without booting Pi");
});

test("the agent's own tree is granted read-write, so GH_CONFIG_DIR is usable", () => {
  const fragment = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  assert.match(fragment, /\(allow file-read\* file-write\*\s*\n\s*\(subpath "\/state\/agents\/default"\)/);
});

test("ancestor traversal is granted, or the agent cannot reach its own tree", () => {
  // Same class of failure as the auth.json deny (C12): SBPL resolves a path component by
  // component, and Safehouse only emits ancestor literals for the *workdir*. A managed agent
  // root sits at ~/.config/pi-central/agents/<id>, which no base grant covers, so without
  // these literals a session starts fine and then cannot read the credentials it was given.
  const fragment = renderPolicyFragment({ agentRoot: "/Users/x/.config/pi-central/agents/default" });
  for (const literal of [
    '(literal "/")',
    '(literal "/Users")',
    '(literal "/Users/x")',
    '(literal "/Users/x/.config")',
    '(literal "/Users/x/.config/pi-central")',
    '(literal "/Users/x/.config/pi-central/agents")',
    '(literal "/Users/x/.config/pi-central/agents/default")',
  ]) {
    assert.ok(fragment.includes(literal), `missing ancestor literal ${literal}`);
  }
});

test("ancestor literals are literal, not subpath: no recursive widening", () => {
  // `subpath` on an ancestor would grant the whole subtree (e.g. all of ~/.config), which is
  // exactly the over-grant this fragment exists to avoid. Safehouse uses `literal` for this
  // reason; this test fails if someone "simplifies" it to a subpath.
  const fragment = renderPolicyFragment({ agentRoot: "/Users/x/.config/agents/default" });
  const ancestorBlock = fragment.slice(fragment.indexOf("(allow file-read*"));
  assert.ok(
    !ancestorBlock.includes('(subpath "/Users/x/.config")'),
    "an ancestor must never be granted as a subpath",
  );
});

test("the agent root is granted even for an externally owned tree", () => {
  // Ownership affects who WRITES the tree, not whether the session may read its own
  // credentials. Omitting this allow would configure the session to use files it cannot read.
  const fragment = renderPolicyFragment({ agentRoot: "/Users/x/.agent" });
  assert.match(fragment, /\(subpath "\/Users\/x\/\.agent"\)/);
});

test("keychain access is off unless asked for, and then bounded (C13)", () => {
  assert.ok(!renderPolicyFragment({ agentRoot: "/a" }).includes("SecurityServer"));

  const withKeychain = renderPolicyFragment({
    agentRoot: "/a",
    keychain: true,
    keychainPath: "/a/agent.keychain-db",
  });
  assert.match(withKeychain, /com\.apple\.SecurityServer/);
  assert.match(withKeychain, /\(literal "\/a\/agent\.keychain-db"\)/);
  // The bound: the login and System keychain files are denied, so the grant reaches only the
  // agent's own keychain (the keychain is all-or-nothing via IPC, so this is what limits it).
  assert.match(withKeychain, /\(deny file-read\* file-write\*\s*\n\s*\(home-subpath "\/Library\/Keychains"\)/);
  assert.match(withKeychain, /\(subpath "\/Library\/Keychains"\)/);
  // The search list must be readable or service-only lookups silently fail.
  assert.match(withKeychain, /com\.apple\.security\.plist/);
});

test("keychain access without a path is refused rather than guessed", () => {
  assert.throws(() => renderPolicyFragment({ keychain: true }), /absolute keychainPath/);
  assert.throws(
    () => renderPolicyFragment({ keychain: true, keychainPath: "relative" }),
    /absolute keychainPath/,
  );
});

test("the ssh-agent sockets are denied at the network layer too", () => {
  // A file deny alone does not cover `connect()` on a unix socket. Both are needed.
  const fragment = renderPolicyFragment();
  assert.match(fragment, /\(deny network-outbound/);
  assert.match(fragment, /com\\\.apple\\\.launchd/);
  assert.match(fragment, /string-append "\^" HOME_DIR/);
});

test("the agent's own credentials stay readable — the denies are useless otherwise", () => {
  const fragment = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  assert.match(fragment, /\(allow file-read\* file-write\*\s*\n\s*\(subpath "\/state\/agents\/default"\)/);
});

test("no absolute home path is hardcoded: the fragment is portable (ADR-0010)", () => {
  // This is the property the hardening project lacked: its ~/.agent path was baked in because
  // the policy was generated with that workdir. Host paths here are HOME_DIR-relative, and the
  // only absolute path is the agent root, which is configuration.
  const fragment = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  const home = homedir();
  assert.ok(!fragment.includes(home), `the fragment must not hardcode ${home}`);
  assert.match(fragment, /HOME_DIR/);
});

test("rendering is deterministic, so drift is diffable (the drift badge)", () => {
  const a = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  const b = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  assert.equal(a, b);
});

test("denying Pi's auth store is not possible at all (the option is gone)", () => {
  // The `denyPiAuth` escape hatch was removed rather than defaulted off: keeping it would
  // invite someone to switch it back on and break every session again (C12).
  const fragment = renderPolicyFragment({ agentRoot: "/a" });
  assert.ok(!fragment.includes("auth.json"));
});

test("a relative agent root is refused: it would resolve unpredictably", () => {
  assert.throws(() => renderPolicyFragment({ agentRoot: "agents/default" }), /absolute path/);
});

test("parentheses are balanced, so the fragment cannot break the composed policy", () => {
  const fragment = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  let depth = 0;
  for (const char of fragment) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    assert.ok(depth >= 0, "a closing paren appeared before its opener");
  }
  assert.equal(depth, 0, "unbalanced parentheses would be an SBPL syntax error");
});

test("the fragment path is deterministic and lives under the state root (Q7)", () => {
  assert.equal(fragmentPath("/state"), "/state/policy/fragment.sb");
});

/**
 * Real SBPL validation.
 *
 * `sandbox-exec` reports a **syntax error before** attempting to apply a policy, so a parse
 * check works even where applying is blocked. That is what makes this test possible in the
 * development sandbox, where Seatbelt cannot nest (C1) and `sandbox_apply` fails with
 * "Operation not permitted" for *any* policy, valid or not.
 *
 * The assertion is therefore on the *absence of a syntax error*, not on clean execution:
 * `sandbox_apply: Operation not permitted` is the expected output for valid SBPL here.
 */
const sandboxExec = "/usr/bin/sandbox-exec";
const canValidate = process.platform === "darwin" && existsSync(sandboxExec);

test("the fragment composes into valid SBPL (parse check)", { skip: !canValidate }, () => {
  const composed = join(dir, "composed.sb");
  writeFileSync(
    composed,
    [
      "(version 1)",
      `(define HOME_DIR ${JSON.stringify(homedir())})`,
      '(define (home-subpath rel) (subpath (string-append HOME_DIR rel)))',
      '(define (home-literal rel) (literal (string-append HOME_DIR rel)))',
      '(define (home-prefix rel) (prefix (string-append HOME_DIR rel)))',
      "(allow file-read*)",
      renderPolicyFragment({
        agentRoot: "/state/agents/default",
        keychain: true,
        keychainPath: "/state/agents/default/agent.keychain-db",
      }),
    ].join("\n"),
  );

  let output = "";
  try {
    execFileSync(sandboxExec, ["-f", composed, "/bin/true"], { stdio: "pipe" });
  } catch (error) {
    output = String((error as { stderr?: Buffer }).stderr ?? "");
  }
  assert.ok(
    !/syntax error/i.test(output),
    `the composed policy must parse; sandbox-exec said: ${output.trim()}`,
  );
});

test("a deliberately broken fragment DOES report a syntax error (the check has teeth)", { skip: !canValidate }, () => {
  // Negative control: without this, the test above would pass even if sandbox-exec never
  // validated anything.
  const broken = join(dir, "broken.sb");
  writeFileSync(broken, '(version 1)\n(allow file-read*\n');
  let output = "";
  try {
    execFileSync(sandboxExec, ["-f", broken, "/bin/true"], { stdio: "pipe" });
  } catch (error) {
    output = String((error as { stderr?: Buffer }).stderr ?? "");
  }
  assert.match(output, /syntax error/i);
});
