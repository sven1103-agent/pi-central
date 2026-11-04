/**
 * A session's controls, in the companion panel beside the transcript.
 *
 * ## The report, and the two designs it killed
 *
 * *"noboday can hit the right controls in the stopped session card"* — Resume, Forget and Delete were three inline
 * buttons pinned to a row's corner in a 288px column; they overlapped the row's text, spilled past its edge and could
 * not be clicked.
 *
 * Then a `⋯` menu in the same corner: *"i dont like the approach, the menu is very tiny. Maybe we introduce these as
 * session control actions in the session companion next to the transcript?"*
 *
 * So the controls live in the panel — full-size buttons with labels, in the place that already held Rename and Stop.
 * The rail row carries none. This file pins the RULES, which are the part that can be got wrong:
 *
 *   - a running session offers Stop and nothing destructive;
 *   - a stopped one offers Resume plus the housekeeping;
 *   - a failed one offers Retry, and states why when it cannot;
 *   - the irreversible action is last and carries the danger colour.
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

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The rule whose SELECTOR IS EXACTLY `selector`, anchored at the start of a line.
 *
 * Anchored because a loose pattern matches a compound selector that ENDS in the same class — `.rail-row:hover
 * .context-bar { }` satisfied `/\.context-bar ?\{/` — so a question about a base rule answered itself with an override.
 * Found when an override was added; the selector is the subject, so it is matched as one.
 */
function ruleExact(selector) {
  const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`^${wanted} ?\\{([^}]*)\\}`, "gm"))];
  return all.length > 0 ? all[all.length - 1][1] : undefined;
}

let server, sessionControlsFor, Inspector, SessionHeader, SessionRail;
before(async () => {
  server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ sessionControlsFor, Inspector } = await server.ssrLoadModule("/src/components/Inspector.tsx"));
  ({ SessionRail } = await server.ssrLoadModule("/src/components/SessionRail.tsx"));
  ({ SessionHeader } = await server.ssrLoadModule("/src/components/SessionHeader.tsx"));
});
after(async () => {
  await server?.close();
});

const FILE = "/sessions/p/a.jsonl";

function session(over = {}) {
  return {
    id: "s3",
    name: "data manager work",
    cwd: "/Users/x/git/data-manager",
    state: "stopped",
    mode: "sandboxed",
    isolation: "",
    command: "",
    scratch: false,
    messageCount: 4,
    pending: 0,
    contextPercent: 40,
    tokensTotal: null,
    cost: null,
    dialogs: [],
    warnings: [],
    startedAt: 0,
    sessionFile: FILE,
    ...over,
  };
}

/** Every callback, so a test's assertion is about the RULE rather than about which hooks the caller passed. */
const allCaps = {
  onStop() {},
  onResume() {},
  onRetry() {},
  retryAvailable: true,
  onForget() {},
  onDelete() {},
};

const labels = (state, caps = allCaps) => sessionControlsFor(session({ state }), caps).map((c) => c.label);

test("a STOPPED session offers Resume, Forget and Delete", () => {
  // The reported dead end: after Stop there was no way to resume, forget or delete. Resume comes first because it is
  // the one that continues the work.
  assert.deepEqual(labels("stopped"), ["Resume session", "Forget", "Delete transcript"]);
});

test("a RUNNING session offers Stop, and nothing destructive", () => {
  // A process holds the transcript open: deleting it would leave a file being written to after it was unlinked.
  for (const state of ["idle", "streaming", "starting", "awaiting-approval"]) {
    assert.deepEqual(labels(state), ["Stop session"], `${state} offers only Stop`);
  }
});

test("a FAILED session offers Retry plus the housekeeping", () => {
  assert.deepEqual(labels("failed"), ["Retry", "Forget", "Delete transcript"]);
});

test("Retry is stated as unavailable, not offered, against an older orchestrator", () => {
  // A button that fails when pressed is worse than an explanation where the button would be.
  const controls = sessionControlsFor(session({ state: "failed" }), { ...allCaps, retryAvailable: false });
  const retry = controls.find((c) => c.key === "retry");
  assert.equal(retry, undefined, "no Retry control");
  const unavailable = controls.find((c) => c.key === "retry-unavailable");
  assert.ok(unavailable, "the absence is stated");
  assert.equal(unavailable.disabled, true);
  assert.match(unavailable.title, /restart the orchestrator/i);
});

test("the irreversible action is LAST and carries the danger colour", () => {
  // A destructive control should never be the first thing under the pointer.
  for (const state of ["stopped", "failed"]) {
    const controls = sessionControlsFor(session({ state }), allCaps);
    assert.equal(controls.at(-1).key, "delete", `${state}: Delete is last`);
    assert.equal(controls.at(-1).danger, true, `${state}: and only Delete is a danger action`);
    assert.ok(!controls.slice(0, -1).some((c) => c.danger === true), `${state}: nothing else is destructive`);
  }
});

test("Forget and Delete cannot be mistaken for each other", () => {
  const controls = sessionControlsFor(session({ state: "stopped" }), allCaps);
  assert.match(controls.find((c) => c.key === "forget").title, /not deleted/);
  assert.match(controls.find((c) => c.key === "delete").title, /cannot be undone/);
});

test("Resume says what it does NOT do, because it spends a spawn", () => {
  const resume = sessionControlsFor(session({ state: "stopped" }), allCaps).find((c) => c.key === "resume");
  assert.match(resume.title, /same directory/, "the directory is preserved");
  assert.match(resume.title, /transcript continues/, "and the conversation is continued");
});

test("a control is only offered when the shell can carry it out", () => {
  // The list is derived from what the caller passes, so an action the shell cannot perform never appears.
  assert.deepEqual(labels("stopped", { retryAvailable: true }), [], "no callbacks, no controls");
});

// --- Rendered: the panel and the rail -----------------------------------------------------------

test("the panel renders the controls as full-size buttons", () => {
  // The whole point of moving them: room for labels instead of a 22px glyph in a 288px column.
  const html = renderToString(
    createElement(Inspector, {
      session: session({ state: "stopped" }),
      home: "/Users/x",
      onStop() {},
      onRename() {},
      onResume() {},
      onForget() {},
      onDelete() {},
      retryAvailable: true,
    }),
  );
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const section = [...doc.querySelectorAll("section")].find((s) => /Actions/.test(s.textContent ?? ""));
  assert.ok(section, "there is an Actions section");
  const buttons = [...section.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
  for (const label of ["Resume session", "Forget", "Delete transcript"]) {
    assert.ok(buttons.includes(label), `${label} is a button, got ${JSON.stringify(buttons)}`);
  }
  // Delete is the only one in the danger style.
  const danger = [...section.querySelectorAll(".btn-danger")].map((b) => (b.textContent ?? "").trim());
  assert.deepEqual(danger, ["Delete transcript"]);
});

test("the RAIL ROW carries no actions at all", () => {
  // Two cramped attempts live in this file's header; the row is a view of the session, not a control surface.
  const html = renderToString(
    createElement(SessionRail, {
      rows: [{ entry: { path: FILE, cwd: "/Users/x/git/data-manager", name: "data manager work" }, session: session({ state: "stopped" }) }],
      focusedId: undefined,
      onFocusRow() {},
      onForgetRow() {},
      onRetryRow() {},
      retryAvailable: true,
      onStartSession() {},
      onOpenDirectory() {},
      home: "/Users/x",
      historyTotal: 0,
      openAsDrawer: false,
      onCloseDrawer() {},
    }),
  );
  for (const gone of ["rail-row-menu", "rail-row-forget", "rail-row-retry", "rail-row-stop", "rail-row-delete"]) {
    assert.ok(!html.includes(gone), `the row must not carry ${gone}`);
  }
});

// --- The control bar on the session header ------------------------------------------------------

/** The header for one session in one state, with every callback available. */
function headerFor(state) {
  return renderToString(
    createElement(SessionHeader, {
      session: session({ state }),
      home: "/Users/x",
      models: [],
      modelError: undefined,
      onRequestModels() {},
      onSelectModel() {},
      thinking: { levels: undefined, error: undefined },
      onRequestThinkingLevels() {},
      onSelectThinkingLevel() {},
      onRename() {},
      controls: allCaps,
    }),
  );
}

test("the control bar is icon-only, and each icon carries its label for assistive tech", () => {
  // Asked for: "maybe the words are too long. Can we try icons only? For delete we can use a trash bin (and maybe in
  // red). resume in green."
  //
  // Icon-only is safe HERE because two things carry the words: `aria-label` (what a screen reader announces) and `title`
  // (what a hovering reader reads). Without either, DESIGN §681's objection stands — an icon is undiscoverable to
  // someone who reads words.
  const doc = new JSDOM(`<body>${headerFor("stopped")}</body>`).window.document;
  const bar = doc.querySelector(".session-header .session-controls");
  assert.ok(bar, "the bar is inside the session header");
  assert.equal(bar.getAttribute("role"), "group");

  const buttons = [...bar.querySelectorAll(".session-control")];
  assert.deepEqual(buttons.map((b) => b.getAttribute("aria-label")), ["Resume session", "Forget", "Delete transcript"]);

  // No visible text: the label lives in the attributes, which is what "icon-only" means.
  assert.ok(buttons.every((b) => (b.textContent ?? "").trim() === ""), "no visible words");
  // A real drawn icon, not a character: a character can be missing from the platform's fonts (that is how the previous
  // unicode mark became an empty box), an inline path cannot.
  assert.ok(buttons.every((b) => b.querySelector("svg path, svg rect") !== null), "each button draws an SVG shape");
  // The destructive one says what it does in its tooltip, which is where a hovering reader checks.
  assert.match(buttons.at(-1).title, /cannot be undone/);
});

test("the icons use the theme's own tokens, and differ in SHAPE as well as colour", () => {
  // Colour is reinforcement. Each mark is also a distinct silhouette — a play triangle, a bin, an eye with a slash — so
  // nothing is lost to a reader who cannot tell green from red.
  const doc = new JSDOM(`<body>${headerFor("stopped")}</body>`).window.document;
  const buttons = [...doc.querySelectorAll(".session-control")];
  const resumes = buttons.find((b) => b.getAttribute("aria-label") === "Resume session");
  const deletes = buttons.find((b) => b.getAttribute("aria-label") === "Delete transcript");
  assert.match(resumes.className, /session-control-resume/, "Resume is coloured by its own class");
  assert.match(deletes.className, /session-control-delete/, "and Delete by its own");

  // The tokens are the app's existing ones, not a new palette.
  assert.match(ruleExact(".session-control-resume") ?? "", /color:\s*var\(--ok\)/);
  assert.match(ruleExact(".session-control-delete") ?? "", /color:\s*var\(--danger-text\)/);
  // And the shapes differ: Resume is a filled triangle, Delete is a stroked bin.
  assert.ok(resumes.querySelector("svg[fill='currentColor']"), "Resume draws a filled shape");
  assert.ok(deletes.querySelector("svg path"), "Delete draws a bin path");
});

test("the bar fits ONE line", () => {
  // It wrapped onto a second line inside a header with room to spare, because `.header-lower` was sized to the narrower
  // picker column. Reported from a screenshot: "not sure if it is an improvement".
  const lower = ruleExact(".header-lower") ?? "";
  assert.match(lower, /align-items:\s*stretch/, "the column stretches, so the bar gets the full width");
});

test("the controls do not borrow the shared `btn` class", () => {
  // `.btn` is defined LATER in the stylesheet with a background, a border and a radius at the same specificity, so it
  // silently won the cascade and the "no chrome" bar still drew as three bordered buttons — found from a screenshot
  // after I had claimed the chrome was gone.
  const doc = new JSDOM(`<body>${headerFor("stopped")}</body>`).window.document;
  for (const button of doc.querySelectorAll(".session-control")) {
    assert.ok(!/\bbtn\b/.test(button.className), `must not carry .btn, got "${button.className}"`);
  }
});

test("the bar renders NOTHING when the shell offers nothing", () => {
  // An empty bar would be a group with no controls — and a `<div>` with a border and no content is a visible artefact.
  const html = renderToString(
    createElement(SessionHeader, {
      session: session({ state: "stopped" }),
      home: "/Users/x",
      models: [],
      modelError: undefined,
      onRequestModels() {},
      onSelectModel() {},
      thinking: { levels: undefined, error: undefined },
      onRequestThinkingLevels() {},
      onSelectThinkingLevel() {},
      onRename() {},
    }),
  );
  assert.ok(!/session-controls/.test(html), "no bar without actions");
});

test("the targets meet the app's own minimum for row actions", () => {
  // DESIGN.md §713: "row actions 32x32 minimum even though this is a mouse product". These were 28 — a documented
  // standard the code did not meet, and they are the only icon-only controls in the app, so there was no consistency
  // argument for the exception.
  const control = ruleExact(".session-control") ?? "";
  assert.match(control, /width:\s*32px/, `32px wide, got ${JSON.stringify(control)}`);
  assert.match(control, /height:\s*32px/, "and 32px tall");
});

test("the icons are 16px, which is what keeps them off the 'afterthought' line", () => {
  // At 14px in a 28px target in a band with 4px gaps, they were the smallest marks in a dense header while being the
  // most consequential controls on it.
  const doc = new JSDOM(`<body>${headerFor("stopped")}</body>`).window.document;
  for (const svg of doc.querySelectorAll(".session-control svg")) {
    assert.equal(svg.getAttribute("width"), "16");
    assert.equal(svg.getAttribute("height"), "16");
  }
});

test("FORGET is a list with a minus, not an eye with a slash", () => {
  // The eye-slash means "visibility off" in essentially every icon system (password reveal, layer visibility,
  // tracking prevention). Forget means "take this off the rail and keep the file". A reader guessed "hide" by luck and
  // could guess something else entirely — and it sits beside the irreversible action.
  //
  // Asserted on the SHAPE: a list-with-minus draws horizontal rules and no closed eye outline.
  const doc = new JSDOM(`<body>${headerFor("stopped")}</body>`).window.document;
  const forget = [...doc.querySelectorAll(".session-control")].find((b) => b.getAttribute("aria-label") === "Forget");
  const paths = [...forget.querySelectorAll("path")].map((path) => path.getAttribute("d"));
  assert.ok(
    paths.some((d) => /^M2\.5 4h11/.test(d ?? "")),
    `the top rule of a list, got ${JSON.stringify(paths)}`,
  );
  assert.ok(!paths.some((d) => /s2\.2-3\.5/.test(d ?? "")), "and NOT the eye outline");
});

test("the destructive control is set apart from the safe ones", () => {
  // Uniform 4px gaps made three peers of Resume, Forget and Delete, with nothing saying the last one is different in
  // kind. Colour helped but said nothing about grouping.
  const del = ruleExact(".session-control-delete") ?? "";
  assert.match(del, /margin-left:\s*var\(--sp-2\)/, `a gap before Delete, got ${JSON.stringify(del)}`);
  // A drawn hairline, so the boundary survives `forced-colors` where the colour difference may not.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(
    css,
    /\.session-control-delete::before\s*\{[^}]*background:\s*var\(--line-strong\)/,
    "and a hairline beside it",
  );
});
