/**
 * The transcript RENDERS conversation plus activity, and nothing else.
 *
 * `activity.test.ts` asserts the plan. This file asserts what a reader actually gets, because the plan can be
 * correct while the renderer ignores it — which is exactly how the reported screenshot happened: every piece
 * worked, `planTranscript` grouped tools correctly, and the screen still showed one bar per internal step
 * because `hasProse()` turned each thinking-only message into its own turn.
 *
 * The properties, in the order they matter:
 *
 *   1. the interleaved run from `img_18.png` is ONE group, not a stack of bars under repeated headings;
 *   2. the reader's `activity off` preference cannot hide a failure or a call that is still running;
 *   3. the open/closed state is owned by the host, so it can survive the remount a session switch causes.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

let server, TranscriptView;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ TranscriptView } = await server.ssrLoadModule("/src/components/Transcript.tsx"));
});

after(async () => {
  await server?.close();
});

const text = (value) => ({ kind: "text", text: value, complete: true });
const thinking = (value, complete = true) => ({ kind: "thinking", text: value, complete });
const assistant = (id, blocks, streaming = false) => ({
  id,
  role: "assistant",
  blocks,
  complete: !streaming,
  streaming,
});
const you = (id, value) => ({ id, role: "user", blocks: [text(value)], complete: true, streaming: false });

function tool(id, afterMessage, overrides = {}) {
  return {
    toolCallId: id,
    toolName: "bash",
    args: { command: "ls" },
    result: "out",
    isError: false,
    running: false,
    startedAt: 0,
    afterMessage,
    ...overrides,
  };
}

function render({ messages = [], tools = [], busy = false, showMarkers = true, activityOpen = {}, onToggleActivity }) {
  return renderToString(
    createElement(TranscriptView, {
      transcript: { messages, tools, notices: [] },
      busy,
      sessionLabel: "s1",
      showMarkers,
      activityOpen,
      onToggleActivity,
    }),
  );
}

/** The reported sequence: a tool and a thought, repeated, with no prose between them. */
function screenshotRun() {
  return {
    messages: [
      you("u1", "Review the screenshots."),
      assistant("a1", [thinking("Retry the subagent call without the bad option.")]),
      assistant("a2", [thinking("The subagent reviewed all images, not just img_17.")]),
      assistant("a3", [thinking("The report reviewed ALL images rather than focusing.")]),
      assistant("a4", [thinking("", false)], true),
    ],
    tools: [tool("t1", 2), tool("t2", 3), tool("t3", 4), tool("t4", 5, { running: true })],
    busy: true,
  };
}

test("the interleaved run renders ONE group, and no repeated Assistant headings", () => {
  const html = render(screenshotRun());

  // `class="activity` plus a SPACE or the closing quote: the group's own element, not `activity-summary` /
  // `activity-thought` (which are children and would inflate the count).
  const groups = [...html.matchAll(/<details class="activity(?: [^"]*)?"/g)];
  assert.equal(groups.length, 1, `one group, got ${groups.length}: ${html.slice(0, 400)}`);
  const headings = [...html.matchAll(/<span>Assistant<\/span>/g)];
  assert.equal(headings.length, 0, "a thinking-only message must not produce an Assistant heading");
  // The reader's own prompt is still a turn, and still labelled.
  assert.match(html, /<span>You<\/span>/, "the reader's message is unaffected");
});

test("a collapsed group still says what is running and what failed", () => {
  // Collapsing must not be a way to lose the one fact that needs attention.
  const html = render({
    messages: [you("u1", "go")],
    tools: [tool("t1", 1, { toolName: "subagent", isError: true }), tool("t2", 1, { toolName: "read", running: true })],
    busy: true,
  });
  assert.match(html, /Running read/, "the live operation is named");
  assert.match(html, /1 call failed/, "the failure survives collapsing");
  // Opening it is the disclosure, and it is closed by default.
  assert.ok(!/<details class="activity[^"]*" open/.test(html), "collapsed by default");
});

test("the host's open state is honoured, so a disclosure can survive a remount", () => {
  const run = screenshotRun();
  const closed = render(run);
  assert.ok(!/class="activity is-live" open/.test(closed), "precondition: closed by default");

  /*
   * The host addresses a group by its key, which is derived from the group's FIRST recorded part. That is what
   * makes the state worth owning: the pane remounts on a session switch, so the same key must select the same
   * group on the way back. The plan's own test asserts the key directly; here the property under test is that
   * passing it opens that group and only that one.
   */
  const open = render({ ...run, activityOpen: { "activity:thinking:a1:0": true } });
  assert.match(open, /<details class="activity[^"]*" open/, "the group opens when the host says so");
  const wrongKey = render({ ...run, activityOpen: { "activity:thinking:elsewhere:0": true } });
  assert.ok(!/<details class="activity[^"]*" open/.test(wrongKey), "an unrelated key opens nothing");
});

test("hiding activity cannot hide a failure, a running call, or a call with no result", () => {
  const quiet = render({ messages: [you("u1", "go")], tools: [tool("t1", 1)], showMarkers: false });
  assert.ok(!/class="activity/.test(quiet), "routine work is hidden, which is the preference");

  for (const [label, overrides] of [
    ["a failed call", { isError: true }],
    ["a running call", { running: true }],
    ["a call with no recorded result", { unfinished: true }],
  ]) {
    const html = render({
      messages: [you("u1", "go")],
      tools: [tool("t1", 1, overrides)],
      showMarkers: false,
    });
    assert.match(html, /class="activity/, `${label} must stay visible with activity off`);
  }
});

test("a thinking block that is still arriving keeps the group visibly live", () => {
  const html = render({
    messages: [assistant("a1", [thinking("", false), text("Working.")], true)],
    busy: true,
  });
  assert.match(html, /Thinking…/, "the waiting state is named, not an empty bar");
  assert.match(html, /activity[^"]*is-live/, "…and the group reads as live");
});

test("every tool call and every thought is a numbered row, in RECORDED order", () => {
  /*
   * Grouping is a presentation change, not a deletion: the evidence is still there. And the ORDER is the point —
   * the first version of this component rendered all thinking first and all tools afterwards, so a run that
   * thought, ran something, thought again read as a different sequence from the one that happened.
   */
  const html = render(screenshotRun());
  const kinds = [...html.matchAll(/class="activity-step-kind">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(
    kinds,
    // Four thoughts and four calls, strictly alternating: the thought that is still arriving has words in this
    // fixture, so it does add a row.
    ["Thinking", "Tool output", "Thinking", "Tool output", "Thinking", "Tool output", "Thinking", "Tool output"],
    `the ledger must follow the recorded order, got ${JSON.stringify(kinds)}`,
  );
  // The fourth thought is still arriving; its own ROW says so, which is where that fact belongs now that every
  // step has a row. (The group's summary says it too, but only when nothing is running a tool.)
  assert.match(html, /activity-thought-state[^>]*>thinking…/, "the in-progress thought says so on its row");
  assert.match(html, /Retry the subagent call/, "a thought's words are carried, not summarised away");
});

test("a step states WHAT ran, not the JSON it ran with", () => {
  /*
   * The reported defect (`img_19.png`): opening the group produced fifty lines of `ls -la` output and an `env`
   * dump in the conversation. A step must name the call — tool plus the argument that says what it acted on —
   * and defer the payload to the trace.
   */
  const html = render({
    messages: [you("u1", "go")],
    tools: [
      tool("t1", 1, { toolName: "read", args: { path: "packages/ui/src/transcript.ts" } }),
      tool("t2", 1, { toolName: "bash", args: { command: "rg -n 'seatbelt' docs/CONSTRAINTS.md" } }),
      tool("t3", 1, { toolName: "subagent", args: { agent: "ui-review" } }),
    ],
  });
  assert.match(html, /read packages\/ui\/src\/transcript\.ts/, "a path names the call");
  assert.match(html, /bash rg -n &#x27;seatbelt&#x27;|bash rg -n 'seatbelt'/, "a command names the call");
  assert.match(html, /subagent ui-review/, "an agent names the call");

  // And no payload: no JSON braces from an argument dump, and no rendered result.
  assert.ok(!/&quot;command&quot;/.test(html), "no JSON argument dump");
  assert.ok(!/tool-detail-output/.test(html), "no raw output block");
  assert.ok(!/>out</.test(html), "the fixture result text is not rendered");
});

test("each step offers exactly one action: inspect it in the trace", () => {
  const html = render({
    messages: [you("u1", "go")],
    tools: [tool("t1", 1)],
    onToggleActivity: undefined,
  });
  // Without a handler the action is not offered at all — a button that cannot work is worse than no button.
  assert.ok(!html.includes("activity-step-action"), "no action when the host cannot handle it");

  const wired = renderToString(
    createElement(TranscriptView, {
      transcript: { messages: [you("u1", "go")], tools: [tool("t1", 1)], notices: [] },
      busy: false,
      sessionLabel: "s1",
      onOpenTool: () => {},
    }),
  );
  const actions = [...wired.matchAll(/class="activity-step-action"/g)];
  assert.equal(actions.length, 1, "one action per tool step");
  assert.match(wired, />Inspect</, "and it says what it does");
});

test("a thought opens in place as escaped text, never markup", () => {
  /*
   * The thinking block is the one step that DOES render prose inline, so it is the surface that must stay inert.
   * ADR-0006's single insertion site stays in `Prose`; reasoning is data and renders as text.
   */
  const html = render({
    messages: [assistant("a1", [thinking("<img src=x onerror=alert(1)> then this"), text("Done.")])],
    tools: [],
  });
  assert.ok(!/<img src=x/.test(html), "the thought is not live markup");
  assert.match(html, /&lt;img src=x/, "…it is escaped and shown as text");
});

test("a recorded failure does NOT leave the group looking permanently broken", () => {
  /*
   * The reported defect (`img_20.png`): "when one or more steps fail, suddenly the green activity dot is red all
   * the time". The group's dot turned red whenever ANY call had failed, which is permanent for a finished run —
   * so a settled session sat there red while nothing was wrong any more.
   *
   * The dot answers ONE question, "is this working now": green while live, quiet at rest. A past failure is a
   * fact for the DETAIL text, where the reader can see what happened and act on it.
   */
  const settled = render({
    messages: [you("u1", "go")],
    tools: [tool("t1", 1, { isError: true })],
    busy: false,
  });
  assert.match(settled, /class="activity-glyph"/, "precondition: the summary has a dot");
  assert.ok(!/activity-glyph is-live/.test(settled), "a settled group is not live");
  assert.match(settled, /activity-detail[^>]*>1 call failed/, "the failure is stated in words");

  // And the CSS must not paint it by failure state any more.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/\.activity\.has-error \.activity-glyph/.test(css),
    "the summary dot must not be reddened by a past failure",
  );
  assert.match(css, /\.activity-glyph\.is-live[^}]*--ok-text/, "…only by being live");
});

test("each step row is marked by a DOT on a rail, not by a number", () => {
  // "the numbering of the steps is not needed… something more like a connected rail with dots for the steps".
  const html = render({
    messages: [you("u1", "go")],
    tools: [tool("t1", 1), tool("t2", 1, { isError: true }), tool("t3", 1, { running: true })],
    busy: true,
  });
  const dots = [...html.matchAll(/class="activity-dot[^"]*"/g)].map((m) => m[0]);
  assert.equal(dots.length, 3, `one dot per step, got ${dots.length}`);

  // State is on the dot; the words are still in the row, so nothing depends on colour alone.
  assert.match(html, /activity-dot is-failed/, "a failed step's dot says so");
  assert.match(html, /activity-dot is-live/, "a running step's dot says so");
  assert.match(html, />failed</, "…and the row states it in words");
  assert.match(html, />running</, "…for running too");
  assert.ok(!/activity-step-index/.test(html), "no numeric column");
});