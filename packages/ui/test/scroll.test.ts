/**
 * What the transcript does when the session changes (issues #80 and #86).
 *
 * Both issues are the same defect seen from two sides, and both come from one fact: the follow flag
 * and the scroll offset were single component-level values that nothing re-armed. #80 is position
 * leaking between sessions; #86 is a reply arriving off-screen after the reader had scrolled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideOnSessionChange, hasScrollableContent } from "../src/scroll.ts";

test("a session never opened opens at the END, following", () => {
  // The newest content is what a reader arriving wants, and a live agent may have produced a great
  // deal since the last look. Restoring a position only makes sense for a session actually read.
  assert.deepEqual(decideOnSessionChange(undefined), { kind: "follow-end" });
});

test("a session read before goes back exactly where it was left", () => {
  const left = { scrollTop: 412, pinned: false };
  assert.deepEqual(decideOnSessionChange(left), { kind: "restore", scrollTop: 412, pinned: false });
});

test("the follow flag is restored with the offset, not assumed", () => {
  // The half that makes #86 possible: a reader who had scrolled up was still at the bottom of the
  // *stored* state, so the restored flag has to travel with the offset. Assuming `true` would
  // re-pin someone who deliberately scrolled away; assuming `false` would strand a reader following
  // a stream at a stale offset.
  assert.equal(decideOnSessionChange({ scrollTop: 0, pinned: true }).kind, "restore");
  assert.deepEqual(decideOnSessionChange({ scrollTop: 0, pinned: true }), {
    kind: "restore",
    scrollTop: 0,
    pinned: true,
  });
});

test("the scroll memory is NOT kept inside the transcript pane", () => {
  // A structural assertion, because the failure is invisible: an in-pane store looks like it works
  // until you switch sessions, and then it is empty.
  //
  // `SessionView` carries `key={focused?.id}` in `App.tsx`, so it — and `TranscriptView` inside it —
  // REMOUNTS on every session switch. A store held there is destroyed at exactly the moment it is
  // needed. So the memory lives in `App` and is handed in, and this test pins both halves of that.
  const pane = readFileSync(new URL("../src/components/Transcript.tsx", import.meta.url), "utf8");
  // `\bnew Map\b`, not `new Map<`: a bare `new Map()` is valid TypeScript, and the narrower pattern
  // let exactly that form through when this guard was falsified.
  assert.ok(!/\bnew Map\b/.test(pane), "the pane must not own the per-session store; App does");

  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /scrollMemory = useRef\(new Map/, "App owns the memory");
  // Anchored to a line that IS the attribute. The unanchored form matched a COMMENT in `App.tsx`
  // that merely mentions the key — the guard passed while the key was deleted. Same trap as a
  // release-workflow check matching its own prose: text scanning finds strings, not meaning.
  assert.match(
    app,
    /^\s*key=\{focused\?\.id\}\s*$/m,
    "if this key ever goes, the memory could safely move back into the pane — and this test is the reminder to reconsider it",
  );
});

test("sending a prompt re-arms following, so the reply cannot arrive off-screen", () => {
  // #86's reported symptom, in one assertion: `followToken` changes on send, and the pane watches it.
  const pane = readFileSync(new URL("../src/components/Transcript.tsx", import.meta.url), "utf8");
  assert.match(pane, /rearmToken/, "the pane must track the send token");
  assert.match(pane, /\[followToken\]/, "…and react to it");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /setFollowToken\(\(n\) => n \+ 1\)/, "App must raise the token on send");
});

test("a restore waits until there is something to scroll", () => {
  // The trap: the pane mounts when the session is focused, but its history is FETCHED, so the
  // container is empty for the first frames. Applying the offset then would be clamped to 0 — the
  // reader lands at the top, which is the bug, and it would look like the feature simply did not work.
  assert.equal(hasScrollableContent(0, 0), false, "nothing mounted yet");
  assert.equal(hasScrollableContent(600, 800), false, "content fits: no position to restore");
  assert.equal(hasScrollableContent(600, 600), false, "exactly full: nothing to scroll");
  assert.equal(hasScrollableContent(801, 600), true, "…now there is");

  // And the pane must actually hold it rather than applying it on mount.
  const pane = readFileSync(new URL("../src/components/Transcript.tsx", import.meta.url), "utf8");
  assert.match(pane, /pendingRestore/, "the pane must hold the offset");
  assert.match(pane, /hasScrollableContent\(container\.scrollHeight, container\.clientHeight\)/);
});
