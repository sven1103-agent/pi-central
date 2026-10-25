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
 */

const dir = mkdtempSync(join(tmpdir(), "pi-central-fragment-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

test("the host's credential paths are denied", () => {
  const fragment = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  // Each of these is granted by Safehouse's generated policy, so a deny must override it.
  assert.match(fragment, /\(deny file-read\*\s*\n\s*\(home-prefix "\/\.gitconfig"\)/);
  assert.match(fragment, /\(home-subpath "\/\.config\/gh"\)/);
  assert.match(fragment, /\(home-literal "\/\.pi\/agent\/auth\.json"\)/);
  assert.match(fragment, /\(home-subpath "\/\.ssh\/agent"\)/);
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
  assert.match(fragment, /\(allow file-read\*\s*\n\s*\(subpath "\/state\/agents\/default"\)/);
});

test("no absolute home path is hardcoded: the fragment is portable (ADR-0010)", () => {
  // This is the property the hardening project lacked: its ~/.agent path was baked in
  // because the policy was generated with that workdir. Everything here is HOME_DIR-relative.
  const fragment = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  const home = homedir();
  assert.ok(
    !fragment.split("\n").some((line) => line.trimStart().startsWith(";;") === false && line.includes(home)),
    `the fragment must not hardcode ${home}`,
  );
  // The generated policy defines HOME_DIR before appended rules are emitted.
  assert.match(fragment, /HOME_DIR/);
});

test("rendering is deterministic, so drift is diffable (the drift badge)", () => {
  const a = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  const b = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  assert.equal(a, b);
});

test("denying Pi's auth store can be turned off, and the default is on", () => {
  assert.match(renderPolicyFragment(), /\.pi\/agent\/auth\.json/);
  assert.ok(!renderPolicyFragment({ denyPiAuth: false }).includes("auth.json"));
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
  const file = join(dir, "fragment.sb");
  writeFileSync(file, renderPolicyFragment({ agentRoot: "/state/agents/default" }));

  // A minimal wrapper that defines HOME_DIR, as Safehouse's generated policy does.
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
      renderPolicyFragment({ agentRoot: "/state/agents/default" }),
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
