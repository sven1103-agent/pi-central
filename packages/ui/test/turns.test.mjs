/**
 * A first-person turn is a landmark (issue #88).
 *
 * > *"In the current layout, own prompts can't be easily distinguished from the assistant ones. The
 * > own prompts mark significant steps in the interactive conversation history and help the user to
 * > navigate in the session transcript."*
 *
 * The cause was precise: `Turn` built the SAME element for every role — `<article className="turn
 * measure">` with a `<div className="role">` — so the only difference between the reader's own
 * prompt and a page of the agent's prose was the text of a 10px dim label.
 *
 * ## Why this is its own file
 *
 * `components.test.mjs` is ~1,700 lines and every UI slice appended to its end, which made it the
 * collision point in four consecutive rebases — twice git's conflict region cut a test in half. New
 * UI assertions get their own file now.
 *
 * The vite + jsdom setup below is the same as that file's, repeated rather than shared: a shared
 * harness would be a second thing every test file has to agree about, and this one is eight lines.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// jsdom before any component loads: DOMPurify binds to `window` at module-init time.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

let server;
let TranscriptView;

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

/** A transcript with one turn from each side, and nothing else. */
function twoTurns() {
  return {
    messages: [
      { id: "m1", role: "user", blocks: [{ kind: "text", text: "Please make the sidebar hideable." }] },
      { id: "m2", role: "assistant", blocks: [{ kind: "text", text: "Done — the panel is collapsed by default." }] },
    ],
    tools: [],
    notices: [],
  };
}

const render = () =>
  renderToString(createElement(TranscriptView, { transcript: twoTurns(), busy: false, sessionLabel: "s1" }));

/** The opening tag of the article whose prose contains `text`. */
function articleFor(html, text) {
  const articles = html.split("<article").slice(1).map((chunk) => `<article${chunk}`);
  const found = articles.find((article) => article.includes(text));
  assert.ok(found, `no article containing ${JSON.stringify(text)}`);
  return /^<article[^>]*>/.exec(found)[0];
}

test("the two roles render DIFFERENT markup, not just different label text", () => {
  // The acceptance criterion, and the one a future refactor would break silently: if both roles go
  // back to the same class, the distinction is a word again and nothing fails.
  const html = render();
  const mine = articleFor(html, "Please make the sidebar hideable.");
  const theirs = articleFor(html, "Done — the panel is collapsed by default.");

  assert.match(mine, /turn-user/, `the reader's own turn must be marked, got ${mine}`);
  assert.ok(!/turn-user/.test(theirs), `the assistant's turn must not be, got ${theirs}`);
  assert.notEqual(mine, theirs, "the two roles must not render identically");
});

test("an assistant turn stays on the page, unmarked", () => {
  // The other half of the same decision: marking the reader's own turns must not push them towards
  // the QUARANTINE frame, which is how the design marks untrusted output (tool results, file
  // contents, fetched pages). The assistant's prose is the thing being read, and it stays plain.
  const html = render();
  const theirs = articleFor(html, "Done — the panel is collapsed by default.");
  assert.ok(!/quarantine/.test(theirs), "assistant prose is not quarantined");
  assert.match(theirs, /turn-assistant/, "…but it does carry its role");
});

test("the distinction is not carried by colour alone", () => {
  // `forced-colors` drops backgrounds and tints. The label is strengthened in weight and case for
  // exactly that reason — the same rule the quarantine header follows, where the words carry the
  // meaning so the texture is never the only signal.
  function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "");
  }
  const css = stripComments(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"));

  const turn = /\.turn-user\s*\{([^}]*)\}/.exec(css);
  assert.ok(turn, ".turn-user must have a rule");
  assert.match(turn[1], /background:\s*var\(--panel-2\)/, "a tint, raised rather than recessed");
  assert.ok(!/border-left/.test(turn[1]), "no left rule: that vocabulary is the notices' and the trace's");
  assert.ok(!/border:\s/.test(turn[1]), "no frame either: that would read as quarantined output");

  const label = /\.turn-user \.role\s*\{([^}]*)\}/.exec(css);
  assert.ok(label, "the user turn's label must be strengthened");
  assert.match(label[1], /font-weight:\s*600/, "weight survives forced-colors; a tint does not");
  assert.match(label[1], /text-transform:\s*uppercase/, "…and so does case");
});

test("the raised tint cannot be confused with the recessed quarantine frame", () => {
  // Both are backgrounds, so the pair is worth pinning: `--panel-2` is lighter than `--panel`, and
  // the quarantine frame is `--panel` (recessed) with a hatched gutter. Same signal, opposite
  // meaning, would be the worst possible outcome.
  function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "");
  }
  const css = stripComments(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"));
  const quarantine = /^\.quarantine\s*\{([^}]*)\}/m.exec(css);
  assert.ok(quarantine, ".quarantine must have a rule");
  assert.match(quarantine[1], /var\(--panel\)/, "the quarantine frame is recessed");
  assert.ok(
    !/--panel-2/.test(quarantine[1]),
    "the quarantine frame must not use the raised tint the reader's own turns use",
  );
});
