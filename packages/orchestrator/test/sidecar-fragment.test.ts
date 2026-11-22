import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPolicyFragment } from "../src/fragment.ts";
import { renderSidecarFragment } from "../src/sidecar-fragment.ts";

/**
 * The UI sidecar's fragment (ADR-0015). Content assertions run everywhere; the SBPL syntax check
 * needs `sandbox-exec`, which is macOS-only (C10), and reports its skip rather than passing silently.
 *
 * **The falsification these tests are built around.** The Phase 0C spike hand-wrote a four-name deny
 * list and the renderer could still read `~/.gitconfig`, while the other three names were refused.
 * C15c says the unit of a path boundary is the DIRECTORY, not a list of names under it. So the
 * assertions below are a COVERAGE property over the rendered text — "does any rule deny this path?" —
 * with the missed names as named falsifiers, rather than a check that a particular rule string appears.
 * A test that looked for `~/.ssh` would have passed throughout.
 *
 * Writing it that way immediately found a second instance in **production**: the base profile grants
 * `~/.npmrc`, `~/.cache/gh` and `~/.local/share/gh`, and `HOST_DENIES` named none of them.
 */

const PORT = 4173;

/**
 * Does the rendered fragment deny reads of `relative`?
 *
 * Textual and deliberately narrow: this is not a policy engine. It answers "is any deny rule
 * responsible for this path", which is the question the spike got wrong by listing names instead.
 * `home-subpath` covers descendants; `home-prefix` covers siblings such as `.gitconfig.local`.
 */
function rules(fragment: string): string {
  // Comments are stripped BEFORE any assertion. C20 records the defect this prevents: a guard string that
  // also appears in the comment explaining the guard makes a textual test pass with the bug reintroduced.
  return fragment
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(";;"))
    .join("\n");
}

function deniesPath(fragment: string, relative: string): boolean {
  for (const block of rules(fragment).split("(deny").slice(1)) {
    if (block.includes(`(home-subpath "${relative}")`)) return true;
    if (block.includes(`(home-prefix "${relative}")`)) return true;
    if (block.includes(`(home-literal "${relative}")`)) return true;
  }
  return false;
}

test("the sidecar denies every host credential the session denies", () => {
  const session = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  const sidecar = renderSidecarFragment({ port: PORT });

  for (const path of ["/.gitconfig", "/.ssh", "/.config/gh"]) {
    assert.ok(deniesPath(session, path), `the session fragment must deny ${path} (precondition)`);
    assert.ok(deniesPath(sidecar, path), `the sidecar fragment must deny ${path}`);
  }
});

test("the renderer denies npm and gh state that a session may legitimately read", () => {
  const session = renderPolicyFragment({ agentRoot: "/state/agents/default" });
  const sidecar = renderSidecarFragment({ port: PORT });

  for (const path of ["/.npmrc", "/.cache/gh", "/.local/share/gh"]) {
    assert.ok(deniesPath(sidecar, path), `the renderer must not read ${path}`);
  }
  // And the two lists must genuinely differ, or the renderer-only block is dead text.
  assert.ok(
    !deniesPath(session, "/.npmrc"),
    "session ~/.npmrc stays readable until an agent npm token exists (ADR-0010)",
  );
});

test("the sidecar is rendered from the shared deny set, not restated", () => {
  const session = renderPolicyFragment({});
  const sidecar = renderSidecarFragment({ port: PORT });
  const sharedRules = rules(session).split("\n").filter((line) => /^\s*\(deny/.test(line));
  assert.ok(sharedRules.length > 0, "the session fragment must emit denies (precondition)");
  for (const rule of sharedRules) {
    assert.ok(sidecar.includes(rule), `the sidecar must carry the shared rule: ${rule.trim()}`);
  }
});

test("the sidecar has no agent root, no keychain, and no writable subtree", () => {
  const sidecar = rules(renderSidecarFragment({ port: PORT }));
  assert.ok(!sidecar.includes("SecurityServer"), "a renderer resolves no provider key (ADR-0015 §9)");
  // About ALLOWS, not about text: the shared deny block legitimately names ~/.ssh/allowed_signers, so a
  // substring check would fail on correct input. What must not exist is a grant.
  for (const block of sidecar.split("(allow").slice(1)) {
    assert.ok(
      !/agentRoot|\.ssh\/allowed_signers|Library\/Keychains/.test(block.split(")").slice(0, 6).join(")")),
      `a renderer grants nothing agent-owned, found: ${block.split(")")[0]}`,
    );
  }
  assert.ok(
    !/\(allow file-read\* file-write\*\s*\n\s*\(subpath/.test(sidecar),
    "a renderer writes nothing outside its own profile",
  );
});

test("egress is pinned to the port it was given", () => {
  const fragment = rules(renderSidecarFragment({ port: 5173 }));
  assert.match(fragment, /\(allow network-outbound \(remote ip "localhost:5173"\)\)/);
  assert.match(fragment, /\(deny network-outbound \(remote ip\)\)/);
  // Measured: a second loopback port answers EPERM only when the allow names ONE port.
  assert.ok(!fragment.includes('"localhost:*"'), "localhost:* is every port, not a pin");
  assert.ok(!fragment.includes("127.0.0.1"), "a v4 literal does not parse (measured, exit 65)");
  // A deny on (remote ip) does not reach unix sockets, so the resolver socket is named too.
  assert.ok(fragment.includes("/private/var/run/mDNSResponder"), "DNS is not confined by (remote ip)");
});

test("a port that is not a port is refused rather than silently composed", () => {
  for (const bad of [0, -1, 65536, 1.5, Number.NaN]) {
    assert.throws(() => renderSidecarFragment({ port: bad }), /1\.\.65535/, `port ${bad}`);
  }
});

/**
 * The parse check, and the correction that matters more than the test.
 *
 * The first version probed `sandbox-exec -p '(version 1)' -- /usr/bin/true` and skipped whenever that
 * exited non-zero. It always exits non-zero, on every machine: a bare `(version 1)` has no rules, so
 * `true` is *denied* — a valid policy that refuses the command. The guard therefore skipped a healthy
 * environment and **the parse check never ran anywhere**, which is the "a test that cannot fail is not
 * evidence" defect this repository keeps recording. A positive control has to allow the thing it runs.
 *
 * The right question is not "did it apply" but "did it complain about SYNTAX": nested, `sandbox_apply`
 * fails with EPERM for a *valid* policy too, so `fragment.test.ts` checks for the absence of a syntax
 * error and keeps a negative control beside it. This does the same, and adds the one thing that makes it
 * meaningful here — a broken variant must produce the error the good one must not.
 */
const sandboxExec = "/usr/bin/sandbox-exec";
const canValidate = process.platform === "darwin" && existsSync(sandboxExec);

/** Run `sandbox-exec -f file` and return its diagnostics. EPERM is expected and not a failure. */
function applyDiagnostics(file: string): string {
  try {
    execFileSync(sandboxExec, ["-f", file, "/bin/true"], { stdio: "pipe" });
    return "";
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr ?? "");
  }
}

test("the fragment parses as SBPL", { skip: !canValidate && "sandbox-exec is not on this platform (C10)" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-central-sidecar-fragment-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "sidecar.sb");
  writeFileSync(file, renderSidecarFragment({ port: PORT }), { mode: 0o600 });
  // Composed through Safehouse, so the fragment is appended exactly as production appends it.
  const composed = spawnSync("safehouse", ["--stdout", "--workdir", dir, "--append-profile", file], {
    encoding: "utf8",
  });
  assert.equal(composed.status, 0, `safehouse refused the fragment: ${composed.stderr}`);
  assert.ok(composed.stdout.includes("Pi Central"), "the fragment reached the composed policy");

  const composedFile = join(dir, "composed.sb");
  writeFileSync(composedFile, composed.stdout, { mode: 0o600 });
  const diagnostics = applyDiagnostics(composedFile);
  assert.ok(
    !/syntax error/i.test(diagnostics),
    `the composed policy must parse; sandbox-exec said: ${diagnostics.trim()}`,
  );
});

test("a deliberately broken fragment DOES report a syntax error (the check has teeth)", { skip: !canValidate && "sandbox-exec is not on this platform (C10)" }, () => {
  // Negative control. Without it the assertion above passes even if sandbox-exec validated nothing —
  // which is precisely what the first version of this test did, with a strace-free skip that looked
  // like diligence. Measured: an unbalanced paren produces "syntax error" here, EPERM or not.
  const dir = mkdtempSync(join(tmpdir(), "pi-central-sidecar-broken-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const broken = join(dir, "broken.sb");
  writeFileSync(broken, '(version 1)\n(allow file-read*\n', { mode: 0o600 });
  assert.match(applyDiagnostics(broken), /syntax error/i);
});
