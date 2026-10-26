import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { renderPolicyFragment } from "../src/fragment.ts";

/**
 * The `~/.ssh` boundary, evaluated against a **real composed Safehouse policy** (issue #46).
 *
 * ## Why this file exists
 *
 * `fragment.test.ts` asserts the fragment's *text*: it checks that a deny naming `~/.ssh` is
 * emitted. That is necessary and not sufficient, because the previous, broken version passed an
 * assertion of exactly that shape — it named `~/.ssh/agent` and three key patterns, so a test
 * looking for "a deny under ~/.ssh" was satisfied while `cupserver`, `jenkins` and
 * `sven1103-agent-strongbox` stayed readable.
 *
 * The defect was not in the fragment's text. It was in the **composition**: the base policy emits
 * `(allow file-read* file-write* (subpath HOME))` as the workdir grant, and for a session whose cwd
 * is `$HOME` that grant covers the entire home directory. Whether a path is reachable is decided by
 * the whole composed policy, in order, so that is what this test asks.
 *
 * ## What it does
 *
 * Composes the real fragment through the installed `safehouse` (the same `--append-profile` path a
 * session takes) and evaluates the emitted SBPL for two workdirs — a project directory, and
 * `$HOME` — asserting that `~/.ssh` is denied in both. `$HOME` is the case the name patterns got
 * wrong, so it is the case that must be stated rather than assumed.
 *
 * Skips when `safehouse` is not installed (C10: macOS-only). The skip is deliberate and is
 * reported, rather than silently passing: on Linux this proves nothing about composition.
 */

const SAFEHOUSE = process.env["PI_CENTRAL_SAFEHOUSE"] ?? "safehouse";

function haveSafehouse(): boolean {
  try {
    execFileSync(SAFEHOUSE, ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const canCompose = haveSafehouse();
const home = homedir();
const agentRoot = join(home, ".agent");

const dir = mkdtempSync(join(tmpdir(), "pi-central-ssh-boundary-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// Safehouse refuses a workdir that does not exist, so the project-directory case needs one. The
// `$HOME` case needs nothing: it is the point of that case.
const work = join(dir, "work");
mkdirSync(work, { recursive: true });

/**
 * Compose a policy the way a session does, and return its text.
 *
 * `--stdout` rather than executing: C1 (Seatbelt does not nest) means applying a policy fails in a
 * development sandbox for *any* profile, so execution is not available to assert on. Printing is,
 * and it is the artifact that decides reachability.
 */
function compose(workdir: string): string {
  const fragment = join(dir, "fragment.sb");
  writeFileSync(
    fragment,
    renderPolicyFragment({
      agentRoot,
      keychain: true,
      keychainPath: join(agentRoot, "agent.keychain-db"),
    }),
  );
  return execFileSync(
    SAFEHOUSE,
    ["--workdir", workdir, `--append-profile=${fragment}`, "--stdout"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
}

interface Rule {
  kind: "allow" | "deny";
  ops: string[];
  filters: { kind: string; value: string }[];
}

/**
 * Parse the composed policy into ordered rules, by matching parentheses.
 *
 * Paren matching rather than line-by-line, because Safehouse emits both forms and the difference is
 * load-bearing here:
 *
 *     (allow file-read* file-write* (subpath "/Users/x"))          <- one line
 *     (deny file-read*\n    (home-subpath "/.ssh")\n)               <- several
 *
 * The first is the **workdir grant** — the grant the old name patterns failed to override — so a
 * parser that silently dropped single-line rules would have reported the bug as fixed while never
 * reading the rule that caused it.
 *
 * `HOME_DIR` is expanded through the same `home-*` helpers the policy defines for itself, so the
 * policy is read as SBPL means it rather than as a string search would.
 */
function parse(policy: string): Rule[] {
  const rules: Rule[] = [];
  const text = policy
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(";;"))
    .join("\n");

  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("(", index);
    if (start === -1) break;
    const head = /^\((allow|deny)\s+((?:[\w*-]+\s*)+)/.exec(text.slice(start, start + 200));
    if (head === null) {
      index = start + 1;
      continue;
    }
    // Walk to the matching close paren for this form.
    let depth = 0;
    let end = start;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const form = text.slice(start, end + 1);
    const filters = [
      ...form.matchAll(/\((home-subpath|home-literal|home-prefix|subpath|literal|prefix)\s+"([^"]*)"\)/g),
    ].map((m) => ({
      kind: m[1]!.replace(/^home-/, ""),
      value: m[1]!.startsWith("home-") ? join(home, m[2]!) : m[2]!,
    }));
    rules.push({ kind: head[1] as "allow" | "deny", ops: head[2]!.trim().split(/\s+/), filters });
    index = end + 1;
  }
  return rules;
}

/** Does any filter in `rule` cover `path`? */
function covers(rule: Rule, path: string): boolean {
  return rule.filters.some(({ kind, value }) => {
    if (kind === "literal") return path === value;
    if (kind === "prefix") return path.startsWith(value);
    // subpath: the directory itself, or anything under it — by SEGMENT, so ~/.ssh-other is out.
    return path === value || path.startsWith(`${value}/`);
  });
}

/**
 * The effective decision for `path`, under SBPL's rule resolution.
 *
 * Last matching rule wins. This is the property that makes the fragment able to tighten the base
 * policy at all, and the reason the workdir grant above can be overridden.
 *
 * Operations are matched the way SBPL does: `file-read*` subsumes `file-read-data` and
 * `file-read-metadata`, while the `file-read-metadata` form matches only itself.
 */
function decides(policy: Rule[], path: string, op: string): "allow" | "deny" {
  let decision: "allow" | "deny" = "deny"; // (deny default)
  for (const rule of policy) {
    const matchesOp = rule.ops.some((candidate) => {
      if (candidate.endsWith("*")) return op.startsWith(candidate.slice(0, -1));
      return candidate === op;
    });
    if (matchesOp && covers(rule, path)) decision = rule.kind;
  }
  return decision;
}

test("Safehouse composes our fragment, so the boundary can be evaluated", { skip: !canCompose }, () => {
  const text = compose(work);  assert.match(text, /Pi Central — appended policy fragment/, "the fragment must be appended");
  assert.match(text, /\(deny default\)/, "the base policy is deny-by-default");
  // The grant this whole test exists for. Stated on the `$HOME` composition, because that is the
  // case the name patterns got wrong: the base's workdir grant is a **single-line** rule covering
  // whatever directory was chosen, so for `$HOME` it reaches all of `~/.ssh` and a deny is the only
  // thing that can override it. If this ever stops being true, the finding's premise changed.
  const atHome = parse(compose(home));
  assert.ok(
    atHome.some(
      (rule) =>
        rule.kind === "allow" &&
        rule.ops.includes("file-read*") &&
        covers(rule, join(home, ".ssh", "cupserver")),
    ),
    "the base must grant the whole workdir, which includes ~/.ssh when the workdir is $HOME",
  );
});

for (const [label, workdir] of [
  ["a project directory", () => work],
  ["$HOME itself — the case the key-name patterns got wrong", () => home],
] as const) {
  test(`every path under ~/.ssh is denied when the workdir is ${label}`, { skip: !canCompose }, () => {
    const policy = parse(compose(workdir()));

    const paths = [
      "config",
      "known_hosts",
      "allowed_signers",
      "id_rsa",
      // The three real private keys the old name list did not cover. Under a $HOME workdir each
      // was readable; these are the falsifiers, so they are named individually rather than
      // represented by a single "a key" case.
      "cupserver",
      "jenkins",
      "sven1103-agent-strongbox",
      "agent/s.abc",
    ];
    for (const relative of paths) {
      assert.equal(
        decides(policy, join(home, ".ssh", relative), "file-read-data"),
        "deny",
        `~/.ssh/${relative} must be denied`,
      );
      assert.equal(
        decides(policy, join(home, ".ssh", relative), "file-write-data"),
        "deny",
        `~/.ssh/${relative} must not be writable`,
      );
    }

    // Listing the directory is how the session discovered the key names in the first place.
    assert.equal(decides(policy, join(home, ".ssh"), "file-read-data"), "deny", "~/.ssh must not be listable");
    assert.equal(decides(policy, join(home, ".ssh"), "file-read-metadata"), "deny", "~/.ssh must not be statable");
  });
}

test("the agent's own ssh tree stays reachable in the composed policy", { skip: !canCompose }, () => {
  // The other half of the claim, and the reason the fix does not break git-over-SSH: closing the
  // host's directory must not close the agent's. If this fails the fix is a capability regression,
  // not a hardening.
  const policy = parse(compose(work));
  for (const path of [
    join(agentRoot, "ssh", "config"),
    join(agentRoot, "ssh", "github_login_ed25519"),
    join(agentRoot, "ssh", "known_hosts"),
    join(agentRoot, "ssh", "allowed_signers"),
    join(agentRoot, "ssh", "ssh-github.sh"),
  ]) {
    assert.equal(decides(policy, path, "file-read-data"), "allow", `${path} must stay readable`);
  }
});
