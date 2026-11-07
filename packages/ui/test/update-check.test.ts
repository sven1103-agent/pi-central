/**
 * The stale-page decision (issue #184).
 *
 * ## Why this earns a test
 *
 * The reported failure was "the PWA does not update" — and the whole fix is a comparison with a
 * one-shot guard. Both halves are exactly the kind of code that looks too simple to get wrong and
 * then is: compare in the wrong direction and every client reloads forever; forget the guard and
 * the reverse skew (new page, old orchestrator) loops instead of explaining itself.
 *
 * The assertions are about the DECISION, not the prose: when a reload is allowed, when it is
 * forbidden, and what re-arms it. The storage is faked, because the mark's behaviour across two
 * assessments is the point.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { InstallFacts } from "@pi-central/protocol";
import {
  PROTOCOL_RELOAD_KEY,
  UPDATE_RELOAD_KEY,
  assessProtocolSkew,
  BLOCKED_RELOAD_MESSAGE,
  isReloadBlocked,
  reloadOnReturn,
  assessServedUi,
  noteProtocolAgreement,
  type StorageLike,
} from "../src/update-check.ts";

/** A `sessionStorage` stand-in that records what the decision did with it. */
function fakeStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function install(entry: string | undefined, protocol = 5): InstallFacts {
  return {
    version: "test",
    sessionsRoot: "/tmp/sessions",
    workspaceRoot: "/tmp/workspaces",
    agentRoot: "/tmp/agent",
    agentRootManaged: true,
    protocol,
    ...(entry === undefined ? {} : { ui: { entry, builtAt: "2026-11-01T10:00:00.000Z" } }),
  };
}

test("agreement is silence, and re-arms a spent mark", () => {
  const storage = fakeStorage({ [UPDATE_RELOAD_KEY]: "assets/index-NEW.js" });
  const verdict = assessServedUi("assets/index-OLD.js", install("assets/index-OLD.js"), storage);
  assert.equal(verdict.action, "none");
  // The mark from an EARLIER update must be cleared, or this tab's next update gets a banner
  // instead of the reload it deserves.
  assert.equal(storage.map.has(UPDATE_RELOAD_KEY), false);
});

test("a different served entry reloads — once", () => {
  const storage = fakeStorage();
  const first = assessServedUi("assets/index-OLD.js", install("assets/index-NEW.js"), storage);
  assert.equal(first.action, "reload");
  // The mark names the TARGET, so the same verdict after the reload is recognised as "we tried".
  assert.equal(storage.map.get(UPDATE_RELOAD_KEY), "assets/index-NEW.js");

  const second = assessServedUi("assets/index-OLD.js", install("assets/index-NEW.js"), storage);
  assert.equal(second.action, "banner");
  if (second.action === "banner") {
    // The advice that works when a reload did not: quit the app, not another reload loop.
    assert.match(second.message, /⌘Q/);
  }
});

test("a third assessment with a NEWER target reloads again — the mark is per target", () => {
  const storage = fakeStorage({ [UPDATE_RELOAD_KEY]: "assets/index-NEW.js" });
  const verdict = assessServedUi("assets/index-OLD.js", install("assets/index-NEWER.js"), storage);
  assert.equal(verdict.action, "reload");
  assert.equal(storage.map.get(UPDATE_RELOAD_KEY), "assets/index-NEWER.js");
});

test("absence is never a verdict: no ui field, no own entry, or both", () => {
  const storage = fakeStorage();
  // An older orchestrator reports nothing. Treating that as "different" would reload every
  // client of every pre-#184 orchestrator on every snapshot.
  assert.equal(assessServedUi("assets/index-OLD.js", install(undefined), storage).action, "none");
  assert.equal(assessServedUi("assets/index-OLD.js", undefined, storage).action, "none");
  // A dev page has no fingerprinted entry: the comparison stays silent rather than firing on
  // every snapshot of every dev session.
  assert.equal(assessServedUi(undefined, install("assets/index-NEW.js"), storage).action, "none");
  assert.equal(storage.map.size, 0, "a non-verdict must not write a mark");
});

test("a protocol skew reloads once, then banners with the orchestrator-side fix", () => {
  const storage = fakeStorage();
  const skew = "protocol mismatch: the orchestrator speaks v4 and this UI speaks v5. Reload the UI; if that fails, restart the orchestrator.";
  assert.equal(assessProtocolSkew(skew, storage).action, "reload");

  const second = assessProtocolSkew(skew, storage);
  assert.equal(second.action, "banner");
  if (second.action === "banner") {
    // The loop case is the REVERSE skew — a new page against an old orchestrator — so the advice
    // must point at the orchestrator, not at another reload.
    assert.match(second.message, /restart the orchestrator/);
  }
});

test("a snapshot that proves protocol agreement re-arms the skew mark", () => {
  const storage = fakeStorage({ [PROTOCOL_RELOAD_KEY]: "protocol mismatch: …" });
  noteProtocolAgreement(install("assets/index-X.js", 5), 5, storage);
  assert.equal(storage.map.has(PROTOCOL_RELOAD_KEY), false);
});

test("a snapshot from a SKEWED orchestrator does not re-arm the mark", () => {
  // The reverse-skew loop guard depends on this: the orchestrator reports v4, the page is v5, so
  // agreement is never recorded and the second skew verdict stays a banner instead of a reload.
  const storage = fakeStorage({ [PROTOCOL_RELOAD_KEY]: "protocol mismatch: …" });
  noteProtocolAgreement(install("assets/index-X.js", 4), 5, storage);
  assert.equal(storage.map.get(PROTOCOL_RELOAD_KEY), "protocol mismatch: …");
});

// --- Returning to a hidden window (issue #213) -------------------------------------------------
//
// The reload-on-snapshot rule above covers a page that is *looking*. An installed window that was
// minimised or hidden sees no snapshot while it is away, so it comes back stale. These assertions are
// about the evidence required before reloading — because the cheap implementation ("reload when the
// window is focused") passes the first test and fails the second, and only the second one matters to
// someone who was typing.

test("a page with no recorded verdict does not reload when it returns to view", () => {
  // The falsifier for reload-on-focus: no mark means no evidence, and an unguarded reload loses the
  // draft that made the reader switch tabs in the first place.
  assert.deepEqual(reloadOnReturn(fakeStorage()), { action: "none" });
});

test("a page that recorded a stale verdict reloads when it returns to view", () => {
  const served = fakeStorage({ [UPDATE_RELOAD_KEY]: "assets/index-NEW.js" });
  assert.deepEqual(reloadOnReturn(served), { action: "reload" });

  // The protocol-skew mark is evidence of the same class, so it takes the same path.
  const skewed = fakeStorage({ [PROTOCOL_RELOAD_KEY]: "protocol mismatch: …" });
  assert.deepEqual(reloadOnReturn(skewed), { action: "reload" });
});

test("returning twice does not clear the mark, so the decision stays reload until the page is replaced", () => {
  // Within one page's lifetime the answer must not be stateful: the effect can run twice (React
  // StrictMode, two visibility events), and a decision that returned `none` the second time would
  // make the reload depend on which event happened to fire first.
  const storage = fakeStorage({ [UPDATE_RELOAD_KEY]: "assets/index-NEW.js" });
  assert.equal(reloadOnReturn(storage).action, "reload");
  assert.equal(reloadOnReturn(storage).action, "reload");
  assert.equal(storage.map.get(UPDATE_RELOAD_KEY), "assets/index-NEW.js");
});

test("unsent work blocks the reload, and whitespace alone does not", () => {
  assert.equal(isReloadBlocked({ draft: "", attachmentCount: 0 }), false);
  // A draft of spaces is not something anyone minds losing; refusing to reload for it would leave the
  // reader on the old version for a keystroke they did not mean.
  assert.equal(isReloadBlocked({ draft: "   \n ", attachmentCount: 0 }), false);
  assert.equal(isReloadBlocked({ draft: "half a sentence", attachmentCount: 0 }), true);
  // An attachment is content, not text: a pasted screenshot is megabytes that exist nowhere else.
  assert.equal(isReloadBlocked({ draft: "", attachmentCount: 1 }), true);
});

test("the blocked message names what is holding the reload, and the way out", () => {
  // One place for the sentence, so the banner cannot promise a reload the guard is refusing.
  assert.match(BLOCKED_RELOAD_MESSAGE, /discard/);
  assert.match(BLOCKED_RELOAD_MESSAGE, /Send or clear/);
});
