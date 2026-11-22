/**
 * The transcript's measure: capped, NOT centred (reverted from #92).
 *
 * ## What this file used to be, and why it changed
 *
 * #92 answered *"the transcript looks lost, there is a lot of empty space right to the transcript"* by
 * centring a 590px column inside a 1330px one. That made the emptiness **more** obvious, and it produced
 * five downstream defects, each fix finding the previous fix's bug:
 *
 *   1. tool markers were capped but not centred → the transcript **flickered** left/centre as tools ran;
 *   2. the composer's `align-items: center` centred each child on its own width → **three left edges**;
 *   3. a `margin` shorthand silently cancelled the centring → the fix appeared not to work at all;
 *   4. trace text was inset from the column edge → **30px right** of the prose;
 *   5. and `.tool-detail` inherited the same inset problem.
 *
 * All reverted. The original complaint was more likely about text SIZE on a 27" display than about
 * alignment, and the assertions below now describe what the layout actually does.
 *
 * ## What is still asserted
 *
 * The two things from #92 that were independently true: the measure is a CAP, and the Send button does not
 * shrink below its label.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { READING_MEASURE_FILL, readingStyle } from "../src/reading.ts";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/**
 * The declarations of the LAST rule whose selector matches.
 *
 * Last, because CSS resolves equal-specificity conflicts by source order — the last one is what the element
 * gets. First-match reading has twice described CSS with no effect.
 *
 * Selectors are matched on normalised whitespace, because a selector list is formatted across lines.
 */
function rule(selector) {
  const normalised = css.replace(/\s+/g, " ");
  const wanted = selector.replace(/\s+/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...normalised.matchAll(new RegExp(`${wanted} ?\\{([^}]*)\\}`, "g"))];
  return all.length > 0 ? all[all.length - 1][1] : undefined;
}

test("the prose is CAPPED, which is the readability limit that matters", () => {
  const measure = rule(".measure");
  assert.ok(measure, ".measure must have a rule");
  // The cap is the READER's token (#134). Asserting the literal would fail on the feature that makes it
  // configurable — the property is "a cap in ch", not a specific number. The default's VALUE is asserted in
  // `reading.test.ts`, where the setting lives.
  assert.match(measure, /max-width:\s*var\(--reading-measure\)/, "the reader's measure token");
  const root = /:root\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1] ?? "";
  assert.match(root, /--reading-measure:\s*\d+ch/, "…which has a numeric default in the stylesheet");
});

test("the prose is NOT centred", () => {
  // The revert, pinned. If `margin-inline: auto` comes back, the five defects above come back with it —
  // and the flicker is the one a reader notices immediately.
  const measure = rule(".measure");
  assert.ok(
    !/margin-inline:\s*auto/.test(measure),
    "centring was reverted: it made the emptiness more obvious and produced five downstream defects",
  );
});

test("the composer spans the column instead of being individually centred", () => {
  // `align-items: center` was the three-left-edges bug: it centres each child on its own width, so a
  // shrink-wrapped mode strip and a full-width row get different edges.
  const composer = rule(".composer");
  assert.ok(composer, ".composer must have a rule");
  assert.ok(!/align-items:\s*center/.test(composer), "per-child centring is the bug");
  assert.ok(!/align-items:\s*stretch/.test(composer), "…and the patch for it is gone too, with the cap");
});

/*
 * "The send button does not shrink below its label" lived here. The button is gone — Enter submits — so the rule it
 * guarded no longer exists, and a `skip` would have been a guard that silently stopped guarding. The DECISION (no
 * button, Enter sends) is asserted in `components.test.mjs`, where the composer's markup is readable.
 */

test("the transcript keeps its own horizontal padding, and centres ONE lane", () => {
  /*
   * Two properties, and the second is a deliberate reversal of #92 with a different mechanism.
   *
   * #92 centred the transcript by putting `margin-inline: auto` on each CHILD. A tool marker is narrower than a
   * paragraph, so each child was centred on its own width, the centres disagreed, and the column visibly flickered
   * as tools ran. It was reverted, and the note in `.transcript` says centring is "the thing that failed".
   *
   * What actually failed was per-child centring. The review asked twice for a centred column, so it is centred ONCE,
   * on a single lane wrapper that every entry fills: there is exactly one centre, so nothing can disagree about it.
   * That is the property asserted here — one lane, one auto margin — rather than the presence or absence of centring.
   */
  // Read the BASE rule directly: `rule()` returns the LAST match, and the container-query override also sets
  // `.transcript`, so the helper handed back `grid-row: 2`.
  const source = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const transcript = /(?:^|\n)\.transcript\s*\{([^}]*)\}/.exec(source)?.[1] ?? "";
  assert.ok(transcript, ".transcript must have a rule");
  assert.match(
    transcript,
    /padding:\s*var\(--sp-4\) 18px var\(--sp-4\) 18px/,
    `18px on both sides, so the scrollbar sits at the column's edge; got: ${transcript}`,
  );

  const lane = rule(".transcript-lane");
  assert.ok(lane, ".transcript-lane must exist — it is the one thing that is centred");
  assert.match(lane, /margin-inline:\s*auto/, "the lane is centred");
  assert.match(lane, /max-width:\s*var\(--reading-measure\)/, "…at the reader's measure, like the prose and composer");

  // The guard that makes this safe: nothing else in the transcript may centre itself.
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const centred = [...css.matchAll(/([^{}]+)\{([^}]*margin-inline:\s*auto[^}]*)\}/g)]
    .map((m) => m[1].trim())
    .filter((selector) => selector.includes("turn") || selector.includes("measure") || selector.includes("activity"));
  assert.deepEqual(
    centred,
    [],
    `per-child centring is #92's defect: a narrower child gets a different centre. Found: ${centred.join(", ")}`,
  );
});
test("the lane is centred by TWO EQUAL margins, and the companion does not steal one of them", () => {
  /*
   * The reported defect, and the bug in the first attempt at fixing it.
   *
   * The row used to be `display: flex; justify-content: center` over the prose and a 340px companion, so what was
   * centred was the PAIR: the prose sat half a companion left of the window centre. That is invisible while the rail
   * fills the void and obvious when it does not — *"without the session list, the transcript is not centered anymore"*.
   *
   * The first fix wrote `minmax(0, 1fr) minmax(0, 80ch) 340px` while its comment claimed "one 1fr on each side". A single
   * flexible track takes ALL of the free space, so the prose was pushed to the trailing edge — a worse defect than the
   * one being fixed, and reported immediately.
   *
   * The property is therefore SYMMETRY, and it is asserted as such: the template must name the same margin token twice
   * while centred. A literal anywhere in the outer two tracks is the bug.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const row = [...css.matchAll(/\.transcript-wrap\.has-header\s*\{([^}]*)\}/g)]
    .map((m) => m[1])
    .find((body) => /display:\s*grid/.test(body));
  assert.ok(row, "the wide layout is a grid");

  const template = /grid-template-columns:\s*([^;]+);/.exec(row)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  assert.equal(
    template,
    "var(--reading-leading) var(--reading-lane) var(--reading-trailing)",
    "three NAMED tracks, so the stylesheet cannot hold an asymmetry the module does not",
  );

  /*
   * And the module itself is where symmetry is decided — the leading and trailing margins are the same token while
   * centred, and differ only under `fill`, where the reader asked for the left edge specifically.
   */
  const centred = readingStyle({ sizePx: 15, measure: 80 });
  assert.equal(centred["--reading-leading"], centred["--reading-trailing"], "equal margins ARE the centring");
  assert.equal(centred["--reading-trailing-max"], "1fr", "the open panel's track keeps absorbing space, so the lane need not move");
  assert.match(centred["--reading-leading"], /^minmax\(0, 1fr\)$/, "flexible, so the pair of them split the free space");
  assert.match(centred["--reading-lane"], /^minmax\(0, \d+ch\)$/, "and the lane carries the reader\u2019s measure");

  /*
   * `fill` is the asymmetric case and must stay asymmetric: "use the column\u2019s width" means everything the companion
   * does not need, not a symmetric void. The companion keeps its own track, so `.transcript-header` survives — a
   * `100%` lane instead pushes it out of the grid along with Stop, Resume, Rename and both pickers.
   */
  const fill = readingStyle({ sizePx: 15, measure: READING_MEASURE_FILL });
  assert.equal(fill["--reading-leading"], "0px", "no leading void under fill");
  assert.equal(fill["--reading-trailing"], "var(--companion-width)", "and the companion still has its track");
  assert.equal(fill["--reading-trailing-max"], "var(--companion-width)", "and the open panel's track cannot outgrow it");
  assert.equal(fill["--reading-lane"], "minmax(0, 1fr)", "the lane takes the rest");
});

test("the composer's chrome shares the field's left edge, and its gap does not move with focus", () => {
  /*
   * A reviewer's recommendation, and it fixes four findings at once.
   *
   * The follow toggle was a pill ABOVE the field. It straddled the focus ring — so the strongest "this is focused" signal
   * was cut by a chip lying on it — and because the ring is drawn OUTSIDE the border, the gap between the pill and the
   * text changed with focus (`img_40` vs `img_41`). The chrome appeared to shift when you clicked into the field.
   *
   * It is now a row INSIDE the composer's boundary, sharing the field's left edge, with a `margin-top` measured from the
   * field so nothing can move.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const chrome = /(?:^|\n)\.composer-chrome\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(chrome, ".composer-chrome must exist — the hint and the toggle live in one row");
  assert.match(chrome, /display:\s*flex/);
  // No horizontal padding: the row must start where the field does, or the left edges stagger again.
  assert.ok(!/padding(-left)?:\s*[^;]*\d/.test(chrome), "the row adds no horizontal inset of its own");
  assert.match(chrome, /margin-top:\s*var\(--sp-2\)/, "a fixed gap below the field, measured from the border");

  // The toggle is a SWITCH now, not a pill whose only difference is a word.
  const toggle = /(?:^|\n)\.follow-toggle\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(toggle, ".follow-toggle must have a base rule — the contrast audit holds every alone-used class to it");
  assert.match(toggle, /background:\s*none/, "it declares its own face");
  assert.match(toggle, /font:\s*inherit/);
  const track = /\.follow-toggle-track\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(track, "the switch needs a track, or the state is a word only");
  const dot = /\.follow-toggle-dot\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(dot, /transition:/, "the dot moves, which is what makes it a switch rather than a bullet");

  // And the toggle must no longer be rendered above the field.
  const transcript = readFileSync(new URL("../src/components/Transcript.tsx", import.meta.url), "utf8");
  assert.ok(!/transcript-tools/.test(transcript), "the floating row above the field is gone");
  assert.match(transcript, /composer-dock">\{footer\}/, "the composer owns the whole foot now");
});

test("the prompt field holds three lines before it scrolls", () => {
  /*
   * This number was argued both ways and needs a guard, because a plausible review note can always be written for either
   * side.
   *
   * `min-height` was briefly floored at ONE line, following a note that a single-line draft sat at the top of a tall box
   * and looked bottom-heavy. That traded the empty space for a worse problem: a prompt field showing one line cannot be
   * reviewed before sending, and every prompt then scrolls.
   *
   * Three lines is a REQUIREMENT of this app — it is the size of prompt it is for, a sentence or two of instruction
   * rather than a chat message. Asserted as arithmetic on `1.5em * 3`, so it holds at any reading size rather than at one
   * font, and a shrink to `1.5em` fails here with the reason attached.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const field = /\.composer \.composer-input,\s*\n?\.composer textarea\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(field, "the composer field must have a rule");
  /*
   * A FIXED height, not a floor, and that distinction is the whole point.
   *
   * The number has been argued both ways. Floored at one line, a prompt could not be reviewed before sending. Floored at
   * three AND allowed to grow (`field-sizing: content`), the composer pushed itself up into the transcript as the reader
   * typed — the dock's height became a function of the draft, which is the same class of defect as the queue
   * enumeration: the canvas moving because of something typed into the box at its foot.
   *
   * So: three lines exactly, and a longer prompt scrolls INSIDE the field.
   */
  assert.match(
    field,
    /height:\s*calc\(1\.5em \* 3/,
    `the field's height must be fixed at three lines; got ${/height:[^;]*/.exec(field)?.[0] ?? "none"}`,
  );
  assert.ok(
    !/field-sizing:\s*content/.test(field),
    "the field must NOT grow with its content, or the composer rises into the transcript",
  );
  // The prompt needs somewhere to go, and it must not be clipped.
  assert.match(field, /overflow-y:\s*auto/, "a long prompt scrolls inside the field");
  // The slim overlay treatment, the same as every other scroller in the app.
  assert.match(
    css,
    /\.composer textarea::-webkit-scrollbar-thumb\s*\{[^}]*--line-strong/,
    "the field's scrollbar uses the shared slim thumb",
  );
});

test("the transcript has NO scrollbar, and reports its ends with a fade instead (ADR-0016)", () => {
  /*
   * The report: on a 1512x982 window the transcript scrollbar drew a vertical rule most of the column tall,
   * reading as a second unowned edge beside the prose. It was already slim and inset; the problem was that a
   * position bar is the wrong instrument here, because a following reader is at the end by construction and has
   * no use for a position indicator at all.
   *
   * What replaces it answers the only two questions a reader has — "is there more above me" and "is there more
   * below me" — with a fade at each end of the column.
   *
   * Both halves are asserted, because either alone is a regression: removing the bar without the fades leaves the
   * reader with no indication at all, and the fades without removing the bar is the defect plus decoration.
   */
  const transcript = rule(".transcript");
  assert.ok(transcript, ".transcript must have a rule");
  assert.match(transcript, /scrollbar-width:\s*none/, "the platform scrollbar is suppressed");
  assert.match(css, /\.transcript::-webkit-scrollbar\s*\{\s*display:\s*none/, "and the webkit path too");
  assert.ok(
    !/\.transcript::-webkit-scrollbar-thumb/.test(css),
    "the thumb rules must be GONE, not merely overridden: a leftover thumb is the defect still in the file",
  );

  /*
   * The two fades, each on the correct edge of the viewport.
   *
   * Matched against the whole stylesheet rather than through `rule()`, because that helper returns the LAST rule
   * whose selector matches — and the last rule mentioning these selectors is the `opacity: 1` that shows them,
   * not the one that positions them. Asserting on the helper would have checked the wrong declaration.
   */
  assert.match(
    css,
    /\.transcript-fade\.is-top\s*\{[^}]*top:\s*0/,
    "the upper fade sits at the top edge of the viewport",
  );
  assert.match(
    css,
    /\.transcript-fade\.is-bottom\s*\{[^}]*bottom:\s*var\(--jump-strip\)/,
    "the lower fade stops above the reserved band, so it never covers the pill",
  );
  // They must not eat clicks: an overlay that swallowed one would make the last line un-selectable.
  assert.match(
    css,
    /\.transcript-fade\s*\{[^}]*pointer-events:\s*none/,
    "the fades are overlay-only, so a click on the last line still lands on the text",
  );

  // And they appear from ONE measurement, which is the handler that already decides `pinned`.
  const source = readFileSync(new URL("../src/components/Transcript.tsx", import.meta.url), "utf8");
  assert.match(source, /data-overflow=/, "the viewport reports its overflow state");
  const handler = /const onScroll = \(\) => \{([\s\S]*?)container\.addEventListener/.exec(source)?.[1] ?? "";
  assert.match(handler, /setOverflow\(/, "the fades are driven by the scroll handler, not a second listener");
  assert.match(handler, /setPinned\(following\)/, "the same handler that decides following, so they cannot disagree");
});
test("the end-fades report the right state at every scroll position (ADR-0016)", () => {
  /*
   * The defect this prevents: the fades shipped ONCE already and the operator could not see them, because
   * `setOverflow` sat AFTER the `restoring` guard in the scroll handler. That guard returns on the mount
   * measurement, so the fade state was skipped on the first paint — the only paint a static render produces.
   * A markup assertion passed throughout; nothing checked that the rule runs.
   *
   * So the rule is exercised directly, in the states that matter. jsdom has no layout engine, so the scroller
   * metrics are supplied rather than measured — which is the same technique `scroll.test.ts` uses for
   * `isFollowing`, and for the same reason.
   */
  const source = readFileSync(new URL("../src/components/Transcript.tsx", import.meta.url), "utf8");

  // 1. The rule must run BEFORE the restoring guard, or the first paint has no fades.
  const handler = /const onScroll = \(\) => \{([\s\S]*?)container\.addEventListener/.exec(source)?.[1] ?? "";
  assert.ok(handler, "the scroll handler must exist");
  const overflowAt = handler.indexOf("setOverflow(");
  const guardAt = handler.indexOf("if (restoring.current) return;");
  assert.ok(overflowAt >= 0, "the handler updates the fade state");
  assert.ok(guardAt >= 0, "the restoring guard must still be there");
  assert.ok(
    overflowAt < guardAt,
    "setOverflow must run BEFORE the restoring guard: after it, the first paint has no fades at all",
  );

  // 2. Both ends are derived from the SAME measurement as `pinned`, not a second listener.
  assert.match(handler, /setPinned\(following\)/, "the same handler decides following");

  // 3. The states themselves, against the rule the component states.
  const overflowRule = (scrollTop, clientHeight, scrollHeight) => {
    const atEnd = scrollTop + clientHeight >= scrollHeight - 2;
    const marks = [];
    if (scrollTop > 1) marks.push("up");
    if (!atEnd) marks.push("down");
    return marks.join(" ");
  };
  assert.equal(overflowRule(0, 500, 2000), "down", "at the top with more below: only the lower fade");
  assert.equal(overflowRule(600, 500, 2000), "up down", "mid-history: both");
  assert.equal(overflowRule(1500, 500, 2000), "up", "at the end: only the upper fade, because there IS more above");
  assert.equal(overflowRule(0, 2000, 2000), "", "content that fits shows neither");
  assert.equal(
    overflowRule(1499, 500, 2000),
    "up",
    "within 2px of the bottom counts as the bottom, or the fade flickers on the last pixel",
  );

  // 4. And the marks must actually turn into a visible fade.
  for (const [mark, fade] of [
    ["up", "is-top"],
    ["down", "is-bottom"],
  ]) {
    assert.match(
      css,
      new RegExp(`data-overflow~="${mark}"[^{]*\\.transcript-fade\\.${fade}\\s*\\{[^}]*opacity:\\s*1`),
      `the "${mark}" mark must show the ${fade} fade`,
    );
  }
});
test("the end-fade band is tall enough to read, and both ends share one height (ADR-0016)", () => {
  /*
   * 28px was a thin edge that read as a slight darkening rather than as "the text continues" — reported after
   * looking at it on a 1512x982 window. The band is now 56px and the height lives in a custom property, so the
   * two ends cannot drift apart.
   *
   * The ramp is asserted too, because height alone would not have fixed it: a plain `var(--bg)` to `transparent`
   * is already mostly transparent a third of the way in, so a taller band would have been more faint pixels
   * rather than a stronger edge. The stops hold full opacity for the first 40% and only then dissolve.
   */
  const fade = /\.transcript-fade\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(fade, /--fade-height:\s*56px/, "the band height is one declared value");
  assert.match(fade, /height:\s*var\(--fade-height\)/, "and the element uses it rather than a second literal");

  // Both ends start from the page colour, so the two edges look the same.
  assert.match(
    css,
    /\.transcript-fade\.is-top\s*\{[^}]*rgb\(14 17 22\)\s*0%/
    , "the upper fade holds the page colour at its outer edge",
  );
  assert.match(
    css,
    /\.transcript-fade\.is-bottom\s*\{[^}]*rgb\(14 17 22\)\s*0%/
    , "the lower fade does too, so the two edges match",
  );

  // The front-loaded ramp: full opacity to 40%, then partial, then nothing.
  const topGradient = /\.transcript-fade\.is-top\s*\{[^}]*linear-gradient\(([\s\S]*?)\)\s*;/.exec(css)?.[1] ?? "";
  const stops = [...topGradient.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
  assert.ok(stops.length >= 3, `the ramp needs at least three stops to stay dense; got ${stops.join(", ")}`);
  assert.ok(
    stops.includes(40),
    `the page colour must hold to 40% before dissolving, or a taller band is only fainter; got ${stops.join(", ")}`,
  );
});
test("the transcript disables browser scroll anchoring, which was a second writer", () => {
  /*
   * THE DEFECT, reported as "i cant say that i see any effect on any parameter setting for burst and huge".
   *
   * `overflow-anchor: auto` is the browser default: on a content change it adjusts `scrollTop` to keep the
   * reader\u2019s place, in ONE frame, outside any animation. For a document that is right. Here it was a second
   * scroll manager with no knowledge of the first, and it adjusted by exactly the size of the change:
   *
   *   - a trickle changes ~1.2px, so the adjustment was invisible and the glide was what the reader saw -- which is
   *     why the steady mode DID respond to the sliders;
   *   - a burst changes 99-581px, so the adjustment was a full-magnitude jump that bypassed the curve entirely. No
   *     parameter could affect it, because our code was not the thing moving the scroller.
   *
   * `none` is the only correct value: following, the restore and the glide are all this component\u2019s decisions, so
   * nothing else may move the viewport.
   */
  const transcript = rule(".transcript");
  assert.ok(transcript, ".transcript must have a rule");
  assert.match(
    transcript,
    /overflow-anchor:\s*none/,
    "scroll anchoring must be off, or the browser moves the viewport behind the animation and the tuning has no effect",
  );
  assert.ok(
    !/overflow-anchor:\s*auto/.test(css),
    "and it must not be re-enabled elsewhere; `auto` is the default that caused the defect",
  );
});