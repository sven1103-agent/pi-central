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
import {
  decideOnSessionChange,
  hasScrollableContent,
  isFollowing,
  isMeasured,
  readerDistanceFromTail,
  shouldFollow,
  type ScrollSample,
} from "../src/scroll.ts";

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
  const pane = source("../src/components/Transcript.tsx");
  // `\bnew Map\b`, not `new Map<`: a bare `new Map()` is valid TypeScript, and the narrower pattern
  // let exactly that form through when this guard was falsified.
  assert.ok(!/\bnew Map\b/.test(pane), "the pane must not own the per-session store; App does");

  const app = source("../src/App.tsx");
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
  const pane = source("../src/components/Transcript.tsx");
  assert.match(pane, /rearmToken/, "the pane must track the send token");
  assert.match(pane, /\[followToken\]/, "…and react to it");
  const app = source("../src/App.tsx");
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
  const pane = source("../src/components/Transcript.tsx");
  assert.match(pane, /pendingRestore/, "the pane must hold the offset");
  assert.match(pane, /hasScrollableContent\(container\.scrollHeight, container\.clientHeight\)/);
});

// --- Growth is not the reader scrolling (the #86 bug) ----------------------------------------------

const at = (scrollTop: number, scrollHeight: number, clientHeight = 600): ScrollSample => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

test("output arriving while the reader sits at the bottom does NOT un-follow them", () => {
  // The reported bug, in one assertion. A scroll event arrives AFTER the browser painted whatever
  // arrived meanwhile, so the distance it measures includes growth the reader never asked for. The
  // pane then stopped following the moment output outran the scroll.
  const before = at(400, 1000); // distance 0: at the bottom
  const afterGrowth = at(400, 1400); // same position, 400px of new output
  assert.equal(readerDistanceFromTail(before, afterGrowth), 0, "growth alone is discounted");
  assert.equal(isFollowing(before, afterGrowth, 80), true, "…so the reader is still following");
});

test("the reader scrolling UP still un-follows them", () => {
  const before = at(400, 1000);
  const scrolledUp = at(300, 1000); // distance 100, no growth
  assert.equal(readerDistanceFromTail(before, scrolledUp), 100);
  assert.equal(isFollowing(before, scrolledUp, 80), false, "moving away from the tail is taking control");
});

test("growth and a scroll up together are separated correctly", () => {
  // The case that defeats the naive rule in BOTH directions, so it is worth pinning: 500px arrived
  // AND the reader moved 100px up. Their own distance is 100, not 600.
  const before = at(400, 1000);
  const both = at(300, 1500); // distance 600, growth 500
  assert.equal(readerDistanceFromTail(before, both), 100, "only the reader's own movement counts");
  assert.equal(isFollowing(before, both, 80), false);

  // …and the mirror: growth larger than the reader's movement is still the reader's movement.
  const tinyScrollHugeGrowth = at(380, 2000); // distance 1020, growth 1000
  assert.equal(readerDistanceFromTail(before, tinyScrollHugeGrowth), 20, "20px of their own");
  assert.equal(isFollowing(before, tinyScrollHugeGrowth, 80), true, "under the tolerance: still following");
});

test("a shrinking container does not invent a negative discount", () => {
  // A collapsed trace or a session switch can make the content SHORTER. Clamped at zero, or the
  // discount would subtract from a distance that has no growth in it.
  const before = at(400, 2000);
  const shrunk = at(400, 1000); // distance 0 after shrinking to the bottom
  assert.equal(readerDistanceFromTail(before, shrunk), 0);
});

test("the follow scrolls instantly, and only the deliberate jump animates", () => {
  // `scroll-behavior: smooth` on the container made every programmatic scroll animate. An animated
  // catch-up cannot catch a moving bottom, and its intermediate positions look exactly like the
  // reader scrolling up — so the follow un-pinned itself. Asserted on both files because the rule
  // spans them: the container must not smooth-scroll by default, and the jump must ask for it.
  const css = stripComments(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"));
  const transcript = /\.transcript\s*\{([^}]*)\}/.exec(css);
  assert.ok(transcript, ".transcript must have a rule");
  assert.ok(
    !/scroll-behavior:\s*smooth/.test(transcript[1]!),
    "the transcript must not smooth-scroll by default: every automatic scroll here is a catch-up",
  );

  const pane = source("../src/components/Transcript.tsx");
  assert.match(pane, /behavior: "smooth"/, "the deliberate jump still animates, explicitly");
  assert.match(pane, /isFollowing\(previous, current, FOLLOW_THRESHOLD_PX\)/, "the follow uses the growth-aware rule");
});

/** Read a source file with its comments removed. */
function source(path: string): string {
  return stripComments(readFileSync(new URL(path, import.meta.url), "utf8"));
}

/**
 * CSS with its comments removed.
 *
 * Assertions about a rule's DECLARATIONS must not be satisfied — or broken — by the prose beside
 * them. This bit three times in this repository: a guard matched `scroll-behavior: smooth` in the
 * comment explaining its removal, another matched `key={focused?.id}` in a comment mentioning the
 * attribute, and a release-workflow check matched its own documentation. Comments are not code.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

test("an unmeasured sample must never become the previous one", () => {
  // The bug this pins, found by breaking three DOM tests: jsdom (and a hidden or not-yet-laid-out
  // pane) reports zeros for every metric. Recorded as "previous", `0` to `2000px` reads as two
  // thousand pixels of GROWTH — which cancels the reader's entire distance from the bottom and pins
  // them to a transcript they had scrolled away from. In a browser it would look like the
  // "Jump to latest" button never appearing.
  assert.equal(isMeasured({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), false, "jsdom");
  assert.equal(isMeasured({ scrollTop: 0, scrollHeight: 2000, clientHeight: 0 }), false, "hidden pane");
  assert.equal(
    isMeasured({ scrollTop: 0, scrollHeight: Number.NaN, clientHeight: 500 }),
    false,
    "not a number",
  );
  assert.equal(isMeasured({ scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 }), true);

  // And the damage it would do, so the guard is not merely descriptive: a first real sample after an
  // unmeasured one discounts the whole distance.
  const unmeasured = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  const real = { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 }; // 1500px from the bottom
  assert.equal(readerDistanceFromTail(unmeasured, real), -500, "growth swamps the distance");
  assert.equal(isFollowing(unmeasured, real, 80), true, "…and the reader looks like they are following");
});

// --- The reader's own setting (issue #86) ----------------------------------------------------------

test("auto-follow off means the transcript never moves on its own", () => {
  // The reader's request: someone investigating at their own pace should not have to keep proving it
  // by scrolling. Off has to beat "pinned", or the pane would still yank them to the bottom every
  // time they happened to be at the end.
  assert.equal(shouldFollow(true, true), true, "following, at the bottom");
  assert.equal(shouldFollow(false, true), false, "…but the reader said no");
  assert.equal(shouldFollow(true, false), false, "pinned false: they scrolled away");
  assert.equal(shouldFollow(false, false), false);
});

test("the toggle is a real control, and its label carries the state", () => {
  // Same visual language as `markers on` beside it in the trace, and the state is in the WORDS as
  // well as `aria-pressed`, so nothing depends on the tint alone.
  const toggle = source("../src/components/FollowToggle.tsx");
  assert.match(toggle, /aria-pressed=\{following\}/, "assistive tech must hear the state");
  assert.match(toggle, /auto-follow on/, "…and so must a reader");
  assert.match(toggle, /auto-follow off/);
  assert.match(toggle, /className="toggle-chip"/, "the shared chip affordance");

  // It must reach the pane, or the setting is decoration.
  const pane = source("../src/components/Transcript.tsx");
  assert.match(pane, /shouldFollow\(autoFollow, pinnedRef\.current\)/, "the follow must consult it");
});
