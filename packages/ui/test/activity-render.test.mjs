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

let server, TranscriptView, clearImageCache, liveImageCount;

before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ TranscriptView } = await server.ssrLoadModule("/src/components/Transcript.tsx"));
  ({ clearImageCache, liveImageCount } = await server.ssrLoadModule("/src/images.ts"));
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

function render({ messages = [], tools = [], busy = false, showMarkers = true, activityOpen = {}, onToggleActivity }, sessionId = "s1") {
  return renderToString(
    createElement(TranscriptView, {
      transcript: { messages, tools, notices: [] },
      busy,
      sessionId,
      sessionLabel: sessionId,
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
test("the rail passes through every dot, and no text is drawn behind it", () => {
  /*
   * Two defects from one screenshot (`img_37.png`), and both came from the same cause: the two kinds of ledger row
   * computed their dot positions differently.
   *
   *   - a TOOL row centred its dot with a `margin-left` derived from the dot column;
   *   - a THOUGHT row overrode that margin to `0`, because its dot lives inside a nested `<summary>` with its own
   *     padding.
   *
   * The results were 18px and 13.5px, so the rail ran through the thinking dots instead of through their centres. And
   * the thinking BODY was padded 10px from the row's left edge — left of the rail at 18px — so opening a thinking block
   * rendered the reasoning BEHIND the rail.
   *
   * The fix is one geometry, declared on the list and inherited: both row kinds take their padding, their dot column and
   * their text offset from the same variables, and the dot is a fixed-width COLUMN with the visible dot painted at its
   * centre. This asserts the arithmetic, because the arithmetic is what was wrong.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  const steps = /(?:^|\n)\.activity-steps\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const stepPad = Number(/--step-pad:\s*(\d+)px/.exec(steps)?.[1]);
  assert.ok(Number.isFinite(stepPad), "the ledger must declare its own padding as a number");

  // Both row kinds must use the SAME padding value — no override, or the dots diverge exactly as they did.
  const toolRow = /(?:^|\n)\.activity-step\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(toolRow, /padding:\s*\d+px var\(--step-pad\)/, "the tool row reads the shared padding");
  const thoughtHead = /\.activity-step\.is-thought \.activity-thought-head\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(thoughtHead, /padding:\s*\d+px var\(--step-pad\)/, "the thought row reads the same padding");

  // No margin arithmetic on the dot: it is a fixed-width column painted at its centre.
  assert.ok(
    !/\.activity-dot\s*\{[^}]*margin-left/.test(css),
    "the dot must not be positioned by margin, which is how the two row kinds diverged",
  );
  assert.ok(
    !/\.activity-dot\s*\{[^}]*width:\s*7px/.test(css),
    "the dot element is the COLUMN; the visible 7px dot is painted by ::after",
  );
  const dot = /(?:^|\n)\.activity-dot\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(dot, /width:\s*var\(--dot-column\)/, "the dot's box is the full column");

  // The rail is derived from the same two numbers, so it cannot drift from the dots.
  const rail = /\.activity-steps::before\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rail, /left:\s*calc\(var\(--step-pad\) \+ \(var\(--dot-column\) \/ 2\)/,
    "the rail is centred on the dot column, not on a number that happens to match it");

  // The reasoning starts at the row's TEXT column, never left of the rail.
  const body = /(?:^|\n)\.activity-thought-body\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(
    body,
    /padding:[^;]*var\(--step-text-x\)/,
    `the thinking body must start at the ledger's text column, not at the row's padding; got ${body}`,
  );
  assert.ok(
    !/padding:\s*var\(--sp-2\) 10px/.test(body),
    "the old 10px inset put the reasoning behind the rail",
  );
});

test("the trace panel's detail height does not follow the selected call", () => {
  /*
   * Reported: "the jumping trace detail window especially while traversing the traces is confusing and mentally
   * exhausting".
   *
   * The pane was `flex: 0 1 auto`, so its height came from its content — a two-line `echo` gave a short box and a
   * forty-line `ls` a tall one. Traversing with the arrow keys therefore resized the pane at every step, and the rows and
   * the scroll position moved under the reader.
   *
   * The property: in the PANEL, the pane's height is set by the reader (or the default), so switching calls changes only
   * what is inside it. The drawer keeps a content-fitted bound, because there it must share the reading column.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const panelDetail = /\.trace\.is-panel \.trace-detail\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(panelDetail, /flex:\s*none/, "the pane does not grow or shrink with its content");
  assert.ok(
    !/flex:\s*0 1 auto/.test(panelDetail),
    "`0 1 auto` is the defect: the height came from the content",
  );

  // And the component supplies an explicit height in the panel, plus a handle to change it.
  const source = readFileSync(new URL("../src/components/ToolTrace.tsx", import.meta.url), "utf8");
  assert.match(source, /trace-resizer/, "a drag handle exists");
  assert.match(source, /role="separator"/, "…described as a separator, like the panel's own resizer");
  assert.match(source, /aria-orientation="horizontal"/);
  assert.match(source, /onDoubleClick=\{\(\) => onResetDetailHeight/, "double-click restores the default");
  assert.match(source, /height: clampTraceDetailHeight/, "the pane is given an explicit height");
});

test("the trace list is ordered by a control, not by index numbers", () => {
  /*
   * Index numbers were added so rows could be told apart, but they earned a leading column for a value the reader does
   * not think in — and they made the list read as a spreadsheet rather than a log. What was actually missing is a choice
   * of DIRECTION: "newest first" is a real question when 44 calls have accumulated.
   */
  const source = readFileSync(new URL("../src/components/ToolTrace.tsx", import.meta.url), "utf8");
  assert.ok(!/t-index/.test(source), "no per-row index column");
  assert.match(source, /<TraceOrderMenu/, "an order control in the header");

  /*
   * The control itself is a filter glyph with a MENU, not a `<select>`.
   *
   * A native select works, but reads as a form field inside a strip of chrome, and at 11px its platform-drawn arrow was
   * the heaviest mark in the header. The glyph says "narrow the list"; the menu says the rest. Its accessibility is the
   * part worth guarding, because a custom menu is where keyboard behaviour goes missing.
   */
  const menu = readFileSync(new URL("../src/components/TraceOrderMenu.tsx", import.meta.url), "utf8");
  assert.match(menu, /aria-haspopup="menu"/, "the trigger announces that it opens a menu");
  assert.match(menu, /aria-expanded=\{open\}/, "…and whether it is open");
  assert.match(menu, /role="menu"/);
  assert.match(menu, /role="menuitemradio"/, "the items are mutually exclusive choices");
  assert.match(menu, /aria-checked=/, "…with the current one checked");
  assert.match(menu, /Oldest first/, "oldest first is offered");
  assert.match(menu, /Newest first/);
  // Escape must close AND return focus — a surface opened from the keyboard has to be closable from it.
  assert.match(menu, /event\.key === "Escape"[\s\S]{0,200}?close\(true\)/, "Escape closes and refocuses");
  // An outside click must close it, on the CAPTURE phase so a row underneath does not act first.
  assert.match(menu, /addEventListener\("pointerdown", onPointerDown, true\)/, "an outside click closes it");
  // The active state must be visible without opening the menu, and not by colour alone: the glyph fills.
  assert.match(menu, /data-active=/, "the trigger carries its state");
  // The GLYPH must show the current order without opening the menu, and by SHAPE rather than colour so
  // `forced-colors` cannot remove it: the arrow points down for oldest-first and up for newest-first.
  assert.match(
    menu,
    /order === "oldest" \? "M12\.5 2\.5v11/,
    "the sort arrow points down for oldest-first and up for newest-first",
  );
  // A funnel means FILTER — narrow the set. This reorders and hides nothing, so the mark must be the sort bars.
  assert.ok(!/M2\.5 3\.5h11l-4\.2 5/.test(menu), "no funnel glyph: this control does not filter");

  // Traversal must follow the DISPLAYED order: in a reversed list an arrow key that moved through the underlying data
  // would jump in the wrong direction.
  assert.match(source, /const ordered = orderTools\(tools, order\)/);
  assert.match(source, /ordered\.findIndex/, "the arrow keys walk the displayed order");
});

test("the order menu opens where there is room, not off the panel's edge", () => {
  /*
   * Reported: "the menu that opens is opening to the left, which means it gets cut off".
   *
   * It was anchored `right: 0`, which resolves against the TRIGGER's right edge. The trigger is a ~22px icon sitting
   * mid-header, so a 230px menu grew leftward out of the panel and was clipped. The trigger is near the panel's left
   * side, so the menu must open RIGHTWARD from its left edge.
   *
   * Asserted as arithmetic on the declaration, because the failure is geometric: a right anchor on a small element near
   * the left edge can only produce a menu that leaves the panel.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const menu = /(?:^|\n)\.trace-order-menu\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(menu, /position:\s*absolute/, "the menu is positioned against its trigger");
  assert.match(menu, /left:\s*0/, "it opens rightward from the trigger's LEFT edge");
  assert.ok(
    !/right:\s*0/.test(menu),
    "a right anchor on a small trigger near the left edge can only grow the menu off the panel",
  );
  assert.match(menu, /top:\s*calc\(100%/, "…and downward, below the header");
});

// --- Images in a turn ---------------------------------------------------------------------------

/** A 1x1 transparent PNG, base64. Real bytes, so `atob` and `Blob` get something valid. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Run `body` with `URL.createObjectURL` stubbed and the blob-URL cache EMPTY.
 *
 * Both halves matter. jsdom has no `createObjectURL`, so it must be stubbed. The cache must also be cleared, because
 * it is module-level by design (that is what makes a re-render free) and would otherwise carry an entry from an earlier
 * test — which is the cache doing its job, and a test that then counted Blob creations would be asserting on misses.
 */
function withBlobs(body) {
  const original = URL.createObjectURL;
  const created = [];
  clearImageCache();
  URL.createObjectURL = (blob) => {
    created.push(blob.type);
    return `blob:test/${created.length}`;
  };
  try {
    body(created);
  } finally {
    URL.createObjectURL = original;
    clearImageCache();
  }
}

const image = (overrides = {}) => ({
  kind: "image",
  contentIndex: 0,
  type: "image/png",
  base64: PIXEL,
  ...overrides,
});

test("a pasted screenshot RENDERS, in the reader's own turn (the blank-turn defect)", () => {
  /*
   * Before this, an image-only user message produced no planned entry at all and the transcript showed nothing where
   * the reader's message was. This asserts the whole path end to end: block → plan → `<img src>`.
   */
  withBlobs((created) => {
    const html = render(
      {
        messages: [{ id: "u1", role: "user", blocks: [image()], complete: true, streaming: false }],
      },
      "render-basic",
    );

    assert.match(html, /<span>You<\/span>/, "the turn is labelled, so the image has an owner");
    assert.match(html, /<img[^>]*class="turn-image-img"/, "an image element, not a note");
    assert.match(html, /src="blob:test\/1"/, "…pointing at a blob URL");
    // SSR separates adjacent expressions with `<!-- -->`, so the caption is matched across them rather than as one
    // literal string. The SIZE asserted is 70 B: base64 length 96 decodes to 70 bytes, not 96.
    assert.match(html, /image\/png[\s\S]{0,40}70 B/, "captioned with the type and the DECODED size");
    assert.deepEqual(created, ["image/png"], "the Blob carries Pi's type, not a sniffed guess");
  });
});

test("two images get two URLs, and a re-render of the same one gets none", () => {
  /*
   * Both halves of the cache contract, in one test, because the failure modes are opposite:
   *
   *   - two DIFFERENT images sharing one URL would draw the wrong picture;
   *   - the SAME image getting a fresh URL on every render is the decode storm this cache exists to prevent — the
   *     transcript re-plans once per streaming record, so that would be dozens of Blob creations a second.
   */
  withBlobs((created) => {
    const messages = [
      { id: "u1", role: "user", blocks: [image()], complete: true, streaming: false },
      { id: "u2", role: "user", blocks: [image({ base64: "QUJDREVG" })], complete: true, streaming: false },
    ];
    const first = render({ messages }, "render-two");
    assert.equal(created.length, 2, "each image is its own picture");
    const urls = [...first.matchAll(/src="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(urls, ["blob:test/1", "blob:test/2"], "and they are told apart");

    // A re-render of the SAME conversation — which is what every streaming record causes.
    const again = render({ messages }, "render-two");
    assert.equal(created.length, 2, "no new Blobs for an unchanged conversation");
    assert.deepEqual(
      [...again.matchAll(/src="([^"]+)"/g)].map((match) => match[1]),
      urls,
      "and the very same URLs, so nothing is re-decoded",
    );
    assert.equal(liveImageCount(), 2);
  });
});

test("the image is lazy and async-decoded, which is what keeps a 37-image conversation usable", () => {
  /*
   * `lazy` defers both the fetch and the decode for an image that is not near the viewport; `async` keeps whatever
   * raster remains off the main thread. Without them, opening a conversation with 37 screenshots decodes all of them
   * at once — ~130 MB of RGBA and a visible stall on the exact interaction this feature exists for (a reload while a
   * run streams).
   */
  withBlobs(() => {
    const html = render(
      {
        messages: [
          { id: "u1", role: "user", blocks: [image()], complete: true, streaming: false },
          { id: "u2", role: "user", blocks: [image({ base64: "QUJDREVG" })], complete: true, streaming: false },
        ],
      },
      "render-lazy",
    );
    const images = [...html.matchAll(/<img[^>]*class="turn-image-img"[^>]*>/g)].map((match) => match[0]);
    assert.equal(images.length, 2);
    for (const img of images) {
      assert.match(img, /loading="lazy"/, "offscreen images are not fetched or decoded on open");
      assert.match(img, /decoding="async"/, "raster never blocks the main thread mid-stream");
    }
  });
});

test("an unsupported image type is STATED rather than drawn or silently omitted", () => {
  const html = render({
    messages: [
      { id: "u1", role: "user", blocks: [image({ type: "image/tiff", refused: "unsupported-type" })], complete: true, streaming: false },
    ],
  });
  assert.ok(!/<img/.test(html), "nothing is handed to the browser that it may refuse to draw");
  assert.match(html, /image\/tiff/, "the recorded type is named");
  assert.match(html, /not shown/, "and the reader is told, rather than shown a blank space");
  assert.match(html, /the agent can still see it/, "a refusal here is not a claim that the model lacks the image");
});

test("an image with no payload says so, and does not accuse the browser", () => {
  // "no data recorded" and "your browser could not decode it" are different facts. Collapsing them would tell the
  // reader to try another browser over a session that genuinely holds nothing.
  const html = render({
    messages: [
      { id: "u1", role: "user", blocks: [image({ base64: "", refused: "no-payload" })], complete: true, streaming: false },
    ],
  });
  assert.match(html, /no data/, "the payload's absence is stated");
  assert.match(html, /empty payload/, "…and attributed to the session, not the browser");
  assert.ok(!/could not display/i.test(html), "no false accusation about decoding");
});

test("text and an image in one turn render BOTH, prose first", () => {
  const created = [];
  const original = URL.createObjectURL;
  URL.createObjectURL = () => {
    created.push(true);
    return "blob:test/pixel";
  };
  try {
    const html = render({
      messages: [
        {
          id: "u1",
          role: "user",
          blocks: [{ kind: "text", text: "what is wrong here?", complete: true }, image({ contentIndex: 1 })],
          complete: true,
          streaming: false,
        },
      ],
    });
    const prose = html.indexOf("what is wrong here?");
    const img = html.indexOf("turn-image-img");
    assert.ok(prose >= 0 && img >= 0, "both are present");
    assert.ok(prose < img, "the prose comes first: the image is the thing it refers to");
  } finally {
    URL.createObjectURL = original;
  }
});

test("a payload that cannot be decoded is STATED, and the rest of the conversation survives", () => {
  /*
   * A corrupt or truncated base64 throws in `atob`, and the whole component must not throw with it — the transcript is
   * the reading surface, and one bad screenshot cannot be allowed to blank a conversation. `images.ts` returns
   * `undefined` instead, and the component states the reason rather than rendering an empty box, which would read as
   * "there is no image here".
   *
   * The same distinction `ImageViewer.tsx` documents for the file pane: a refusal is reported, never silently turned
   * into emptiness.
   */
  withBlobs(() => {
    const html = render(
      {
        messages: [
          { id: "u1", role: "user", blocks: [{ kind: "text", text: "before", complete: true }], complete: true, streaming: false },
          // Padding in the middle of a base64 string is not valid: `atob` throws "Invalid character".
          { id: "u2", role: "user", blocks: [image({ base64: `${PIXEL}AAAA` })], complete: true, streaming: false },
          { id: "u3", role: "user", blocks: [{ kind: "text", text: "after", complete: true }], complete: true, streaming: false },
        ],
      },
      "render-broken",
    );
    assert.match(html, /before/, "a turn before the bad image still renders");
    assert.match(html, /after/, "…and so does one after it");
    assert.match(html, /Could not display this image/, "the failure is named");
    assert.match(html, /The session holds it/, "…without claiming the image is lost");
  });
});

test("the live-URL cache is BOUNDED, so a long conversation cannot hold every decode at once", () => {
  /*
   * The number that actually threatens a tab is decoded pixels, not transfer: 37 images at ~1100x800 is ~130 MB of
   * RGBA. The cache evicts the least recently used URL past `MAX_LIVE_IMAGES`, which is safe because the base64 stays
   * in the transcript — an evicted image simply re-materialises if the reader scrolls back to it.
   */
  withBlobs(() => {
    clearImageCache();
    const count = 40;
    for (let index = 0; index < count; index += 1) {
      // Distinct base64 per image, so each is its own entry rather than a cache hit on identical bytes. The unit is 4
      // characters ("QUJD" = "ABC"), because a base64 string whose length is not a multiple of four is invalid and the
      // component would report a decode failure instead of an image.
      const payload = "QUJD".repeat(1 + index);
      const html = render(
        {
          messages: [{ id: `m${index}`, role: "user", blocks: [image({ base64: payload })], complete: true, streaming: false }],
        },
        "render-bound",
      );
      assert.match(html, /turn-image-img/);
    }
    assert.ok(liveImageCount() <= 24, `bounded, got ${liveImageCount()}`);
    clearImageCache();
  });
});
