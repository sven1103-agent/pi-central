/**
 * A message body: prose through the sanitized pipeline, code as React elements.
 *
 * ## Why this exists beside `Prose`
 *
 * `Prose` owns the single `dangerouslySetInnerHTML` site (ADR-0006) and keeps it. This component
 * renders the SAME prose through `Prose` — one segment at a time — and renders fenced code as a
 * `CodeBlock`, which is React elements. So:
 *
 *   - there is still exactly one insertion site, and the invariant test still counts one;
 *   - a fenced block contributes NO HTML to sanitize, so a highlighter cannot become a second
 *     producer of markup in front of the boundary;
 *   - the prose keeps rendering exactly as before when a message contains no code.
 *
 * A message with no fenced code takes the `Prose` path unchanged, which matters: this is the
 * overwhelmingly common case and it must not pay for the feature.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { highlightCode, highlightedNodes, type HighlightedCode } from "../highlight.ts";
import { namedLanguages, splitFences, type Segment } from "../segments.ts";
import { Prose } from "./Prose.tsx";

/**
 * One fenced block.
 *
 * Renders the RAW text first and then swaps in highlighted tokens, rather than showing nothing
 * while the grammar loads. Two reasons:
 *
 *   - a grammar is a network fetch on first encounter; a blank frame would read as a rendering bug;
 *   - the text is already correct and already escaped, so there is no reason to withhold it.
 *
 * `useEffect` rather than a top-level await, because this is a component: the initial render must be
 * identical on the server and the client, and a grammar is only fetched in the browser.
 */
const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [highlighted, setHighlighted] = useState<HighlightedCode | undefined>(undefined);
  /**
   * The outcome of asking for a grammar.
   *
   * `"pending"` and `"unavailable"` are different, and the difference is the whole reason this is
   * not a boolean: while a grammar is loading, plain text is a temporary state; once the answer is
   * "no grammar for this language", the plain text is final and saying "not highlighted" is a fact
   * rather than a progress report. Rendering them the same would tell a reader to wait for
   * something that is never coming — the same distinction `transcriptError` exists for.
   */
  const [state, setState] = useState<"pending" | "highlighted" | "unavailable">("pending");

  useEffect(() => {
    if (lang.length === 0) {
      setState("unavailable");
      return;
    }
    let live = true;
    void highlightCode(code, lang).then((result) => {
      // Guarded against a response arriving for a block that has been replaced — during streaming a
      // code block re-renders on every delta, and setting state from an unmounted component (or for
      // stale text) would paint the wrong code.
      if (!live) return;
      setHighlighted(result);
      setState(result ? "highlighted" : "unavailable");
    });
    return () => {
      live = false;
    };
  }, [code, lang]);

  // The tokens are only used when they describe the CURRENT code. A grammar that finished loading
  // for a previous revision of the block must not be shown in place of the text that is here now.
  const usable = highlighted && highlighted.lang.toLowerCase() === lang.toLowerCase();

  return (
    <div className="code-block">
      {/* The language is stated rather than implied by colour: a reader who cannot distinguish the
          palette should still know what they are looking at, and it is also how an unsupported
          language explains itself. */}
      {lang.length > 0 && (
        <div className="code-lang">
          {lang}
          {state === "unavailable" && <span className="code-lang-note"> · not highlighted</span>}
        </div>
      )}
      {usable ? (
        <div className="code-body" data-lang={lang}>
          {highlightedNodes(highlighted)}
        </div>
      ) : (
        // Plain, escaped, and exactly the text Pi sent. Also the fallback for an unknown language,
        // which must show the code rather than nothing.
        <pre className="code-plain">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
});

/**
 * A message body.
 *
 * `memo` on the text because a streaming message re-renders on every delta, and re-splitting a long
 * body on each one is the most expensive thing the transcript could do.
 */
export const MessageBody = memo(function MessageBody({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const segments: Segment[] = useMemo(() => splitFences(text), [text]);

  // Decided from the SEGMENTS rather than by attempting a load: a transcript of pure prose must not
  // fetch a grammar chunk, and an unknown language must not either.
  const named = useMemo(() => namedLanguages(segments), [segments]);
  const hasCode = segments.some((segment) => segment.kind === "code");

  if (!hasCode) {
    // The common case, byte-for-byte the previous behaviour: one sanitized insertion.
    return <Prose text={text} streaming={streaming} />;
  }

  return (
    <div className="prose" data-streaming={streaming || undefined} data-has-code={named.length > 0 || undefined}>
      {segments.map((segment, index) =>
        segment.kind === "prose" ? (
          // Whitespace-only prose between two blocks is not a paragraph; Prose would render an
          // empty `p` and add a gap that the source did not ask for.
          segment.text.trim().length === 0 ? null : (
            // Each prose run is its own sanitized insertion, and `Prose` is still the only file
            // that inserts HTML — the invariant test counts files, not calls.
            <Prose key={`p${index}`} text={segment.text} />
          )
        ) : (
          <CodeBlock key={`c${index}`} code={segment.code} lang={segment.lang} />
        ),
      )}
    </div>
  );
});
