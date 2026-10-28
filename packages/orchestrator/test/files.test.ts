/**
 * Reading a session's working directory (ADR-0007, issue #8).
 *
 * The privilege here is the **user's**, so the containment check is the entire feature: these
 * functions are the only thing between a path from the browser and the rest of the disk. Every
 * refusal is therefore tested as a refusal, and — the part that matters more — each is paired with
 * a case that must still **succeed**, because a check that refuses too much is a bug the negative
 * tests alone cannot see.
 *
 * Fixtures live under a `mkdtemp` directory rather than `/tmp` directly, and the symlink tests build
 * their own trees: a symlink escape cannot be tested without a real symlink, and one pointing at a
 * fixture sibling is both reproducible and safe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BINARY_SNIFF_BYTES,
  MAX_FILE_BYTES,
  containsPath,
  formatBytes,
  isHidden,
  listDirectory,
  normalizeRelative,
  readFileText,
  resolveWithin,
} from "../src/files.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-central-files-")));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

/** A fresh root per test, so one test's fixtures cannot affect another's assertions. */
function makeRoot(name: string): string {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  return root;
}

function write(dir: string, relative: string, contents: string | Buffer, mode?: number): string {
  const full = join(dir, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
  if (mode !== undefined) chmodSync(full, mode);
  return full;
}

// --- containsPath: segments, not prefixes ---------------------------------------------------------

test("containment is compared by SEGMENTS, so a prefix-named sibling is not inside", () => {
  // A bare `startsWith` gets this wrong, and this repository has already been bitten by it once
  // (`own-installation.ts`, issue #25). `readme.md` is not inside `read`. ADR-0007 forbids prefix
  // comparison for exactly this class of reason.
  assert.equal(containsPath("/a/b", "/a/bc"), false);
  assert.equal(containsPath("/a/b", "/a/b"), true);
  assert.equal(containsPath("/a/b", "/a/b/c"), true);
  assert.equal(containsPath("/a/b", "/a"), false);
});

// --- resolveWithin: the `..` escape ---------------------------------------------------------------

test("a `..` segment that stays inside the tree is allowed", () => {
  // The falsifier for the escape test below: refusing `..` outright would break a legitimate
  // parent traversal, so "escapes" must mean "leaves the root", not "contains a dotdot".
  const root = makeRoot("dotdot-inside");
  write(root, "a/c.txt", "hello");
  mkdirSync(join(root, "a/b"), { recursive: true });
  const result = resolveWithin(root, "a/b/../c.txt");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.relPath, "a/b/../c.txt");
  // And it actually reads, which is the property that matters: a normalized relPath alone would
  // not show that the resolved path is usable.
  assert.equal(readFileText(root, "a/b/../c.txt").ok, true);
});

test("an escape that does not exist is still reported as an ESCAPE, not as missing", () => {
  // The lexical containment check earns its place here rather than in the verdict above. `realpath`
  // also resolves `..`, so an escaping path that EXISTS is refused by either check — but a path
  // that does not exist would fail at `realpath` with ENOENT and be reported as `not-found`,
  // describing the child instead of the escape and sending the reader to the wrong fix. Same shape
  // as a permission error reported as a missing directory (C14's neighbourhood).
  const root = makeRoot("escape-missing");
  for (const attempt of ["../nope.txt", "../nope/deep.txt", "sub/../../nope.txt"]) {
    const result = resolveWithin(root, attempt);
    assert.equal(result.ok, false, `${attempt} must be refused`);
    if (!result.ok) {
      assert.equal(result.error.reason, "escapes-cwd", `${attempt} must read as an escape`);
    }
  }
});

test("a `..` segment that leaves the tree is refused", () => {
  const root = makeRoot("dotdot-outside");
  const sibling = write(base, "dotdot-outside-secret.txt", "SECRET");
  assert.ok(sibling.endsWith("dotdot-outside-secret.txt"));

  for (const attempt of ["../dotdot-outside-secret.txt", "../../etc/passwd", "a/../../x"]) {
    const result = resolveWithin(root, attempt);
    assert.equal(result.ok, false, `${attempt} must be refused`);
    if (!result.ok) assert.equal(result.error.reason, "escapes-cwd");
  }
});

test("an absolute path is refused rather than interpreted", () => {
  // The UI deals only in paths relative to the session's cwd. An absolute path means a caller is
  // confused, and "it happened to be inside the root" would be a coincidence rather than a
  // guarantee — so it is a distinct failure from an escape, with its own reason.
  const root = makeRoot("absolute");
  write(root, "inside.txt", "hello");
  const result = resolveWithin(root, join(root, "inside.txt"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.reason, "absolute-path");
});

test("a NUL byte in the path is refused as INVALID, not as an escape", () => {
  // The reason is pinned deliberately. This test previously asserted only that the call was refused,
  // so a NUL reported as `escapes-cwd` passed while telling the user the path was "outside the working
  // directory" — a place it never reached. A NUL is malformed input, and the two need different fixes.
  const root = makeRoot("nul");
  const result = resolveWithin(root, "a\0b");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.reason, "invalid-path");
    assert.match(result.error.message, /NUL/);
  }
  // A non-string is the same class of failure, and must not crash either.
  assert.equal(resolveWithin(root, undefined as unknown as string).ok, false);
});

// --- resolveWithin: the symlink escape ------------------------------------------------------------

test("a symlink pointing OUTSIDE the tree is refused", () => {
  // ADR-0007 guardrail 2, and the reason `realpath` runs BEFORE the containment check: the link
  // itself is inside the tree, so a check on the requested path alone would pass it.
  const root = makeRoot("symlink-out");
  write(base, "symlink-out-secret.txt", "SECRET");
  symlinkSync(join(base, "symlink-out-secret.txt"), join(root, "escape.txt"));

  const result = resolveWithin(root, "escape.txt");
  assert.equal(result.ok, false, "a symlink out of the tree must be refused");
  if (!result.ok) assert.equal(result.error.reason, "escapes-cwd");
});

test("a symlinked DIRECTORY pointing outside is refused, so it cannot be walked into", () => {
  const root = makeRoot("symlink-dir-out");
  mkdirSync(join(base, "symlink-dir-out-secret"), { recursive: true });
  write(base, "symlink-dir-out-secret/creds.txt", "SECRET");
  symlinkSync(join(base, "symlink-dir-out-secret"), join(root, "escape-dir"));

  const result = resolveWithin(root, "escape-dir/creds.txt");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.reason, "escapes-cwd");
});

test("a symlink pointing INSIDE the tree still works", () => {
  // The falsifier for both cases above. Refusing every symlink would be a regression: a link to a
  // real file in the same project is ordinary, and the safety property is about the TARGET.
  const root = makeRoot("symlink-in");
  write(root, "real.txt", "hello");
  symlinkSync(join(root, "real.txt"), join(root, "link.txt"));

  const result = resolveWithin(root, "link.txt");
  assert.equal(result.ok, true, "a symlink inside the tree must be usable");
  if (result.ok) assert.equal(readFileText(root, "link.txt").ok, true);
});

test("a symlinked cwd is handled: the root resolves before containment is checked", () => {
  // Ordinary on macOS, where `/tmp` is a symlink to `/private/tmp`. If containment were checked
  // against the UN-resolved root, every path under it would be refused.
  const real = makeRoot("root-real");
  write(real, "file.txt", "hello");
  const link = join(base, "root-link");
  symlinkSync(real, link);

  const result = readFileText(link, "file.txt");
  assert.equal(result.ok, true, "a session whose cwd is a symlink must still be usable");
});

// --- listDirectory --------------------------------------------------------------------------------

test("listing returns directories first, then names case-insensitively", () => {
  const root = makeRoot("sorting");
  write(root, "zeta.txt", "z");
  mkdirSync(join(root, "alpha"));
  write(root, "Beta.txt", "b");
  mkdirSync(join(root, "gamma"));

  const result = listDirectory(root, "");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.value.entries.map((e) => e.name),
    ["alpha", "gamma", "Beta.txt", "zeta.txt"],
  );
  assert.equal(result.value.entries[0]!.kind, "directory");
});

test("hidden files are omitted by default and included on request", () => {
  const root = makeRoot("hidden");
  write(root, ".env", "SECRET=1");
  write(root, "visible.txt", "hello");

  const hidden = listDirectory(root, "");
  assert.equal(hidden.ok, true);
  if (hidden.ok) assert.deepEqual(hidden.value.entries.map((e) => e.name), ["visible.txt"]);

  const shown = listDirectory(root, "", { includeHidden: true });
  assert.equal(shown.ok, true);
  if (shown.ok) {
    assert.deepEqual(shown.value.entries.map((e) => e.name).sort(), [".env", "visible.txt"]);
    // Each entry says it is hidden, so the tree can style it without re-deriving the rule.
    assert.equal(shown.value.entries.find((e) => e.name === ".env")!.hidden, true);
    assert.equal(shown.value.entries.find((e) => e.name === "visible.txt")!.hidden, false);
  }
});

test("a listing is capped and SAYS it was capped, rather than silently ending", () => {
  // A tree that quietly stopped at 2000 entries would read as a directory that holds 2000 entries.
  const root = makeRoot("capped");
  for (let i = 0; i < 12; i += 1) write(root, `f${String(i).padStart(2, "0")}.txt`, "x");

  const result = listDirectory(root, "", { limit: 5 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.entries.length, 5);
  assert.equal(result.value.truncated, true, "the truncation must be reported, not implied");

  const all = listDirectory(root, "", { limit: 100 });
  assert.equal(all.ok, true);
  if (all.ok) assert.equal(all.value.truncated, false);
});

test("a symlink is reported as a symlink, not as whatever it points at", () => {
  // `lstat`, not `stat`. The tree must be able to show that an entry is a link, and a directory
  // listing that reported the target's type would hide the thing a reader needs to know.
  const root = makeRoot("entry-kinds");
  write(root, "file.txt", "x");
  mkdirSync(join(root, "dir"));
  symlinkSync(join(root, "file.txt"), join(root, "link"));

  const result = listDirectory(root, "");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const kind = (name: string) => result.value.entries.find((e) => e.name === name)?.kind;
  assert.equal(kind("file.txt"), "file");
  assert.equal(kind("dir"), "directory");
  assert.equal(kind("link"), "symlink");
});

test("a symlink also reports what it POINTS AT, so a directory link can be entered", () => {
  // `kind` alone is not enough: a UI that saw only `symlink` would treat every link as a file, so
  // clicking a `docs -> ../docs` link would issue a read for a directory and surface "That is a
  // directory" — true and useless. `linkTarget` is a description (`stat`, following), NOT a safety
  // decision: `resolveWithin` still refuses to enter a link whose target leaves the root.
  const root = makeRoot("link-targets");
  write(root, "file.txt", "x");
  mkdirSync(join(root, "dir"));
  symlinkSync(join(root, "file.txt"), join(root, "to-file"));
  symlinkSync(join(root, "dir"), join(root, "to-dir"));
  symlinkSync(join(root, "nowhere"), join(root, "dangling"));

  const result = listDirectory(root, "");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const target = (name: string) => result.value.entries.find((e) => e.name === name)?.linkTarget;
  assert.equal(target("to-file"), "file");
  assert.equal(target("to-dir"), "directory");
  // A dangling link is a fact to show, not a read error: the entry exists, only its target does not.
  assert.equal(target("dangling"), "missing");
  // A real entry has no `linkTarget` at all, so the UI cannot mistake one for a link.
  assert.equal(result.value.entries.find((e) => e.name === "dir")?.linkTarget, undefined);
});

test("a symlinked directory INSIDE the tree is enterable, so linkTarget is not a refusal", () => {
  // Pairs with the escape test in `resolveWithin`: the same `linkTarget: "directory"` describes a
  // link that may or may not be reachable. Reachability is decided on entry, so a link to a sibling
  // directory inside the root must actually work.
  const root = makeRoot("link-inside");
  mkdirSync(join(root, "real"));
  write(root, "real/inner.txt", "deep");
  symlinkSync(join(root, "real"), join(root, "alias"));

  const result = listDirectory(root, "alias");
  assert.equal(result.ok, true, "a link to a directory inside the root must be listable");
  if (!result.ok) return;
  assert.deepEqual(
    result.value.entries.map((e) => e.name),
    ["inner.txt"],
  );
});

test("listing a file reports ENOTDIR rather than pretending it is empty", () => {
  const root = makeRoot("list-a-file");
  write(root, "file.txt", "x");
  const result = listDirectory(root, "file.txt");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.reason, "not-a-directory");
});

test("listing a missing directory reports ENOENT with its code", () => {
  const root = makeRoot("list-missing");
  const result = listDirectory(root, "nope");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.reason, "not-found");
    assert.equal(result.error.code, "ENOENT");
    assert.match(result.error.message, /ENOENT/);
  }
});

// --- readFileText ---------------------------------------------------------------------------------

test("a text file is returned byte-for-byte", () => {
  const root = makeRoot("read-text");
  const body = "line one\nline two\n";
  write(root, "a.txt", body);
  const result = readFileText(root, "a.txt");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.text, body);
    assert.equal(result.value.bytes, Buffer.byteLength(body));
    assert.equal(result.value.path, "a.txt");
  }
});

test("an EMPTY file is text, not binary", () => {
  // The falsifier for the NUL sniff: an empty buffer contains no NUL byte, so a check written as
  // "does it contain a NUL" is fine — but a check written as "does the first byte look like text"
  // would refuse this. An empty file is ordinary and must read.
  const root = makeRoot("read-empty");
  write(root, "empty.txt", "");
  const result = readFileText(root, "empty.txt");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.text, "");
});

test("a file above the size cap is REFUSED, not truncated", () => {
  // The issue is explicit: "says so rather than truncating silently". A partial view would be a
  // wrong answer to "what is in this file", and the message names both sizes so the reader can
  // judge what to do.
  const root = makeRoot("read-large");
  write(root, "big.txt", "x".repeat(MAX_FILE_BYTES + 1));
  const result = readFileText(root, "big.txt");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.reason, "too-large");
    assert.match(result.error.message, /256\.0 KB/);
    assert.match(result.error.message, /not read/);
  }
});

test("a file exactly at the cap is read", () => {
  // Boundary, stated so the comparison cannot drift from `>` to `>=` unnoticed.
  const root = makeRoot("read-at-cap");
  write(root, "exact.txt", "x".repeat(MAX_FILE_BYTES));
  assert.equal(readFileText(root, "exact.txt").ok, true);
});

test("a binary file is refused — by NUL bytes AND by invalid UTF-8", () => {
  // Two detections, because either alone misses a class. A PNG has NUL bytes in its header; a
  // Latin-1 text file does not, and only the strict decode catches that one. The decode is also
  // what prevents the "rendered as replacement characters" failure the issue names.
  const root = makeRoot("read-binary");
  write(root, "image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]));
  write(root, "latin1.txt", Buffer.from([0x48, 0x69, 0x20, 0xe9, 0x21])); // "Hi é!" in Latin-1

  for (const [file, why] of [
    ["image.png", /NUL/],
    ["latin1.txt", /UTF-8/],
  ] as const) {
    const result = readFileText(root, file);
    assert.equal(result.ok, false, `${file} must be refused`);
    if (!result.ok) {
      assert.equal(result.error.reason, "binary");
      assert.match(result.error.message, why);
    }
  }
});

test("NUL detection covers the head of the file, not just the first byte", () => {
  // The sniff window is what decides; a NUL at offset 100 in an otherwise text-looking file must
  // still be caught, and one beyond the window is a known limit rather than a silent success.
  const root = makeRoot("read-sniff-window");
  const body = Buffer.alloc(BINARY_SNIFF_BYTES);
  body.write("text", 0);
  body[100] = 0;
  write(root, "late-nul.bin", body);
  const result = readFileText(root, "late-nul.bin");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.reason, "binary");
});

test("reading a directory is refused as a directory, not as a generic failure", () => {
  const root = makeRoot("read-a-dir");
  mkdirSync(join(root, "sub"));
  const result = readFileText(root, "sub");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.reason, "is-directory");
});

test("an unreadable file reports PERMISSION with its errno, not 'missing'", () => {
  // The issue names this one specifically: a permission failure was once reported as a missing
  // directory elsewhere in this project. The two need different fixes, so the code is carried
  // through rather than flattened into a phrase.
  const root = makeRoot("read-permission");
  write(root, "locked.txt", "secret", 0o000);
  const result = readFileText(root, "locked.txt");
  // Root (and some CI containers) can read anything; the assertion is about the REPORT, not about
  // the permission model, so it is skipped rather than made flaky.
  if (result.ok) {
    assert.ok(process.getuid?.() === 0, "only root should be able to read a 000 file");
    return;
  }
  assert.equal(result.error.reason, "permission");
  assert.match(String(result.error.code), /^E(ACCES|PERM)$/);
  assert.match(result.error.message, /permission denied/);
  assert.notEqual(result.error.reason, "not-found");
});

test("reading through a symlink that escapes is refused", () => {
  const root = makeRoot("read-symlink-out");
  write(base, "read-symlink-out-secret.txt", "SECRET");
  symlinkSync(join(base, "read-symlink-out-secret.txt"), join(root, "escape.txt"));
  const result = readFileText(root, "escape.txt");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.reason, "escapes-cwd");
});

// --- helpers --------------------------------------------------------------------------------------

test("normalizeRelative collapses '.', empty segments and both separators", () => {
  assert.equal(normalizeRelative(""), "");
  assert.equal(normalizeRelative("."), "");
  assert.equal(normalizeRelative("./a//b/"), "a/b");
  assert.equal(normalizeRelative("a\\b"), "a/b");
});

test("normalizeRelative does NOT collapse '..', so an escape stays visible to the check", () => {
  // Deliberate: collapsing `..` here would resolve the path before containment is applied, which
  // is the opposite of what the guardrail wants. `resolve()` handles it, after the check.
  assert.equal(normalizeRelative("../x"), "../x");
  assert.equal(normalizeRelative("a/../../b"), "a/../../b");
});

test("isHidden is the dot convention", () => {
  assert.equal(isHidden(".env"), true);
  assert.equal(isHidden("env"), false);
  assert.equal(isHidden(".."), true);
});

test("formatBytes uses binary units a reader can judge", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(MAX_FILE_BYTES), "256.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

// --- #9's acceptance criteria, pinned --------------------------------------------------------------

test("a binary refusal names the file's SIZE, not just its name", () => {
  // Issue #9: "A binary file is reported as binary with its size and type, and is not attempted."
  // The size is knowable — `lstat` is consulted for the cap before the read — so withholding it
  // would be a choice rather than a limitation, and the reader cannot judge what they are looking at
  // without it.
  const root = makeRoot("binary-size");
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  writeFileSync(join(root, "image.png"), payload);

  const result = readFileText(root, "image.png");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.reason, "binary");
  assert.match(result.error.message, /10 B/, `the size must be named, got: ${result.error.message}`);
  assert.match(result.error.message, /NUL/, "…and WHY it was refused");
});

test("the same holds for a file refused by the UTF-8 decode", () => {
  // The second detection path. It has its own message, so it needs its own assertion — a test that
  // only covered the NUL branch would let the other regress.
  const root = makeRoot("binary-size-utf8");
  writeFileSync(join(root, "latin1.txt"), Buffer.from([0xff, 0xfe, 0x41, 0x42]));

  const result = readFileText(root, "latin1.txt");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.reason, "binary");
  assert.match(result.error.message, /4 B/, `the size must be named, got: ${result.error.message}`);
  assert.match(result.error.message, /UTF-8/);
});
