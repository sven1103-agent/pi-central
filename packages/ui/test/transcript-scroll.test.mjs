/**
 * Jump-to-latest tests (issue #6).
 *
 * **Why these mount a real DOM rather than rendering to a string.** The behaviour is entirely
 * about scroll position: when the control appears, what activating it does, and whether following
 * resumes. Every one of those is invisible to `renderToString`. But jsdom also cannot scroll —
 * it reports `scrollHeight`, `scrollTop` and `clientHeight` as 0 for every element — so the
 * numbers are stubbed on the container. That is the honest combination: a real mount, real
 * React effects, real event dispatch, with the one thing jsdom lacks supplied by hand.
 *
 * The pure predicate is tested separately as well, because it is the rule both the component and
 * these tests depend on, and a rule asserted only through its caller is a rule that can be
 * changed in the caller.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// React 19 refuses to run effects outside an act() environment, which is what makes the mount
// deterministic instead of timing-dependent.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

/**
 * jsdom does not implement `scrollIntoView` at all, so every element is missing it. In a real
 * browser it is always present on `Element`, so this is a gap in the test environment rather than
 * a case the component should defend against — the defence belongs here, not in production code
 * that would then be written around a limitation no browser has. Individual tests replace this
 * with their own spy to observe the call.
 */
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

let server;
let TranscriptView, isAtBottom, FOLLOW_THRESHOLD_PX;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ TranscriptView, isAtBottom, FOLLOW_THRESHOLD_PX } = await server.ssrLoadModule("/src/components/Transcript.tsx"));
});

after(async () => {
  await server?.close();
});

/** A transcript with enough turns that scrolling means something. */
function manyMessages(count) {
  return {
    messages: Array.from({ length: count }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      // `blocks`/`complete`/`streaming` are the real shapes: `planTranscript` walks the blocks,
      // so a hand-built message missing them throws before any scroll behaviour is reached.
      blocks: [{ kind: "text", text: `message number ${index}`, complete: true }],
      complete: true,
      streaming: false,
    })),
    tools: [],
  };
}

/**
 * Give an element scroll metrics jsdom does not compute.
 *
 * `scrollTop` is a real setter backed by a local, because the component assigns it and the test
 * needs to observe the assignment.
 */
function stubMetrics(el, { scrollHeight, clientHeight, scrollTop = 0 }) {
  let top = scrollTop;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value) => {
      top = value;
    },
  });
  return {
    get scrollTop() {
      return top;
    },
  };
}

let container;
/** Every `scrollIntoView` call made during the current test, with the element it was made on. */
let intoViewCalls;
beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  intoViewCalls = [];
  // Counted on the prototype so the spy cannot miss the element, which selecting it by
  // `:last-child` did — that matched a nested div instead of the end sentinel, and the assertion
  // then failed while the behaviour was correct.
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {
    intoViewCalls.push(this);
  };
});

/** Mount the transcript and return the scroller plus a helper to fire scroll. */
function mount(transcript = manyMessages(30)) {
  const root = createRoot(container);
  act(() => {
    root.render(createElement(TranscriptView, {
      transcript,
      busy: true,
      sessionLabel: "s1",
    }));
  });
  const scroller = container.querySelector(".transcript");
  assert.ok(scroller, "the transcript scroller must render");
  const scroll = () => {
    act(() => {
      scroller.dispatchEvent(new dom.window.Event("scroll"));
    });
  };
  return { root, scroller, scroll, jumpButton: () => container.querySelector(".jump-latest") };
}

test("isAtBottom treats the end, and a few pixels off it, as the bottom", () => {
  // The tolerance is load-bearing: a fractional scrollTop (zoom, DPR, a smooth scroll still in
  // flight) never lands exactly on the bottom, so an equality test would stop following at random.
  assert.equal(isAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 }), true);
  assert.equal(isAtBottom({ scrollHeight: 1000, scrollTop: 500 - FOLLOW_THRESHOLD_PX + 1, clientHeight: 500 }), true);
  assert.equal(isAtBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 500 }), false);
});

test("an unmeasured container counts as pinned, so no control appears before layout", () => {
  // jsdom reports 0 for everything, and so can a hidden pane. Reporting "unpinned" there would put
  // a "jump to latest" button on a transcript that has not been measured.
  assert.equal(isAtBottom({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 }), true);
  assert.equal(isAtBottom({ scrollHeight: Number.NaN, scrollTop: 0, clientHeight: 100 }), true);
});

test("the control is absent while the reader is at the bottom", () => {
  const { jumpButton, scroller, scroll } = mount();
  stubMetrics(scroller, { scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 });
  scroll();
  assert.equal(jumpButton(), null, "a control that can do nothing must not be shown");
});

test("scrolling up reveals the control, and it is a real button", () => {
  const { jumpButton, scroller, scroll } = mount();
  stubMetrics(scroller, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 });
  scroll();
  const button = jumpButton();
  assert.ok(button, "scrolling away from the bottom must offer a way back");
  assert.equal(button.tagName, "BUTTON", "it must be keyboard-reachable for free");
  // The label carries the meaning, so the glyph is hidden from assistive tech rather than read out
  // as "downwards arrow".
  assert.match(button.textContent, /Jump to latest/);
  assert.equal(button.querySelector('[aria-hidden="true"]')?.textContent, "↓");
});

test("activating it scrolls to the newest content AND resumes following", () => {
  // The acceptance criterion that matters most, and the one an implementation gets wrong by
  // half: scrolling without re-pinning leaves the reader at the bottom of a pane that has stopped
  // following, so the next message arrives off-screen.
  const { root, jumpButton, scroller, scroll } = mount();
  const metrics = stubMetrics(scroller, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 });
  scroll();
  assert.ok(jumpButton());

  const before = intoViewCalls.length;
  act(() => {
    jumpButton().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  // At LEAST one, not exactly one: re-pinning changes state, which re-renders, which runs the
  // follow effect — so this can legitimately scroll twice. Asserting an exact count would pin the
  // test to an implementation detail of when React flushes, rather than to the behaviour.
  assert.ok(intoViewCalls.length > before, "activating must scroll to the newest content");
  // The element it scrolled to is the END sentinel, not some ancestor: scrolling the pane's top
  // into view would move the reader to the wrong end.
  assert.equal(intoViewCalls.at(-1).parentElement, scroller, "the end sentinel must be the target");
  assert.equal(metrics.scrollTop, 2000, "and land at the bottom of the pane");
  assert.equal(jumpButton(), null, "and the control must go away, because it is pinned again");

  // Following resumed, demonstrated rather than assumed: the follow effect runs on every render,
  // so a re-render after the click must scroll the tail again. Had `jumpToLatest` scrolled without
  // re-pinning, `pinnedRef` would still be false and this second scroll would not happen — which
  // is the half-done implementation this test exists to catch.
  const afterClick = intoViewCalls.length;
  act(() => {
    // A new message arriving is what re-renders the pane during a run.
    root.render(createElement(TranscriptView, {
      transcript: manyMessages(31), busy: true, sessionLabel: "s1",
    }));
  });
  assert.equal(intoViewCalls.length, afterClick + 1, "a new turn must scroll the tail again");
});

test("a scroll event while pinned keeps the control hidden", () => {
  const { jumpButton, scroller, scroll } = mount();
  stubMetrics(scroller, { scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 });
  scroll();
  scroll();
  assert.equal(jumpButton(), null);
});

test("the control does not take focus", () => {
  // The criterion is explicit: activating it must not steal focus from the composer. Nothing in
  // the component calls focus(), so the assertion is that the click leaves focus where it was.
  const { jumpButton, scroller, scroll } = mount();
  stubMetrics(scroller, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 });
  scroll();

  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  textarea.focus();
  assert.equal(document.activeElement, textarea, "precondition: the composer has focus");

  act(() => {
    jumpButton().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(document.activeElement, textarea, "the jump control must not steal focus");
});
