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
test("the prose is centred on its OWN lane, not on the pair it forms with the companion", () => {
  /*
   * ## The reported defect this replaces a rule for
   *
   * With the rail away the conversation sat ~180px left of the window’s centre, with a band of empty space beside it.
   * The cause was the layout, not the rail: the row was `display: flex; justify-content: center` over TWO boxes —
   * prose (a `max-width` item, therefore narrower than its track) and a 340px companion — so what was centred was the
   * PAIR, and the prose’s own centre is half a companion to the left of the pair’s.
   *
   * A `max-width` item cannot be positioned by `justify-content`: the remainder belongs to the container’s spare space.
   * A TRACK can. So the lane has a track of its own, sized by `--reading-lane` (derived in `reading.ts` from the same
   * setting that caps the prose), and the centring is one `1fr` on each side of it.
   *
   * ## What is asserted, and what each half would catch
   *
   *   - the lane gets its own track and there are TWO `1fr`s, one per side — the symmetry is the centring;
   *   - the companion does not sit in the leading track — that was `img_32.png`’s `[companion][conversation]`;
   *   - the reader’s `--reading-lane` is what sizes it, so a wider measure widens the lane rather than making the prose
   *     drift inside a fixed one;
   *   - stacked, both boxes return to ONE column rather than leaving a named column that does not exist.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const row = [...css.matchAll(/\.transcript-wrap\.has-header\s*\{([^}]*)\}/g)].map((m) => m[1]).find((body) => /display:\s*grid/.test(body)) ?? "";
  assert.match(row, /display:\s*grid/, "a grid, so the centring is arithmetic rather than a wish");
  /*
   * One MARGIN track on each side of the lane, and the companion's own width on the right. The margin is a token rather
   * than a literal `1fr` because under the reader's `fill` setting it must become `0px` — see `reading.ts#laneMargin`.
   */
  const tracks = /grid-template-columns:\s*var\(--reading-margin\)\s+minmax\(0,\s*var\(--reading-lane\)\)\s+var\(--companion-width\)/.exec(row);
  assert.ok(tracks, "a margin track on EACH side of the lane, and the companion's width on the right");

  const lane = /\.transcript-wrap\.has-header \.transcript-main\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const box = /\.transcript-wrap\.has-header \.transcript-header\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(lane, /grid-column:\s*2/, "the prose is the middle track");
  assert.match(box, /grid-column:\s*3/, "and the companion trails it");

  // The reader’s setting owns the lane’s width, in ONE place: `reading.ts` derives both declarations.
  const reading = readFileSync(new URL("../src/reading.ts", import.meta.url), "utf8");
  assert.match(reading, /"--reading-lane":/, "the lane width is derived from the measure, not written in the stylesheet");
  /*
   * And `fill` becomes arithmetic rather than `none`: a grid track must be a length, and "the column's width" has to
   * reserve the companion or it takes the whole line. Both terms are in `reading.ts`, which is the one place the row's
   * arithmetic is decided — and the one place a test can reach it without a browser.
   */
  assert.match(reading, /calc\(100% - var\(--companion-width\) - var\(--reading-gap\)\)/, "fill reserves the companion");

  /*
   * Stacked (the container query), both boxes return to the single column. Naming a column that no longer exists is
   * how a grid invents an implicit one — a second column nobody asked for.
   */
  const stacked = /@container transcript[^{]*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.match(stacked, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, "one column when stacked");
  assert.match(stacked, /grid-column:\s*1/, "and both boxes in it");
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
