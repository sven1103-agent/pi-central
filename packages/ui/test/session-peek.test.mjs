/**
 * The peek rail: the session's details, without giving them the conversation's width (issue #275, third slice).
 *
 * ## The report
 *
 * *"we see the current transactions detail panel, when the conversation has the window. First, i dont know what this
 * means. Maybe for the reader mode, we can show the details when hovering a minimal version of the detail panel, and have
 * an option to pin it open manually"* — two complaints. It held 340px the mode existed to give back, and nothing said what
 * it was.
 *
 * ## The three properties that stop it being a new set of bugs
 *
 *   1. **The prose must not move.** An overlay takes the panel out of flow; a track that widened on hover would reflow
 *      every line under the cursor, which is the failure `roster.ts` records for row order.
 *   2. **A closed overlay must not eat clicks.** A 340px invisible box over the conversation is the one hazard an
 *      overlay introduces, so `pointer-events` is off until the tab arms it, and `inert` agrees in the markup.
 *   3. **It must be usable without a pointer.** Hover alone is unusable by keyboard and touch, so the tab is a button,
 *      it opens on focus, and Escape unpins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRailPrefs, defaultRailPrefs, serializeRailPrefs } from "../src/rail-prefs.ts";

const read = (name) => readFileSync(new URL("../src/" + name, import.meta.url), "utf8");
const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector) {
  const wanted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp("^" + wanted + "\\s*\\{([^}]*)\\}", "gm"))];
  return all.length > 0 ? all.map((match) => match[1]).join("\n") : undefined;
}

test("the latch is off by default, and is not re-persisted by the shell", () => {
  /*
   * Off by default because the resting state must be the calm one the mode exists for. Falsified by defaulting
   * peekPinned to true — the mode would look like the column it replaced.
   *
   * And it is the one rail value the shell does NOT persist: it covers prose, so restoring it would restore an
   * occlusion nobody remembers asking for. `parseRailPrefs` keeps reading a stored value (an older session's latch is
   * honoured in memory), so the assertion is on the WRITE SITE — the setter must not be the persisting one.
   */
  assert.equal(defaultRailPrefs().peekPinned, false);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const setter = /onPeekPinned=\{[\s\S]*?\}\n/.exec(app)?.[0] ?? "";
  assert.ok(setter.length > 0, "the shell owns the latch");
  assert.ok(
    !/setRailPrefsAndPersist/.test(setter),
    "the latch is not written to localStorage: an overlay over the prose must be re-asked for each time",
  );
  assert.match(setter, /setRailPrefs/, "but it is set, so the overlay still opens");
  assert.equal(parseRailPrefs(serializeRailPrefs({ ...defaultRailPrefs(), peekPinned: true }), 0).peekPinned, true);
  assert.equal(parseRailPrefs('{"peekPinned":"true"}', 0).peekPinned, false);
});

test("the peek is the COMPANION box, narrowed — not a second layout", () => {
  /*
   * Three tracks, exactly the ones the wide row uses, so the prose is centred the same way in both modes. What changes is
   * the ITEM in the trailing track — `max-width: var(--peek-tab)` at rest, `var(--companion-width)` when open — which is
   * how `.transcript-header` already works there. The tab is not a second design; it is the same box with less room.
   *
   * Two failures this guards, both shipped in the same afternoon:
   *
   *   1. a FIXED third track beside the flexible first one — it takes no space, so the prose is pushed against the right
   *      edge;
   *   2. "fixing" that with `max(var(--reading-leading), var(--peek-tab))`, which is not CSS: `minmax()` of `1fr` is a track
   *      size, not a `<length>`, so the declaration is invalid and the grid collapses to one implicit column. Reported as
   *      three slivers of text against the right-hand side.
   *
   * Falsified by writing either of those as the track list: the template assertion reports it.
   */
  const row = rule(".transcript-wrap.has-peek") ?? "";
  assert.ok(row.length > 0, "the peek row must have a rule");
  assert.match(row, /display:\s*grid/, "the same row the wide layout uses");
  const tracks = /grid-template-columns:\s*([^;]+);/.exec(row)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  assert.equal(
    tracks,
    "var(--reading-leading) var(--reading-lane) var(--reading-trailing)",
    "the SAME three tokens as the wide row — symmetry as arithmetic, not as a literal",
  );
  assert.match(row, /grid-template-rows:\s*minmax\(0,\s*1fr\)/, "one height-absorbing row, or the scroller cannot scroll");

  /*
   * The ITEM carries the state, and it is selected by the ROW, not by its bare class.
   *
   * THE CASCADE BUG, reported as "its still broken": the box also wears `.transcript-header`, which is declared hundreds of
   * lines AFTER `.transcript-header-peek` at the same specificity — so a bare-class `max-width: var(--peek-tab)` lost to the
   * shared rule's `max-width: var(--companion-width)`, and the "tab" was a transparent 340px box with the tab at its far
   * edge. Source order is not an argument a stylesheet this size can win, so the selector names the row.
   *
   * Falsified by writing `.transcript-header-peek {` as the selector: the rule is then not found here, and the guard below
   * reports the bare-class declaration that would have lost.
   */
  const box = rule(".transcript-wrap.has-peek > .transcript-header-peek") ?? "";
  assert.ok(box.length > 0, "the item's rule is selected by the row, so it outranks `.transcript-header`");
  assert.ok(
    rule(".transcript-header-peek") === undefined,
    "no bare-class rule: it would lose to `.transcript-header`, which is declared later at the same specificity",
  );
  /*
   * THE TAB NEVER MOVES, AND THE BOX DOES NOT DEPEND ON GRID SIZING.
   *
   * Two reports shaped this. "It is jumping on hover": the box began where the lane ends, so opening the panel resized the
   * track, the lane slid left, and the tab — the element the pointer was on — slid with it; the pointer left the tab, the
   * panel closed, and the tab slid back under the pointer: a hover target that moves away from the hover is a loop.
   *
   * And, measured from a real window: the box was 30 x 0 in a 793px row, because `align-self: stretch` was not producing
   * a height, so the tab sat below a zero-height box with `overflow: hidden` and was clipped away. It was in the DOM,
   * 30x63, and invisible.
   *
   * So the box is `position: absolute` against the row with `top: 0; bottom: 0; right: 0`: its height is the row's by
   * construction and its right edge is the wrap's own edge in EVERY state. Falsified by dropping `bottom: 0` (the height
   * returns to whatever the grid decides) or `right: 0` (the tab follows the lane again).
   */
  assert.match(box, /position:\s*absolute/, "out of the grid, so grid sizing cannot give it zero height");
  assert.match(box, /top:\s*0/);
  assert.match(box, /bottom:\s*0/, "the row's height by construction");
  assert.match(box, /right:\s*0/, "the wrap's own edge in every state, so the tab never moves under the pointer");
  assert.ok(!/justify-self|align-self|margin-right/.test(box), "no grid-item placement left to disagree with it");
  assert.match(box, /width:\s*var\(--peek-tab\)/, "at rest the box IS the tab, a FIXED width");

  /*
   * OPEN: the companion's width, capped by the room the row reserves for it (45% of the row plus the strip), so the box and
   * the open track agree about how much space the panel has.
   */
  const open = rule(".transcript-wrap.has-peek.is-peek-open > .transcript-header-peek") ?? "";
  /*
   * The PANEL gets the companion's FULL width and the tab is added to it. Reported from a screenshot as "some width missing,
   * a horizontal scroll bar, controls slightly cut off": the box was the companion's width INCLUDING the tab, so the panel
   * was 340 - 30 = 310px and the stats row (meter, cost, two icon buttons) did not fit what the wide layout gives it.
   *
   * Falsified by dropping `+ var(--peek-tab)`: the panel is 310px again and this reports it.
   */
  assert.match(
    open,
    /width:\s*calc\(min\(var\(--companion-width\), calc\(45% - 0\.9 \* var\(--peek-tab\)\)\) \+ var\(--peek-tab\)\)/,
    "open: the companion's full width PLUS the tab, capped by the row",
  );
  assert.match(open, /background:\s*var\(--bg\)/, "opaque, since it can sit over the row's own padding");

  /*
   * AND THE LANE MOVES ONLY WHEN IT MUST. The open track is `minmax(<floor>, <ceiling>)` beside a leading `minmax(0, 1fr)`:
   * while each margin is wider than the floor the two split the free space as they did at rest, so the lane does not move
   * at all. Only a window with no room pins the track at the floor and makes the lane yield the difference.
   *
   * The previous version was a flat `min(companion, 45%)` track — fixed width, so it ALWAYS moved the lane by half the
   * difference between tab and companion. Falsified by returning to that: the ceiling token disappears and this fails.
   */
  const openRow = rule(".transcript-wrap.has-peek.is-peek-open") ?? "";
  const openTracks = /grid-template-columns:\s*([^;]+);/.exec(openRow)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  assert.equal(
    openTracks,
    "var(--reading-leading) var(--reading-lane) minmax(min(var(--companion-width), 45%), var(--reading-trailing-max))",
    "open: a floor and the reader's own ceiling, so the lane yields only what it has to",
  );

  /*
   * THE TAB'S STRIP IS RESERVED as symmetric padding, not carved out of a track. Measured from a real 518px transcript:
   * the columns resolved to `0px 470px 0px` — the lane takes every pixel it can — so a tab living in the margin was a 0x0
   * box clipped by its own `overflow: hidden`. The tab existed, 30x169, and nobody could see it.
   *
   * Falsified by removing the padding: the margin is zero again on any window narrower than lane + gaps.
   */
  assert.match(row, /padding-inline:\s*var\(--peek-tab\)/, "both sides, so the lane stays centred and the tab always has room");
  assert.match(row, /--peek-tab:\s*30px/, "one number: the padding, the resting width and the tab's thickness read it");

  /*
   * The tab is IN FLOW. It was `position: absolute` inside a box whose only content had collapsed, so it was clipped to a
   * stub ~12px tall — the first letter of "Details" rotated, which is all the screenshot showed. A flex item cannot be
   * clipped to a height it does not depend on.
   *
   * Falsified by restoring `position: absolute` on the tab.
   */
  const tab = rule(".session-peek-tab") ?? "";
  assert.ok(!/position:\s*absolute/.test(tab), "the tab is a flex item, so its height is its text's");
  assert.match(tab, /flex:\s*none/, "and it never shrinks below the label it carries");
  assert.match(rule(".session-peek") ?? "", /flex-direction:\s*row-reverse/, "the tab on the trailing edge, first in the DOM");
  assert.match(rule(".session-peek") ?? "", /pointer-events:\s*none/, "the strip is not itself a hover target");
  assert.match(tab, /pointer-events:\s*auto/, "only the tab arms it");

  // The content is an ordinary flex item, not positioned over anything.
  const panel = rule(".session-peek-panel") ?? "";
  assert.ok(!/position:\s*absolute/.test(panel), "the panel is in the flow, beside the prose");
  assert.match(panel, /flex:\s*1 1 0/, "it takes what the tab leaves: nothing at rest, the companion when open");
  assert.match(panel, /overflow-x:\s*hidden/, "a vertical scroller: a horizontal bar was the symptom of a panel too narrow for its stats row");
  assert.match(panel, /visibility:\s*hidden/, "hidden at rest");
  assert.match(rule(".session-peek.is-open .session-peek-panel") ?? "", /visibility:\s*visible/, "and visible when open");
});

test("Escape dismisses the overlay, rather than stopping the run underneath it", () => {
  /*
   * The first version registered the handler only while LATCHED (`if (!pinned) return`), so the ordinary case —
   * pointer over the tab — left Escape to the composer, whose binding stops the run. One keystroke that means "close
   * this overlay" therefore ended a streaming session.
   *
   * Falsified by restoring the `pinned` guard: the assertion reports that Escape is scoped to a latch again.
   */
  const source = read("components/SessionPeek.tsx");
  assert.match(source, /if \(!open\) return undefined;/, "the key is claimed whenever the panel is showing");
  assert.ok(!/if \(!pinned\) return undefined;/.test(source), "and not only while latched");
  assert.match(source, /setHovered\(false\)/, "all three states are cleared, or Escape looks broken under the pointer");
  assert.match(source, /event\.stopPropagation\(\)/, "and the composer's Escape never sees it");
});

test("the tab is READABLE: an icon, a state dot and a number — horizontal, with the sentence in the tooltip", () => {
  /*
   * The report: *"why is the tab vertical with text I can't read"*. It was `writing-mode: vertical-rl` with the words
   * "Details · idle · ctx 37%" at 10px — rotated small text, the least legible thing a 30px strip can hold.
   *
   * The first report (*"i dont know what this means"*) still has to be answered, and is: the glyph is the sliders the
   * pickers use, the dot is the state in the app's own colours, the number is the one figure that changes a decision, and
   * the full sentence is the tooltip AND the accessible name — so nothing depends on colour alone.
   *
   * Falsified by restoring `writing-mode: vertical-rl` on the tab: the first assertion reports rotated text.
   */
  const source = read("components/SessionPeek.tsx");
  const tab = rule(".session-peek-tab") ?? "";
  assert.ok(!/writing-mode/.test(tab), "no rotated text");
  assert.match(tab, /flex-direction:\s*column/, "marks stacked, each one horizontal");
  assert.match(source, /session-peek-icon/, "a glyph that says \"settings and details\"");
  assert.match(source, /session-peek-dot is-\$\{toneOf\(stateWord\)\}/, "the state, as a dot");
  assert.match(source, /shortContext\(contextLabel\)/, "and the context reading, as a number");
  assert.match(source, /aria-label=\{`\$\{label\} — \$\{stateWord\}, \$\{contextLabel\}`\}/, "the whole sentence is the accessible name");
  assert.match(source, /title=\{`\$\{label\} — \$\{stateWord\}, \$\{contextLabel\}/, "and the tooltip, so nothing rides on colour alone");
  assert.match(rule(".session-peek-ctx.is-full") ?? "", /color:\s*var\(--warn-text\)/, "the same warn token as the meter");

  /*
   * The word must not be swallowed by the latch. It was `pinned ? "Pinned" : "Details"`, so the tab stopped naming itself
   * at the one moment a reader is relying on it. The latch is a second CHANNEL on the same tab (an accent edge) and not a
   * different label. Falsified by restoring the ternary.
   */
  // Comments stripped first: SessionPeek's own note QUOTES the old ternary, as every note here quotes what it replaced.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/pinned \? "Pinned"/.test(code), "the label does not change with the state");
  assert.match(rule(".session-peek.is-pinned .session-peek-tab") ?? "", /box-shadow:\s*inset 3px 0 0 var\(--accent\)/, "latched is an accent edge");

  // The mapping is the whole of what the dot knows about a session, so it is asserted on the words the app uses.
  const mapping = [
    ["idle", "ok"], ["working", "busy"], ["starting", "busy"], ["needs you", "attention"], ["failed", "bad"], ["stopped", "idle"],
  ];
  for (const [word, tone] of mapping) {
    assert.match(source, new RegExp(`case "${word}":[\\s\\S]*?return "${tone}"`), `${word} → ${tone}`);
  }
});

test("it is usable without a pointer: a button, opened by focus, closed by Escape", () => {
  /*
   * A hover-only surface is unusable by keyboard, and this one holds the session's only controls when the panel is
   * closed. So the tab is a real button with aria-expanded and aria-controls, the panel opens when focus lands inside,
   * and Escape unpins.
   *
   * Falsified by removing the focus handler — a keyboard reader can then tab to a tab that opens nothing.
   */
  const source = read("components/SessionPeek.tsx");
  assert.match(source, /<button/, "a button, not a div");
  assert.match(source, /aria-expanded=\{open\}/, "states whether the panel is showing");
  assert.match(source, /aria-controls="session-peek-panel"/, "and names it");
  assert.match(source, /onFocus=\{/, "opens on focus, so the keyboard can reach the panel");
  assert.match(source, /addEventListener\("keydown", onKeyDown, \{ capture: true \}\)/, "capture, so one key is one action");
  assert.match(source, /event\.stopPropagation\(\)/, "and it does not travel to the composer's Escape");
});

test("the pickers' labelled controls get unique ids, because a session can be on screen twice", () => {
  /*
   * A consequence of the column coming BACK when the panel is open: the same session's details can now be rendered in
   * two frames at once — the column in the reading row, and the peek a reader opens beside it — so an id derived from
   * the session (`model-${session.id}`) names two elements, and every `<label htmlFor>` in that state points at whichever
   * the DOM parsed first. A label that focuses the wrong control is a defect, not a duplicate.
   *
   * Falsified by restoring `htmlFor={\`model-${session.id}\`}`: two mounts of one session then emit the same id.
   */
  for (const component of ["ModelPicker.tsx", "ThinkingPicker.tsx"]) {
    const source = read("components/" + component);
    assert.match(source, /useId\(\)/, `${component} derives its control id per mount`);
    assert.ok(
      !/htmlFor=\{\`(model|thinking)-\$\{session\.id\}/.test(source),
      `${component} does not derive htmlFor from the session id`,
    );
  }
});


test("the details are the SAME element in both frames, wearing the same class", () => {
  /*
   * A fact added to the session's identity must not need a second implementation for the peek. So the peek renders its
   * children inside `.transcript-header` — the very class the wide layout gives the column — and every rule that lays the
   * details out (the picker stack, the label column, the stats row, the control bar) applies unchanged.
   *
   * Falsified by wrapping the children in a differently named element: the twenty-five `.transcript-header .…` selectors
   * then match nothing and the details render as unstyled blocks, which is a defect this branch already shipped once.
   */
  const peek = read("components/SessionPeek.tsx");
  assert.match(peek, /<div className="transcript-header">\{children\}<\/div>/, "the shared frame class, reused");

  const source = read("components/Transcript.tsx");
  assert.match(source, /!peekOnly && <div className="transcript-header">\{details\}<\/div>/, "the column frame");
  assert.match(source, /peekOnly && \(/, "and the peek frame");
  const renders = [...source.matchAll(/\{details\}/g)].length;
  assert.equal(renders, 2, "the content is rendered in exactly two branches, found " + renders);
});

test("the frame is chosen by ONE condition, and the peek is anchored to the row", () => {
  /*
   * THE shipped bug: the sheet hid the column whenever focus was on and the Session panel was open, while the transcript
   * rendered the peek whenever focus was on — so the tab opened a 340px box with nothing in it. Two independent conditions
   * in two files, neither wrong alone, which is why every shape assertion passed.
   *
   * One condition now: `peekOnly = focus && panel.collapsed`. Falsified by dropping the panel half.
   */
  const shell = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(
    shell,
    /peekOnly=\{railPrefs\.focus && panel\.collapsed\}/,
    "the peek exists exactly when the panel is the only other surface",
  );

  /*
   * And it is a child of the WRAP — a sibling of the reading column, not something inside it — because the wrap is the
   * positioning context its `top/right/bottom: 0` resolve against. Nested in `.transcript-main` it would be anchored to the
   * reading column and could not reach the trailing edge of the row at all.
   */
  const source = read("components/Transcript.tsx");
  const peek = source.indexOf('<div className="transcript-header transcript-header-peek">');
  const main = source.indexOf('<div className="transcript-main">');
  assert.ok(peek > 0 && main > 0, "both boxes must exist");
  assert.ok(peek < main, "the peek is a sibling of the reading column, anchored by the row");
  assert.match(rule(".transcript-wrap") ?? "", /position:\s*relative/, "and the wrap is its containing block");
  assert.ok(
    rule(".transcript-wrap.has-peek .transcript-header-peek") === undefined,
    "it is out of the grid, so it must not be placed in a column — a stale placement rule would reintroduce a track for it",
  );
  assert.match(rule(".transcript-wrap.has-peek .transcript-main") ?? "", /grid-column:\s*2/, "beside the lane");
});

test("the details are laid out by the SAME rules in both frames", () => {
  /*
   * THE reported bug, and it was invisible to every test I had written: the peek panel wrapped the session header in a
   * differently named element, so all twenty-five `.transcript-header .…` selectors — the picker grid's rows and gaps, the
   * label column, the stats row, the control bar — matched NOTHING. The content rendered as unstyled blocks: Provider and
   * Model as bare text beside their selects, no grouping, no widths. The screenshot showed exactly that inside a
   * correctly sized panel.
   *
   * Every structural assertion up to this point asked about the FRAME (width, position, pointer-events) and none about
   * what was inside it, which is why a 340px panel full of unformatted text passed the suite.
   *
   * The rule this earns: the content-layout rules must be scoped to a class BOTH frames carry, so a fact laid out in the
   * column cannot be unformatted in the tab. Asserted as a JOIN — the peek must render a descendant wearing that class.
   */
  const peek = read("components/SessionPeek.tsx");
  assert.match(
    peek,
    /<div className="transcript-header">\{children\}<\/div>/,
    "the panel gives its children the SAME frame class the wide layout uses",
  );

  /*
   * And the count, so a later refactor that renames one side is caught: the details' layout lives in the scoped rules, and
   * there are many — a handful would mean most of it had moved somewhere the overlay does not reach.
   */
  const scoped = [...css.matchAll(/^\s*\.transcript-header \./gm)].length;
  assert.ok(scoped >= 10, "the details layout lives in " + scoped + " scoped rules; both frames must reach them");

  /*
   * The placement rules must be scoped NARROWER, to the row's own item, or the overlay inherits `position: sticky` and a
   * sticky element inside a scrolling overlay fights the overlay's own scroll. Narrower means a child combinator, which
   * the peek's copy — nested inside `.session-peek-panel` — is not matched by.
   */
  assert.match(
    rule(".transcript-wrap.has-header > .transcript-header") ?? "",
    /position:\s*sticky/,
    "sticky belongs to the row's item",
  );
  assert.ok(
    !/position:\s*sticky/.test(rule(".transcript-header") ?? ""),
    "and not to the shared class, which the overlay also wears",
  );
});

/*
 * ---------------------------------------------------------------------------------------------------------------
 * The panel fits the width it is given (issue #281).
 * ---------------------------------------------------------------------------------------------------------------
 */

/** Every `.selector { … }` block declared inside the named `@container` query, joined. */
function containerRules(name) {
  const start = css.indexOf(`@container ${name} `);
  if (start === -1) return "";
  // The query's body ends at the first line that closes it: every rule inside is indented, so `\n}` is the terminator.
  const body = /\{([\s\S]*?)\n\}/.exec(css.slice(start))?.[1] ?? "";
  return body;
}

test("the details are laid out by the WIDTH THEY HAVE, not by which row they sit in", () => {
  /*
   * THE reported defect, and the one every existing assertion passed straight through.
   *
   * Measured in a real window at 960px: the panel's content was 346px wide inside a 252px box. Nothing wrapped, because
   * `.session-header` (`flex-wrap: nowrap`) and `.header-stats` (`flex: none`) are deliberately non-wrapping — a freely
   * wrapping row was once a four-row header. `.session-peek-panel`'s `overflow-x: hidden` then hid the 94px that did not
   * fit, and focusing the Model `<select>` scrolled the box, clipping the LEFT edge mid-glyph. The right side had room to
   * spare, which is the signature of `scrollLeft > 0`.
   *
   * Why the compact rules did not reach it: they were written inside `@container transcript (max-width: 1080px)` and
   * scoped `.transcript-wrap.has-header > .transcript-header`. The reading-focus row carries `has-peek`, never
   * `has-header`, so the peek matched NOTHING in that query and fell through to the wide 340px layout. One frame's
   * compromises were gated on the OTHER frame's class.
   *
   * Falsified by removing `container-type` from `.transcript-header`: the compact query then has no container to match
   * and the first assertion reports that the frame is not its own size container.
   */
  const frame = rule(".transcript-header") ?? "";
  assert.match(
    frame,
    /container-type:\s*inline-size/,
    "the frame measures ITSELF, so a rule can answer 'is this box narrow' without knowing who its parent is",
  );
  assert.ok(frame.length > 0, ".transcript-header must have a rule");

  /*
   * And it must not be styled by its OWN query. CSS Containment is explicit that a container is not matched by the
   * `@container` rules that name it — the defect `@container transcript` already records, which made the whole narrow
   * layout a silent no-op. So the query must style elements INSIDE the frame.
   */
  const compact = containerRules("companion");
  assert.ok(compact.length > 0, "the frame needs a compact form, or a 250px panel gets the 340px layout");
  assert.ok(!/\.transcript-header\s*\{/.test(compact), "the container must not style itself from its own query");
  assert.match(compact, /\.session-header\b/, "…and does style what is inside it");

  /*
   * The row that overflowed has to be allowed to WRAP. This is the assertion that would have caught the defect: the
   * base rules are `nowrap` + `flex: none`, so at any width below the row's min-content something must give, and wrapping
   * is the answer that keeps every control reachable.
   *
   * Falsified by deleting `flex-wrap: wrap` from the compact `.header-stats`: the stat row is `flex: none` again and the
   * content is wider than the box, which is the clipping the issue reports.
   */
  const stats = /\.header-stats\s*\{([^}]*)\}/.exec(compact)?.[1] ?? "";
  assert.match(stats, /flex-wrap:\s*wrap/, "the stat row wraps rather than overflowing a narrow box");
  assert.match(stats, /row-gap:/, "with a gap on the line it wraps to, or two lines read as one");

  /*
   * The gauge is magnitude, not a measurement — it is read by comparing fills — so it is the first thing that may give
   * way. 120px of bar is worth less than a reachable control.
   */
  const gauge = /\.context-meter-track\s*\{([^}]*)\}/.exec(compact)?.[1] ?? "";
  const wide = /width:\s*(\d+)px/.exec(gauge)?.[1];
  assert.ok(wide !== undefined, "the compact gauge declares a width");
  assert.ok(Number(wide) < 120, `the compact gauge is narrower than the header's ${wide}px`);

  /*
   * A picker wrapper pinned at `flex-shrink: 0` was correct for a 340px column (issues #92, #96: a control that shrinks
   * clips its own label) and is wrong in a 250px box, where a control that refuses to shrink is width the row cannot
   * have.
   */
  const field = /\.picker-field\s*\{([^}]*)\}/.exec(compact)?.[1] ?? "";
  assert.match(field, /flex-shrink:\s*1/);
  assert.match(field, /min-width:\s*0/);
});

test("the box and the track it opens into agree about the panel's width", () => {
  /*
   * The panel was handed 252px while the row reserved ~279px for it: the open track's floor is
   * `min(companion, 45%)` of the grid's CONTENT box, and the box is `min(companion, 45% − 0.9·tab) + tab` of the row's
   * PADDING box. The tab is subtracted once for the percentage and added once, so the two disagree by roughly the tab's
   * own width — the "box's right side has room to spare" half of the report.
   *
   * The fix is not a matching literal in two places; it is the frame's own container query above, which lays the details
   * out to the width they actually get. So what is asserted here is that the two width expressions are the SAME
   * arithmetic — one `45%`, one tab — because a second way of computing the panel's width is a second thing to drift.
   */
  const open = rule(".transcript-wrap.has-peek.is-peek-open > .transcript-header-peek") ?? "";
  const boxPercent = /calc\((\d+)% - [\d.]+ \* var\(--peek-tab\)\)/.exec(open)?.[1];
  assert.ok(boxPercent !== undefined, `the open box's width must state its share of the row; got ${open}`);
  const openRow = rule(".transcript-wrap.has-peek.is-peek-open") ?? "";
  const floor = /minmax\(min\(var\(--companion-width\), (\d+)%\)/.exec(openRow)?.[1];
  assert.ok(floor !== undefined, `the open track must state a floor; got ${openRow}`);
  /*
   * The two shares must be the same number. Written as an equality between the two EXTRACTED values rather than against
   * a literal 45, because a literal is a third place to change and this is about the two rules agreeing.
   */
  assert.equal(Number(floor), 45, "the track floors at 45% of the row");
  assert.equal(Number(boxPercent), 45, "and the box caps at the same 45%, less the tab it adds back");
});

test("a focus that scrolls the panel sideways is put back", () => {
  /*
   * `overflow-x: hidden` does not prevent horizontal SCROLLING, only the bar. The browser scrolls a scrollport to reveal
   * a focused element that is wider than it, so tabbing to the Model `<select>` inside a too-wide panel left
   * `scrollLeft > 0` and the left edge of every line clipped — reported as "clipping its own content on the left", the
   * invisible failure where nothing looks broken and one side of the box is simply gone.
   *
   * The CSS above is the real fix (the content fits). This is the belt: the failure costs a reader the left half of the
   * panel with no error anywhere, and "the content fits" is a promise made in a file that does not know what will be
   * focused inside it.
   *
   * Falsified by removing `onFocusCapture`: the assertion reports that nothing recentres the box.
   */
  const source = read("components/SessionPeek.tsx");
  assert.match(source, /onFocusCapture=\{/);
  assert.match(source, /scrollLeft = 0/, "the offset is cleared, not merely noticed");
  assert.match(source, /ref=\{panelRef\}/, "and the box it clears is the scrolling panel");
  // Guarded, so a focus that did not scroll cannot cause a write on every keystroke into the panel.
  assert.match(source, /panel\.scrollLeft !== 0/);
});

test("the stacked band spans the row, and the column keeps its cap", () => {
  /*
   * Screenshot from the report, reading focus off: a 340px header card in a ~920px row, sitting at the top-left of the
   * conversation instead of spanning it. The narrow-form rule said `width: 100%` and never lifted the base rule's
   * `max-width: var(--companion-width)` — a declaration pair that reads as agreeing and is not.
   *
   * Falsified by removing `max-width: none` from the stacked rule: the band is 340px again, in any width.
   */
  const stacked = /\.transcript-wrap\.has-header > \.transcript-header\s*\{([^}]*)\}/g;
  const blocks = [...css.matchAll(stacked)].map((match) => match[1]);
  assert.ok(blocks.length >= 2, "one rule for the column, one for the stacked band");
  const band = blocks.find((block) => /position:\s*static/.test(block)) ?? "";
  assert.match(band, /width:\s*100%/);
  assert.match(band, /max-width:\s*none/, "the band spans the row: a cap beside width:100% defeats width:100%");

  /*
   * And the COLUMN still has its cap — the fix must not become "everything is full width". `.transcript-header` is
   * exactly the companion's width whenever there is room (the lane-geometry test states why).
   */
  assert.match(rule(".transcript-header") ?? "", /max-width:\s*var\(--companion-width\)/);
});

test("no child of the details may be wider than the box it is given (C20)", () => {
  /*
   * MEASURED in the normal layout, at a 1233px window — no reading focus, no peek involved:
   *
   *   cols = 217.167px  654.667px  217.167px        ← the companion's track
   *   headerW = 244   headerOverflow = 24           ← its content, 24px wider than the box
   *   wrap scrollW = 1188   clientW = 1137          ← 51px painted past the row
   *
   * Both margins are `minmax(0, 1fr)`, so they split the leftover evenly and the companion gets half of it — 217px for a
   * block authored at 340px. The 24px that did not fit painted past the row's right edge and was cut by the right-hand
   * panel, reported as "the session info panel overflows the right menu bar".
   *
   * The fix is deliberately NOT a list of the children I happened to check. That list was already wrong: the compact
   * query handled the stat row and the picker wrapper, and 24px still escaped from something none of us enumerated. So
   * the constraint is applied to the DESCENDANTS OF EVERY ROW in the block, and a fact added to the header inherits it
   * without anyone remembering this exists.
   *
   * Falsified by deleting the descendant rule: the assertion reports that nothing bounds the children.
   */
  const compact = containerRules("companion");
  /*
   * A universal-ish child selector, not a named one. Asserted as "the six row containers each bound their children",
   * because those are the boxes the details are built from — identity, stats, the lower band, and the three picker rows.
   */
  for (const row of ["session-header", "header-stats", "header-lower", "picker-grid", "picker-controls", "picker"]) {
    assert.match(
      compact,
      new RegExp(`\\.${row}\\s*>\\s*\\*`),
      `every child of .${row} is bounded, so a new fact cannot overflow it`,
    );
  }
  const bounded = /\.session-header\s*>\s*\*,[\s\S]*?\{([^}]*)\}/.exec(compact)?.[1] ?? "";
  assert.match(bounded, /min-width:\s*0/, "allowed to shrink below its content's intrinsic width");
  assert.match(bounded, /max-width:\s*100%/, "and never painted past its parent when it does not");

  /*
   * And the rows themselves, because `max-width` on a child does not help when the ROW is laid out at its content's
   * width — which is how a `flex: none` group takes the whole box with it.
   */
  const rows = /\.session-header,\s*\n?\s*\.header-stats[\s\S]*?\{([^}]*)\}/.exec(compact)?.[1] ?? "";
  assert.match(rows, /min-width:\s*0/);
  assert.match(rows, /max-width:\s*100%/);

  /*
   * The one control that legitimately refuses to shrink — "New session here" is `flex: none` + `nowrap` beside a path in
   * a 340px column, which is right there and is what pushes a 217px box over. Its row wraps instead.
   */
  assert.match(compact, /\.where-row\s*\{[^}]*flex-wrap:\s*wrap/, "the location row wraps rather than overflowing");
});
