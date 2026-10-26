/**
 * Commit signing configuration tests (issue #27).
 *
 * The bug these exist for: the agent tree set `commit.gpgsign = false` while holding a valid signing
 * key and an `allowed_signers` file, so commits were unsigned and **nothing reported it**. Every
 * check that asked "is the key there?" passed. So these tests are mostly about what a *key check
 * cannot see* — the settings that make the key do something.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedSignersPath,
  auditSigning,
  isInside,
  normalizeKey,
  parseGitConfig,
  readSigning,
  signingFixCommands,
  signingKeyPath,
  signingMaterial,
} from "../src/signing.ts";

/** The agent tree's real broken gitconfig, reduced to the parts that matter. */
const BROKEN = `[user]
\tname = sven1103-agent
\temail = sven1103-agent@users.noreply.github.com
[commit]
\tgpgsign = false
[tag]
\tgpgsign = false
`;

function fixed(root: string): string {
  return `[user]
\tname = sven1103-agent
\tsigningkey = ${signingKeyPath(root)}
[commit]
\tgpgsign = true
[tag]
\tgpgsign = true
[gpg]
\tformat = ssh
[gpg "ssh"]
\tallowedSignersFile = ${allowedSignersPath(root)}
`;
}

// --- The parser ----------------------------------------------------------------------------------

test("the parser reads the exact syntax git writes", () => {
  // Asserted against real `git config` output rather than assumed, because a parser that disagrees
  // with git in one detail reports a healthy store as broken or the reverse.
  const root = "/tmp/agent";
  const values = parseGitConfig(fixed(root));
  assert.equal(values.get(normalizeKey("commit.gpgsign")), "true");
  assert.equal(values.get(normalizeKey("tag.gpgsign")), "true");
  assert.equal(values.get(normalizeKey("gpg.format")), "ssh");
  assert.equal(values.get(normalizeKey("user.signingkey")), signingKeyPath(root));
  assert.equal(values.get(normalizeKey("gpg.ssh.allowedSignersFile")), allowedSignersPath(root));
});

test("the parser handles the [section \"sub\"] form that git actually emits", () => {
  // `gpg.ssh.allowedSignersFile` is written as `[gpg "ssh"]`. A parser that only handled `[section]`
  // would miss the key entirely and call every correctly-configured store incomplete — which is
  // exactly the bug this test was written after.
  const values = parseGitConfig('[gpg "ssh"]\n\tallowedSignersFile = /a/b\n');
  // Looked up the way the module looks it up. Asserting on the raw mixed-case string would test my
  // spelling rather than the parser.
  assert.equal(values.get(normalizeKey("gpg.ssh.allowedSignersFile")), "/a/b");
});

test("keys are compared case-insensitively, INCLUDING the final component", () => {
  // git's rule, and it is not cosmetic: git writes `allowedSignersFile`, the fix command says
  // `allowedSignersFile`, and a parser that lowercased the whole key reported it unset. Found by
  // auditing a store configured by the fix commands themselves.
  const values = parseGitConfig('[gpg "ssh"]\n\tallowedsignersfile = /a/b\n[Commit]\n\tGpgSign = true\n');
  assert.equal(values.get(normalizeKey("gpg.ssh.allowedSignersFile")), "/a/b");
  assert.equal(values.get(normalizeKey("commit.gpgsign")), "true");
  // But the SUBSECTION stays case-sensitive, because it can name a remote or a key.
  const other = parseGitConfig('[remote "Origin"]\n\turl = x\n');
  assert.equal(other.get("remote.Origin.url"), "x");
  assert.equal(other.get("remote.origin.url"), undefined);
});

test("the parser ignores comments and blank lines, and never guesses", () => {
  const values = parseGitConfig("# a comment\n; another\n\n[user]\n\tname = a\n\tgarbage line\n");
  assert.equal(values.get(normalizeKey("user.name")), "a");
  assert.equal(values.size, 1, "an unparseable line must be skipped, not guessed at");
});

test("a key before any section is not attributed to one", () => {
  // Without this, a stray `gpgsign = true` at the top of the file would be read as some section's.
  assert.equal(parseGitConfig("gpgsign = true\n").size, 0);
});

// --- The audit: the bug itself -------------------------------------------------------------------

test("the agent tree's REAL gitconfig is reported as not signing", () => {
  // The regression test for the reported bug, using the file's actual shape.
  const settings = readSigning(BROKEN);
  const audit = auditSigning(settings, "/tmp/agent");
  assert.equal(audit.state, "disabled");
  assert.equal(audit.needsFix, true);
  assert.ok(audit.problems.some((p) => p.includes("commit.gpgsign")));
  assert.ok(audit.problems.some((p) => p.includes("tag.gpgsign")));
});

test("an UNSET gpgsign counts as off, not as unknown", () => {
  // git's default for commit.gpgsign is false, so an absent key produces unsigned commits exactly as
  // `= false` does. Treating unset as neutral would call a store that never signs healthy.
  const audit = auditSigning({}, "/tmp/agent");
  assert.equal(audit.state, "disabled");
  assert.equal(audit.needsFix, true);
});

test("git's affirmative spellings are all honoured, and 'false' is not", () => {
  // git accepts true/1/yes/on. Rejecting them would tell a correctly-configured user to fix a file
  // that is already right — and a user told to fix something correct stops trusting the warning.
  for (const value of ["true", "1", "yes", "on", "TRUE"]) {
    const audit = auditSigning(
      { commitGpgsign: value, tagGpgsign: "true", format: "ssh", signingKey: "/tmp/agent/ssh/k", allowedSignersFile: "/tmp/agent/ssh/a" },
      "/tmp/agent",
    );
    assert.equal(audit.state, "ok", `${value} must count as signed`);
  }
  const off = auditSigning(
    { commitGpgsign: "false", tagGpgsign: "true", format: "ssh", signingKey: "/tmp/agent/ssh/k", allowedSignersFile: "/tmp/agent/ssh/a" },
    "/tmp/agent",
  );
  assert.equal(off.state, "disabled");
});

test("a fully configured store is ok, and needs no fix", () => {
  const audit = auditSigning(readSigning(fixed("/tmp/agent")), "/tmp/agent");
  assert.equal(audit.state, "ok");
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.needsFix, false);
});

test("missing pieces are reported TOGETHER, not one per run", () => {
  // Fixing one, re-running, and being told about the next is how a five-step setup becomes five
  // sessions of work.
  const audit = auditSigning({ commitGpgsign: "true", tagGpgsign: "true" }, "/tmp/agent");
  assert.equal(audit.state, "incomplete");
  assert.equal(audit.problems.length, 3, `expected 3 problems, got ${audit.problems.join("; ")}`);
});

// --- The part that carries the security weight ---------------------------------------------------

test("a signing key OUTSIDE the agent root is a misconfiguration, not a missing setting", () => {
  // ssh takes a path rather than key contents (ADR-0010 §4), so the path is the only thing between
  // "the agent signed" and "the user signed". This is the finding that must never be softened into
  // "signing is not configured".
  const audit = auditSigning(
    {
      commitGpgsign: "true",
      tagGpgsign: "true",
      format: "ssh",
      signingKey: "/Users/sven1103/.ssh/id_ed25519",
      allowedSignersFile: "/tmp/agent/ssh/allowed_signers",
    },
    "/tmp/agent",
  );
  assert.equal(audit.state, "misconfigured");
  assert.ok(audit.problems.some((p) => p.includes("OUTSIDE the agent root")));
  assert.ok(audit.problems.some((p) => p.includes("sign commits as whoever owns")));
});

test("misconfiguration is reported BEFORE absence", () => {
  // If both are true, telling the reader only "signing is off" hides that they are set up to sign as
  // the host user. The more serious fact must be the one they see.
  const audit = auditSigning({ signingKey: "/Users/host/.ssh/id_ed25519" }, "/tmp/agent");
  assert.equal(audit.state, "misconfigured");
});

test("an allowed_signers file outside the root is refused", () => {
  const audit = auditSigning(
    { commitGpgsign: "true", tagGpgsign: "true", format: "ssh", signingKey: "/tmp/agent/ssh/k", allowedSignersFile: "/Users/host/.ssh/allowed_signers" },
    "/tmp/agent",
  );
  assert.equal(audit.state, "misconfigured");
});

test("a format other than ssh is refused, since openpgp looks for gpg", () => {
  const audit = auditSigning(
    { commitGpgsign: "true", tagGpgsign: "true", format: "openpgp", signingKey: "/tmp/agent/ssh/k", allowedSignersFile: "/tmp/agent/ssh/a" },
    "/tmp/agent",
  );
  assert.equal(audit.state, "misconfigured");
});

test("isInside compares SEGMENTS, so a prefix-named sibling is not inside", () => {
  // The exact bug issue #25 hit: `/a/agent-other` starts with `/a/agent` as a string but is a
  // different directory. A `startsWith` would call a host key "inside the agent root".
  assert.equal(isInside("/a/agent", "/a/agent/ssh/k"), true);
  assert.equal(isInside("/a/agent", "/a/agent"), true);
  assert.equal(isInside("/a/agent", "/a/agent-other/ssh/k"), false);
  assert.equal(isInside("/a/agent", "/a/agentX"), false);
  assert.equal(isInside("/a/agent", "/b/agent/ssh/k"), false);
  // A relative path that resolves upward must not escape.
  assert.equal(isInside("/a/agent", "/a/agent/../host/k"), false);
});

// --- Material versus configuration ---------------------------------------------------------------

test("the settings and the material are separate questions", () => {
  // A correct gitconfig pointing at an absent key is complete config by text and broken in fact, and
  // the repairs differ: one is "run these commands", the other is "put the key back".
  const root = mkdtempSync(join(tmpdir(), "pi-signing-"));
  try {
    mkdirSync(join(root, "ssh"), { recursive: true });
    assert.deepEqual(signingMaterial(root), { key: false, allowedSigners: false });
    writeFileSync(signingKeyPath(root), "PRIVATE");
    assert.deepEqual(signingMaterial(root), { key: true, allowedSigners: false });
    writeFileSync(allowedSignersPath(root), "a ssh-ed25519 AAAA\n");
    assert.deepEqual(signingMaterial(root), { key: true, allowedSigners: true });
    // And the audit is UNAFFECTED by the material, which is the separation being asserted.
    assert.equal(auditSigning(readSigning(fixed(root)), root).state, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- The fix commands ----------------------------------------------------------------------------

test("the fix commands, run verbatim, produce a store the audit calls ok", () => {
  // The claim is that these commands are the fix. Asserted by running them, not by inspecting them:
  // a command list that looks right and produces a gitconfig the parser cannot read would otherwise
  // pass every test above.
  const root = mkdtempSync(join(tmpdir(), "pi-signing-fix-"));
  try {
    mkdirSync(join(root, "ssh"), { recursive: true });
    const gitconfig = join(root, "gitconfig");
    writeFileSync(gitconfig, BROKEN);
    assert.equal(readSigningFrom(gitconfig).commitGpgsign, "false");

    // `git config --file` with HOME redirected, since the host gitconfig is not ours to touch.
    const env = { ...process.env, HOME: join(root, "fakehome") };
    mkdirSync(env.HOME, { recursive: true });
    for (const command of signingFixCommands(root)) {
      execFileSync("/bin/sh", ["-c", command], { env, stdio: "pipe" });
    }

    const settings = readSigningFrom(gitconfig);
    assert.equal(settings.commitGpgsign, "true");
    assert.equal(settings.tagGpgsign, "true");
    assert.equal(settings.format, "ssh");
    assert.equal(settings.signingKey, signingKeyPath(root));
    assert.equal(settings.allowedSignersFile, allowedSignersPath(root));
    assert.equal(auditSigning(settings, root).state, "ok", "the fix commands must satisfy the audit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the fix commands do not write to the store themselves", () => {
  // Pi Central reports and instructs; it does not rewrite a user-maintained tree (ADR-0010 §5). The
  // commands are data, so generating them must have no effect on disk.
  const root = mkdtempSync(join(tmpdir(), "pi-signing-inert-"));
  try {
    mkdirSync(join(root, "ssh"), { recursive: true });
    const gitconfig = join(root, "gitconfig");
    writeFileSync(gitconfig, BROKEN);
    signingFixCommands(root);
    assert.equal(readSigningFrom(gitconfig).commitGpgsign, "false", "generating commands must not write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Read settings through the file path, mirroring the capability assessment's route. */
function readSigningFrom(path: string) {
  return readSigning(readFileSync(path, "utf8"));
}
