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
