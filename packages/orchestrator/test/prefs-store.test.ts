/**
 * The reader's preferences live with the installation (issue #285).
 *
 * ## The defect these tests exist for
 *
 * Every preference was in `localStorage`, which a browser partitions **per origin**, and the desktop shell launches
 * the orchestrator with `--port 0` — so the window loaded `http://127.0.0.1:51234` on Monday and `…:61802` on
 * Tuesday. The write succeeded, the read returned `null`, and every parser correctly degraded to its default. The
 * reader's set of models was gone on every launch, and twelve keys went with it.
 *
 * ## What is asserted here, and what is asserted elsewhere
 *
 * This file covers the STORE: the file's shape, its atomicity, and the two rules that make it safe to put a
 * reader's settings on disk — a corrupt file is reported rather than read as "nothing chosen", and only what would
 * damage the store is filtered, so a value written by a newer build survives a downgrade.
 *
 * The other half of the issue is not on disk at all: that an ORIGIN is not an identity, so the same list must come
 * back through a different port. That is `prefs-store.test.ts` in `packages/ui`, which runs a round trip across
 * two stores with different seeds — the closest a unit test can get to two launches of the app (the acceptance
 * criterion's manual case needs a real relaunch, and it is recorded as such).
 *
 * ## Falsification
 *
 * Each test names the change that would break it, because a test that can only pass is not evidence:
 *
 *   - returning `{ ok: true, prefs: {} }` instead of `corrupt` fails "a corrupt file is a FAILURE, not an empty map";
 *   - dropping the `isPrefsKey`/typeof/drop-one-entry checks fails "one unusable entry is dropped, and the rest of
 *     the file is still read";
 *   - replacing temp-and-rename with a truncating `writeFileSync` fails "a write leaves no temporary file behind",
 *     which asserts the file is never a fragment;
 *   - replacing `acceptPrefs`' filtering with a whole-map refusal fails "a client's map is filtered, not refused";
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREFS_KEY_MAX,
  PREFS_VALUE_MAX,
  acceptPrefs,
  isPrefsKey,
  prefsPath,
  readPrefs,
  writePrefs,
} from "../src/prefs-store.ts";

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-central-prefs-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("nothing stored is an EMPTY map, not a failure", () => {
  // The distinction the whole feature rests on: a first run has no preferences, and saying that is not an error. A
  // failure here would have the UI announce a problem on every fresh installation.
  const { root, cleanup } = scratch();
  try {
    assert.deepEqual(readPrefs(root), { ok: true, prefs: {} });
  } finally {
    cleanup();
  }
});

test("a stored map round-trips", () => {
  const { root, cleanup } = scratch();
  try {
    const prefs = { "pi-central.model-scope": '{"models":[{"provider":"openai","id":"gpt-5"}]}' };
    assert.deepEqual(writePrefs(root, prefs), { ok: true });
    assert.deepEqual(readPrefs(root), { ok: true, prefs });
  } finally {
    cleanup();
  }
});

test("a write REPLACES the map, so a removal is expressible", () => {
  // A merge would make deleting a preference impossible: the key would come back from the file on the next read,
  // forever, with nothing able to say "this is gone now".
  const { root, cleanup } = scratch();
  try {
    writePrefs(root, { "pi-central.rail": "a", "pi-central.panel": "b" });
    writePrefs(root, { "pi-central.rail": "c" });
    assert.deepEqual(readPrefs(root), { ok: true, prefs: { "pi-central.rail": "c" } });
  } finally {
    cleanup();
  }
});

test("a corrupt file is a FAILURE, not an empty map", () => {
  // Reported rather than swallowed, because an empty map means "you have never chosen anything" — a false statement
  // about the reader's own settings — and because the next write would then replace whatever is actually there.
  const { root, cleanup } = scratch();
  try {
    mkdirSync(root, { recursive: true });
    for (const body of ["", "not json", "[]", "null", '{"version":2,"prefs":{}}', '{"version":1,"prefs":[]}']) {
      writeFileSync(prefsPath(root), body, "utf8");
      const read = readPrefs(root);
      assert.equal(read.ok, false, JSON.stringify(body));
      if (!read.ok) assert.equal(read.reason, "corrupt", JSON.stringify(body));
    }
  } finally {
    cleanup();
  }
});

test("one unusable entry is dropped, and the rest of the file is still read", () => {
  // A single stale key is not a reason to present the reader with none of their other settings. This is the
  // opposite decision from the one above, and the difference is what is being judged: the DOCUMENT parsed, and one
  // value inside it is wrong.
  const { root, cleanup } = scratch();
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      prefsPath(root),
      JSON.stringify({
        version: 1,
        prefs: {
          "pi-central.rail": "kept",
          "not ours/../etc": "dropped: a key this store will not keep",
          "pi-central.panel": 42,
          "pi-central.reading": "x".repeat(PREFS_VALUE_MAX + 1),
        },
      }),
      "utf8",
    );
    assert.deepEqual(readPrefs(root), { ok: true, prefs: { "pi-central.rail": "kept" } });
  } finally {
    cleanup();
  }
});

test("an unreadable file is reported as a failure with the path in it", () => {
  // A directory where the file should be is the cheapest way to produce a non-ENOENT read error in any environment.
  const { root, cleanup } = scratch();
  try {
    mkdirSync(prefsPath(root), { recursive: true });
    const read = readPrefs(root);
    assert.equal(read.ok, false);
    if (!read.ok) {
      assert.equal(read.reason, "unreadable");
      assert.match(read.message, /preferences\.json/);
    }
  } finally {
    cleanup();
  }
});

test("a write leaves no temporary file behind", () => {
  // The temp-and-rename pair exists because a crash mid-write on a truncating write leaves an EMPTY file, which reads
  // as "no preferences". What this asserts is the other half: the temporary is cleaned up by the rename, so a state
  // root does not accumulate one file per write.
  const { root, cleanup } = scratch();
  try {
    writePrefs(root, { "pi-central.rail": "a" });
    writePrefs(root, { "pi-central.rail": "b" });
    assert.equal(existsSync(`${prefsPath(root)}.${process.pid}.tmp`), false);
    assert.equal(existsSync(prefsPath(root)), true);
    // And the file on disk is the document, not a fragment of one: this is what makes a crash survivable.
    const body = JSON.parse(readFileSync(prefsPath(root), "utf8")) as { version: number; prefs: unknown };
    assert.equal(body.version, 1);
    assert.deepEqual(body.prefs, { "pi-central.rail": "b" });
  } finally {
    cleanup();
  }
});

test("only keys this store can name are kept", () => {
  // A key with a slash or a NUL is a path or a truncation waiting to happen downstream, and a key is a NAME the code
  // chose — there is no legitimate reason to need those bytes in one.
  assert.equal(isPrefsKey("pi-central.model-scope"), true);
  assert.equal(isPrefsKey("pi-central.trace.order"), true);
  assert.equal(isPrefsKey(""), false);
  assert.equal(isPrefsKey("x".repeat(PREFS_KEY_MAX + 1)), false);
  assert.equal(isPrefsKey("pi-central/../escape"), false);
  assert.equal(isPrefsKey("pi-central\0truncated"), false);
  assert.equal(isPrefsKey("-leading-hyphen"), false);
});

test("a client's map is filtered, not refused", () => {
  // A page one version ahead that sends a key this store dislikes must not be the reason the reader's other
  // preferences stop being saved. The dropped keys are NAMED, so the orchestrator can say them out loud.
  const accepted = acceptPrefs({
    "pi-central.rail": "ok",
    "pi-central.scope": "ok too",
    "../bad": "no",
    "pi-central.numeric": 7,
  });
  assert.deepEqual(accepted.prefs, { "pi-central.rail": "ok", "pi-central.scope": "ok too" });
  assert.deepEqual(accepted.dropped.sort(), ["../bad", "pi-central.numeric"]);
});

test("an oversized value does not refuse the small ones beside it", () => {
  // The total cap is checked over the ACCEPTED set for exactly this case: one bad entry must cost one entry.
  const accepted = acceptPrefs({
    "pi-central.huge": "x".repeat(PREFS_VALUE_MAX + 1),
    "pi-central.rail": "fine",
  });
  assert.deepEqual(accepted.prefs, { "pi-central.rail": "fine" });
  assert.deepEqual(accepted.dropped, ["pi-central.huge"]);
});
