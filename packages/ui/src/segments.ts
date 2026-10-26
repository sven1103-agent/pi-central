/**
 * Splitting prose from fenced code, so a code block never has to travel through the HTML pipeline.
 *
 * ## Why split at all
 *
 * `renderMarkdown` returns sanitized HTML inserted at exactly one counted site (ADR-0006). A syntax
 * highlighter wants to produce *markup*, and the tempting shape — register a markdown-it `highlight`
 * option, let it emit spans, and let the sanitizer cope — is the one the issue warns about: it puts
 * a second producer of markup in front of the boundary and quietly makes the allow-list the only
 * thing between a grammar and the DOM.
 *
 * So fenced blocks are lifted OUT of the Markdown before it is rendered. Prose keeps the existing
 * pipeline; code becomes **React elements built from validated data** (`highlight.ts` returns
 * tokens, not HTML), so a fenced block contributes no HTML to sanitize at all. Three consequences:
 *
 *   - The invariant holds for a stronger reason than before: the insertion site still sanitizes,
 *     and the highlighted path cannot inject markup even in principle.
 *   - A theme colour never has to be allowed through `ALLOWED_ATTR`, which is the trade the string
 *     path would have forced (and would have been the only reason to permit `style` at all).
 *   - Code text is escaped by React rather than by the highlighter.
 *
 * ## Why only COLUMN-ZERO fences
 *
 * A fence indented inside a list or a blockquote is a block whose indentation carries meaning for
 * its container. Reconstructing that meaning here would be a Markdown parser, and a half-correct
 * one is worse than none: it would silently change the document's structure. So the splitter
 * recognises only fences beginning at column 0, and **everything else stays with markdown-it**.
 *
 * That is a graceful degradation rather than a limitation: an unsplit fence renders as
 * `<pre><code>` exactly as it does today — correct, escaped, and unstyled. The failure mode is
 * "this block is not coloured", never "this block is wrong".
 */
export type Segment =
  | { kind: "prose"; text: string }
  | {
      kind: "code";
      /** The info string's first word, lower-cased. `""` when the fence names no language. */
      lang: string;
      code: string;
    };

/**
 * A fence opener: three or more backticks or tildes at column 0, optionally followed by a language.
 *
 * Backticks and tildes are matched as the SAME run type for the closer — a `~~~` block may contain
 * `` ``` `` and vice versa, which is the whole reason the other form exists.
 */
const OPENER = /^(`{3,}|~{3,})\s*([^`\s]*)\s*$/;

/**
 * Split a Markdown source into prose and top-level fenced code.
 *
 * An UNCLOSED fence is deliberately treated as prose rather than as code to the end of the
 * document. A half-typed fence is a common streaming state — the closing fence has not arrived yet
 * — and consuming the rest of the message into a code block would make the transcript jump and
 * hide text that is about to be ordinary prose. Leaving it to markdown-it renders it as Markdown,
 * which is what it will be once the closer arrives.
 */
export function splitFences(source: string): Segment[] {
  if (!source.includes("```") && !source.includes("~~~")) return [{ kind: "prose", text: source }];

  const lines = source.split("\n");
  const segments: Segment[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    if (prose.length > 0) {
      segments.push({ kind: "prose", text: prose.join("\n") });
      prose = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const opener = OPENER.exec(line);
    if (!opener) {
      prose.push(line);
      continue;
    }

    const fence = opener[1]!;
    const lang = (opener[2] ?? "").toLowerCase();
    // Find the matching closer: same character, at least as long, at column 0. A shorter run does
    // not close it, which is what CommonMark specifies and what makes ```` ```` ```` work.
    let closerIndex = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = lines[scan] ?? "";
      const trimmed = candidate.trimEnd();
      if (trimmed.length >= fence.length && /^(`{3,}|~{3,})$/.test(trimmed) && trimmed[0] === fence[0]) {
        closerIndex = scan;
        break;
      }
    }
    if (closerIndex === -1) {
      // Unclosed: leave it to Markdown. See the note above.
      prose.push(line);
      continue;
    }

    flushProse();
    // NO decision about highlightability is made here, and that is deliberate: the answer depends
    // on the grammar map, which is a lazy chunk, and a synchronous splitter cannot await it. Asking
    // "can this be highlighted?" at split time would force the map — the ~24 kB index — back into
    // the eager graph, which is exactly the cost this design exists to avoid. The component asks
    // the question where the answer is used, asynchronously, and shows plain text until it arrives.
    segments.push({ kind: "code", lang, code: lines.slice(index + 1, closerIndex).join("\n") });
    index = closerIndex;
  }

  flushProse();
  // A source that was one code block has no prose segments, which is correct — the caller renders
  // the list, not a document.
  return segments.length > 0 ? segments : [{ kind: "prose", text: source }];
}

/**
 * The languages a source names, whether or not a grammar exists for them.
 *
 * Used only to answer "is there anything worth attempting?", which is what keeps a transcript of
 * pure prose from touching a grammar chunk at all. Whether a grammar EXISTS is a separate question
 * with a separate answer (`highlightCode` returns `undefined`), asked asynchronously.
 */
export function namedLanguages(segments: readonly Segment[]): string[] {
  const found = new Set<string>();
  for (const segment of segments) {
    if (segment.kind === "code" && segment.lang.length > 0) found.add(segment.lang);
  }
  return [...found].sort();
}
