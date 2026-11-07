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
  recheckOnReturn,
  assessServedUi,
  noteProtocolAgreement,
  type StorageLike,
} from "../src/update-check.ts";
import { PROTOCOL_VERSION } from "@pi-central/protocol";

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
// minimised or hidden sees no snapshot while it is away, so it comes back stale with no fresh verdict.
// The decision here is deliberately only "ask", not "reload":
//
//   - a focus event is not evidence, so a reload decided by one loses drafts on every tab switch;
//   - a reload gated on the RECORDED marks loops in the reverse-skew case #184 documents, because those
//     marks are written *before* the reload they permit, so the window would reload on every focus.
//
// Asking the orchestrator puts the decision back where the evidence is.

// --- What the re-check asks (issue #220) ------------------------------------------------------
//
// `list` used to be the question, and it re-runs `discover()` over the whole session store: 329 ms median
// per focus on a store of 886 sessions, growing with it. None of that work is in the answer, so the
// question is now `install`. These assertions pin BOTH halves: that the control is `install`, and that a
// peer which cannot answer it is not asked at all.

test("a window returning to view asks for the installation facts, and decides nothing itself", () => {
  // The same answer whatever the marks say: this function has no storage parameter precisely so it
  // cannot make the reload decision that its caller is not equipped to review.
  assert.deepEqual(recheckOnReturn(PROTOCOL_VERSION), { action: "request", control: { kind: "install" } });
});

test("the re-check never asks for `list`, which is the expensive question it replaced", () => {
  // The regression this guards: reverting to `list` restores a full discovery per focus, and nothing else in
  // the suite would notice — the UI would work exactly as well, just 329 ms later each time.
  const control = recheckOnReturn(PROTOCOL_VERSION);
  assert.notDeepEqual(control, { action: "request", control: { kind: "list" } });
  assert.equal(control.action === "request" ? control.control.kind : undefined, "install");
});

test("an orchestrator that predates the control is not asked, so no error strip per focus", () => {
  // A refused send is an `error` event, and this runs on every alt-tab. Silence, not a fallback to `list`: the
  // point of the slice is that a focus event should not cost a discovery, and a stale page on an old
  // orchestrator is caught by the snapshot a reconnect delivers anyway.
  assert.deepEqual(recheckOnReturn(PROTOCOL_VERSION - 1), { action: "none" });
  assert.deepEqual(recheckOnReturn(1), { action: "none" });
  // `undefined` is "not reported yet", not "old" — the convention `supportsRetry` documents.
  assert.deepEqual(recheckOnReturn(undefined), { action: "request", control: { kind: "install" } });
});

test("the round trip the request starts is what decides, so one reload still comes from one verdict", () => {
  // The end-to-end shape, asserted as the sequence the App performs: ask, receive, assess. The second
  // verdict is a banner rather than a reload, which is the property reload-on-return broke — it would
  // have reloaded again, because the mark only says "we once tried".
  const storage = fakeStorage();
  assert.deepEqual(recheckOnReturn(PROTOCOL_VERSION), { action: "request", control: { kind: "install" } });
  assert.equal(assessServedUi("assets/index-OLD.js", install("assets/index-NEW.js"), storage).action, "reload");

  // After the reload: ask again, receive the same disagreement, and this time the mark is spent.
  assert.deepEqual(recheckOnReturn(PROTOCOL_VERSION), { action: "request", control: { kind: "install" } });
  assert.equal(assessServedUi("assets/index-OLD.js", install("assets/index-NEW.js"), storage).action, "banner");
});

test("the same verdict arrives through `installFacts` as through a snapshot", () => {
  // The refactor's risk, stated in the issue: two handlers running the assessment sequence are two chances to
  // disagree. The sequence is one function in App; what is assertable here is that the FACTS the two paths carry
  // are the same shape, so neither can produce a verdict the other cannot.
  const storage = fakeStorage();
  const facts = install("assets/index-NEW.js");
  assert.equal(assessServedUi("assets/index-OLD.js", facts, storage).action, "reload");
  assert.equal(storage.map.get(UPDATE_RELOAD_KEY), "assets/index-NEW.js");
  // And the protocol half of the same message still re-arms the skew mark.
  const skewStorage = fakeStorage({ [PROTOCOL_RELOAD_KEY]: "protocol mismatch: …" });
  noteProtocolAgreement(facts, facts.protocol, skewStorage);
  assert.equal(skewStorage.map.has(PROTOCOL_RELOAD_KEY), false);
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

test("an old peer is not asked, but a skew is still reported and still reloads once (issue #220)", () => {
  /*
   * The half a `supportsInstall` gate could plausibly break, so it is asserted rather than assumed. Refusing to
   * ASK an old orchestrator must not be mistaken for refusing to REPORT one: the skew verdict comes from `hello`,
   * which the connection consumes before any control is sent, so the gate only removes the per-focus question —
   * not the warning, and not the one-shot reload that follows it.
   */
  assert.deepEqual(recheckOnReturn(PROTOCOL_VERSION - 1), { action: "none" }, "not asked");

  const storage = fakeStorage();
  const skew = "protocol mismatch: the orchestrator speaks v8 and this UI speaks v9. Reload the UI; if that fails, restart the orchestrator.";
  assert.equal(assessProtocolSkew(skew, storage).action, "reload", "still reported, and still reloads once");
  const second = assessProtocolSkew(skew, storage);
  assert.equal(second.action, "banner", "and the second verdict is a banner, not a loop");
  if (second.action === "banner") assert.match(second.message, /restart the orchestrator/);
});
