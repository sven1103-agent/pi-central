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

test("pinning is a remembered preference, off by default", () => {
  /*
   * Remembered because a reader who pinned it once meant it, and off by default because the resting state must be the
   * calm one the mode exists for. Falsified by defaulting peekPinned to true — the mode would look like the column it
   * replaced.
   */
  assert.equal(defaultRailPrefs().peekPinned, false);
  assert.equal(parseRailPrefs(serializeRailPrefs({ ...defaultRailPrefs(), peekPinned: true }), 0).peekPinned, true);
  assert.equal(parseRailPrefs('{"peekPinned":"true"}', 0).peekPinned, false);
});

test("the peek is an OVERLAY, so the prose does not move when it opens", () => {
  /*
   * The property the whole design turns on. position: absolute against .transcript-wrap (already relative) takes it out
   * of flow, so hovering changes what is ON TOP of the conversation and never where the conversation is.
   *
   * Falsified by making .transcript-peek a grid item — dropping the position: absolute — which puts it back in the row so
   * the prose shifts by its width the moment the pointer arrives.
   */
  const peek = rule(".transcript-peek") ?? "";
  assert.match(peek, /position:\s*absolute/, "out of flow");
  assert.match(peek, /top:\s*0/, "anchored to the wrap's top");
  assert.match(peek, /bottom:\s*0/, "and its full height");

  const focusRow = /\.app\.is-focus:not\(\.is-panel-closed\) \.transcript-wrap\.has-header\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(focusRow, "the focus-mode row exists");
  assert.ok(
    !/var\(--companion-width\)/.test(/grid-template-columns:[^;]+;/.exec(focusRow)?.[0] ?? ""),
    "no companion track is reserved in focus mode",
  );
});

test("a CLOSED peek cannot eat a click aimed at the conversation", () => {
  /*
   * The hazard an overlay introduces: 340px of invisible panel sits over the prose while closed. pointer-events: none on
   * the rail and the panel, re-armed on the tab, means the reader can still click, select and scroll underneath.
   *
   * Falsified by removing either pointer-events line — the prose becomes unclickable in its right-hand third.
   */
  assert.match(rule(".transcript-peek") ?? "", /pointer-events:\s*none/, "the rail takes no pointer input at rest");
  assert.match(rule(".session-peek") ?? "", /pointer-events:\s*none/, "and neither does its box");
  assert.match(rule(".session-peek-tab") ?? "", /pointer-events:\s*auto/, "only the tab arms it");
  const panel = rule(".session-peek-panel") ?? "";
  assert.match(panel, /pointer-events:\s*none/, "the panel is inert while closed");
  assert.match(panel, /visibility:\s*hidden/, "and invisible, so it is out of the tab order too");
  assert.match(rule(".session-peek.is-open .session-peek-panel") ?? "", /pointer-events:\s*auto/, "and live when open");
});

test("the tab says what the block IS, and the one number that changes a decision", () => {
  /*
   * The second half of the report — "i dont know what this means". The tab carries a word, the session's state and its
   * context pressure, so the resting state is self-explaining.
   *
   * Falsified by rendering the tab as an icon only: peekStateWord and peekContextLabel would be unused props.
   */
  const source = read("components/SessionPeek.tsx");
  assert.match(source, /session-peek-word/, "a word, so the block is named");
  assert.match(source, /\{stateWord\}/, "the session's state");
  assert.match(source, /\{contextLabel\}/, "and the context reading");
  assert.match(rule(".session-peek-ctx.is-full") ?? "", /color:\s*var\(--warn-text\)/, "the same warn token as the meter");
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

test("the transcript picks ONE frame for the same content", () => {
  /*
   * The reason the content is passed as details rather than the framed element: a fact added to the session's identity
   * must appear in both frames without a second implementation. The transcript renders the identical node either in a
   * column or behind the peek, never both.
   *
   * Falsified by rendering both — the details would appear twice on a wide window, which is a duplicate set of controls
   * against one session.
   */
  const source = read("components/Transcript.tsx");
  assert.match(source, /!focusMode && <div className="transcript-header">\{details\}<\/div>/, "the column frame");
  assert.match(source, /focusMode && \(/, "and the peek frame");
  const renders = [...source.matchAll(/\{details\}/g)].length;
  assert.equal(renders, 2, "the content is rendered in exactly two branches, found " + renders);
});
