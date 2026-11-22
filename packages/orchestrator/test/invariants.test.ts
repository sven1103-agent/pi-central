/**
 * Architectural invariant tests.
 *
 * These do not test behavior; they test that the *shape* of the code still matches the
 * decisions. They exist because these particular mistakes are silent: nothing fails at
 * runtime when the orchestrator starts importing Pi's agent core, or when a second call site
 * starts assembling Safehouse argv. The guarantee just quietly stops being true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const files = sourceFiles(SRC);

test("the orchestrator imports no Pi runtime value -- only `import type` (ADR-0005, ADR-0009)", () => {
  // Loading Pi's agent core into the unsandboxed orchestrator would contradict ADR-0002:
  // it is safe because it is small and holds no untrusted content.
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.includes("@earendil-works/pi-coding-agent")) continue;
      const trimmed = line.trim();
      // Allowed: a type-only import, or a mention inside a comment.
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
      if (trimmed.startsWith("import type")) continue;
      offenders.push(`${relative(SRC, file)}: ${trimmed}`);
    }
  }
  assert.deepEqual(offenders, [], `value imports of Pi found:\n${offenders.join("\n")}`);
});

test("Safehouse argv is assembled in exactly two modules, one per sandbox kind (ADR-0002, ADR-0015)", () => {
  // If a third call site appears, "every session's grant set is derived from one function" stops being true.
  //
  // The second entry is deliberate and narrow: ADR-0015 adds a sidecar that is a SIBLING sandbox, not a
  // session (C1 makes nesting impossible). It is a separate assembler precisely so it cannot inherit a
  // session's grants — it takes no `cwd`, has a constant feature set, and renders its fragment from the
  // shared denies. The pairing is asserted below rather than left to a comment.
  const builders = files.filter((file) => {
    const text = readFileSync(file, "utf8");
    return text.includes('"--workdir"');
  });
  assert.deepEqual(
    builders.map((f) => relative(SRC, f)).sort(),
    ["policy.ts", "sidecar-policy.ts"],
    "Safehouse argv must be assembled only by the session assembler and the sidecar assembler",
  );
});

test("the two assemblers cannot produce each other's argv (ADR-0015)", () => {
  // The risk a second assembler introduces is not duplication, it is INHERITANCE: a helper shared by both
  // would let a sidecar grant reach a session or a session's workdir reach the renderer. So each module
  // must name only its own concerns.
  // Comments stripped first. C20 records this defect: a guard string that also appears in the comment
  // explaining the guard makes the assertion fire on correct code (and, worse, can make it pass on broken
  // code). "the sidecar must not borrow the session assembler" matched the prose saying so.
  const code = (file: string): string =>
    readFileSync(join(SRC, file), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
  const session = code("policy.ts");
  const sidecar = code("sidecar-policy.ts");

  // A session can never be given a Chromium feature (see FORBIDDEN_ENABLE, which now closes them).
  assert.match(session, /playwright-chrome/, "policy.ts must name the browser features it refuses");
  // The sidecar never reads a workdir from its caller: no `cwd` in its spec, no `--workdir` argument value
  // derived from one. Asserted structurally — the spec has no such field.
  assert.ok(!/cwd\??:\s*string/.test(sidecar), "the sidecar spec must have no cwd parameter");
  assert.ok(!sidecar.includes("composePolicy"), "the sidecar must not borrow the session assembler");
  assert.ok(!session.includes("composeSidecarPolicy"), "a session must not borrow the sidecar assembler");
});

test("a SESSION is never given --add-dirs or --add-dirs-ro (ADR-0002)", () => {
  // The original assertion was a bare substring check over every source file, so it could not tell
  // `--add-dirs` (read-WRITE) from `--add-dirs-ro` (read-only) and it fired the moment the sidecar needed a
  // read-only grant for its own code. Fixing it by loosening the pattern would have lost the protection; this
  // fixes it by asking the right question.
  //
  // The rule ADR-0002 states is about SESSIONS: a session's grant set derives from its workdir, and a
  // hand-added directory is exactly the union that ADR exists to prevent. A sidecar is a sibling with a fixed,
  // narrow purpose and no model in it, and it is the only assembler allowed the read-only form.
  const session = readFileSync(join(SRC, "policy.ts"), "utf8");
  for (const flag of ["--add-dirs", "--add-dirs-ro"]) {
    assert.ok(!session.includes(flag), `policy.ts must not reference ${flag}`);
  }

  // Everywhere else, the read-WRITE form stays forbidden outright.
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const name = relative(SRC, file);
    assert.ok(!/--add-dirs(?!-ro)/.test(text), `${name} references --add-dirs (read-write)`);
  }

  // And the read-only form may appear ONLY in the sidecar assembler, which grants its own code.
  const roUsers = files.filter((file) => readFileSync(file, "utf8").includes("--add-dirs-ro"));
  assert.deepEqual(
    roUsers.map((file) => relative(SRC, file)).sort(),
    ["sidecar-policy.ts"],
    "only the sidecar may take a read-only extra directory",
  );
});

test("wide-read is refused, never enabled", () => {
  const policy = readFileSync(join(SRC, "policy.ts"), "utf8");
  assert.match(policy, /FORBIDDEN_ENABLE/);
  assert.match(policy, /wide-read/);
});

test("no source file uses shell interpolation for a spawn (fixed binaries only)", () => {
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const name = relative(SRC, file);
    assert.ok(!text.includes("shell: true"), `${name} uses shell: true`);

    // Match the *child_process* calls, not `RegExp.prototype.exec`. A bare substring check for "exec("
    // also fires on `/pattern/.exec(line)`, which is a regex match with no shell and no subprocess, so it
    // would be a false positive that trains people to ignore this test.
    //
    // That paragraph was here and the check still had the bug it described: `\bexec(...)` matches
    // `/rgba?(...)/.exec(c)`, and it fired on the contrast measurement the moment one was written in a file
    // that also imports child_process. The call must be a STATEMENT-level import binding — i.e. preceded by
    // nothing that makes it a method call — so a leading `.` excludes `.exec(` and `x.exec(`.
    const importsChildProcess = /from "node:child_process"/.test(text);
    const shellCall = /(?<![.\w])exec(File|FileSync|Sync)?\s*\(/.test(text);
    assert.ok(
      !(importsChildProcess && shellCall),
      `${name} uses a child_process exec call; spawn a fixed binary with spawn() instead`,
    );
  }
});

test("the framing module never uses readline (C7)", () => {
  // Check imports and calls, not prose: the file's comment explains *why* readline is
  // banned, and naming it there is the point of the comment.
  const framing = readFileSync(join(SRC, "framing.ts"), "utf8");
  for (const line of framing.split("\n")) {
    const code = line.trim();
    if (code.startsWith("*") || code.startsWith("//")) continue;
    assert.ok(!/from "node:readline/.test(code), `readline imported: ${code}`);
    assert.ok(!/\bcreateInterface\s*\(/.test(code), `createInterface used: ${code}`);
  }
});

test("only the framing module splits the RPC stdout stream on newlines (C7)", () => {
  // A stray split over Pi's stdout elsewhere would reintroduce the readline bug (U+2028/
  // U+2029 inside a JSON string). Splitting *stderr* for display is fine, so this checks
  // that any newline split is not applied to stdout -- by looking for the offending pairing
  // on the same line, or in a file that reads stdout at all without going through framing.
  const offenders: string[] = [];
  for (const file of files) {
    const name = relative(SRC, file);
    if (name === "framing.ts" || name === "registry.ts") continue; // framing owns it; registry parses files
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const code = line.trim();
      if (code.startsWith("*") || code.startsWith("//")) continue;
      if (code.includes("stdout") && /split\(/.test(code)) offenders.push(`${name}: ${code}`);
    }
  }
  assert.deepEqual(offenders, [], `stdout split outside framing.ts:\n${offenders.join("\n")}`);
});

test("rpc.send takes the closed Command union, not any object with a type", () => {
  // The union was documented as "closed, on purpose" while `send` accepted
  // `{ type: string } & Record<string, unknown>`, which made it decorative: a typo compiled and
  // failed only at runtime. Making it binding immediately found TWO commands the supervisor and
  // the verifier were calling without the union ever listing them (`get_messages`,
  // `get_available_models`).
  const source = readFileSync(new URL("../src/rpc.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /send\(command:\s*Command\b/,
    "send must take the Command union, or a mistyped command silently no-ops at runtime",
  );
  assert.ok(
    !/send\(command:\s*\{\s*type:\s*string\s*\}/.test(source),
    "send must not accept an arbitrary { type: string }",
  );
});

test("every command the supervisor sends is in the closed union", () => {
  // A cheap proxy for the type check: if the union loses a member, `send` calls for it become
  // compile errors — but this also catches a command being sent through `write` instead.
  const supervisor = readFileSync(new URL("../src/supervisor.ts", import.meta.url), "utf8");
  const protocol = readFileSync(
    new URL("../../protocol/src/pi.ts", import.meta.url),
    "utf8",
  );
  const sent = [...supervisor.matchAll(/\.send\(\{\s*type:\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  assert.ok(sent.length > 0, "expected the supervisor to send commands");
  for (const command of new Set(sent)) {
    assert.ok(
      new RegExp(`type:\\s*"${command}"`).test(protocol),
      `the supervisor sends "${command}" but the Command union does not list it`,
    );
  }
});

/**
 * Every `security` subcommand this codebase must never run.
 *
 * `show-keychain-info` reads settings and nothing else, and it is the only verb the probe uses. The list
 * below is a PROHIBITION rather than a preference: C13 and ADR-0010 §6 forbid Pi Central from creating a
 * keychain, unlocking one with a stored password, or writing the user-wide search list. Creating a keychain
 * has been observed to drop `login.keychain-db` from that list and break the user's own shell access, so the
 * prior art needed a restore trap to survive it — this code must not need one because it must not do it.
 *
 * `unlock-keychain` is prohibited even in its argument-free, prompting form. Any keychain read already
 * raises the dialog Pi Central needs (issue #269), so the verb buys nothing, and `-p` would mean a stored
 * password: a credential worse than the one it protects. Neither is worth leaving available to a future
 * "convenience" fix.
 */
const FORBIDDEN_SECURITY_VERBS = [
  "create-keychain",
  "delete-keychain",
  "unlock-keychain",
  "lock-keychain",
  "set-keychain-settings",
  "set-keychain-password",
  "list-keychains",
  "default-keychain",
  "login-keychain",
  "add-generic-password",
  "delete-generic-password",
  "set-generic-password-partition-list",
];

test("nothing in the orchestrator mutates a keychain or the search list (C13, ADR-0010 §6)", () => {
  // Asserted over the SOURCE, because the failure this prevents is a future edit that looks helpful: a
  // "just unlock it for me" branch, or a search-list repair for an absent keychain. Both would be invisible
  // to a test that only exercised the happy path.
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const code = line.trim();
      // Comments may NAME the prohibited commands — `keychain.ts` explains why they are forbidden, and a scan
      // that failed on prose would be turned off instead of read.
      if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
      for (const verb of FORBIDDEN_SECURITY_VERBS) {
        // A quoted literal, i.e. an argument actually being built: `"unlock-keychain"` or `'unlock-keychain'`.
        // Prose and identifiers do not match.
        if (new RegExp(`["'\`]${verb}["'\`]`).test(code)) offenders.push(`${relative(SRC, file)}: ${code}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `a keychain-mutating command was found:\n${offenders.join("\n")}`);
});

test("the keychain probe builds exactly one verb, and it is the read-only one", () => {
  // The scan above proves nothing FORBIDDEN is used; this proves the one command that IS used cannot grow into
  // one that mutates. Both halves are needed: a probe that gained a second verb would pass a denylist.
  const keychain = readFileSync(join(SRC, "keychain.ts"), "utf8");
  const argv = /export function keychainProbeArgv\(path: string\): string\[\] \{\s*return \[([^\]]*)\]/.exec(keychain);
  assert.ok(argv, "keychainProbeArgv must exist and return a literal array");
  const literals = [...argv[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  assert.equal(literals.length, 1, `exactly one verb literal is allowed, found ${JSON.stringify(literals)}`);
  assert.equal(literals[0], "show-keychain-info", "the only verb may be the read-only one");
});

test("keychain code never passes a password on a command line", () => {
  // `security … -p <password>` would put a credential in an argv, which is the class of exposure ADR-0010's
  // storage layer exists to avoid. Asserted separately because it is a one-character difference.
  const keychain = readFileSync(join(SRC, "keychain.ts"), "utf8");
  for (const line of keychain.split("\n")) {
    const code = line.trim();
    if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
    assert.ok(!/["']-p["']/.test(code), `a password flag appears in code: ${code}`);
  }
});
