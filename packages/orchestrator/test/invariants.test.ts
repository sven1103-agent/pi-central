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

test("Safehouse argv is assembled in exactly one module (ADR-0002)", () => {
  // If a second call site appears, "every session's grant set is derived from one function"
  // stops being true.
  const builders = files.filter((file) => {
    const text = readFileSync(file, "utf8");
    return text.includes('"--workdir"');
  });
  assert.deepEqual(
    builders.map((f) => relative(SRC, f)),
    ["policy.ts"],
    "Safehouse argv must only be assembled in policy.ts",
  );
});

test("the orchestrator never passes --add-dirs (ADR-0002)", () => {
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes("--add-dirs"), `${relative(SRC, file)} references --add-dirs`);
  }
});

test("wide-read is refused, never enabled", () => {
  const policy = readFileSync(join(SRC, "policy.ts"), "utf8");
  assert.match(policy, /FORBIDDEN_ENABLE/);
  assert.match(policy, /wide-read/);
});

test("no source file uses shell interpolation for a spawn (fixed binaries only)", () => {
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes("shell: true"), `${relative(SRC, file)} uses shell: true`);
    assert.ok(!text.includes("exec("), `${relative(SRC, file)} uses exec(`);
    assert.ok(!text.includes("execSync("), `${relative(SRC, file)} uses execSync(`);
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
