/**
 * Syntax highlighting, lazily, and deliberately OUTSIDE the sanitisation boundary (issue #4).
 *
 * ## Why this returns tokens rather than HTML
 *
 * Highlighting is the most plausible thing to bolt on *in front of* ADR-0006's pipeline, and doing
 * so would quietly break the security property. A highlighter emits markup, and the single counted
 * `dangerouslySetInnerHTML` site exists so that "markup derived from untrusted text" has exactly
 * one address. So this module never produces HTML for insertion, and it never adds an attribute to
 * an allow-list.
 *
 * It returns **plain data** — lines of `{ text, color, italic }` — which React renders as elements.
 * That gives the issue's preferred branch ("output is React elements") and three concrete wins over
 * the string path:
 *
 *   - **No `style` attribute ever passes through the sanitizer.** Shiki's string output writes
 *     `style="color:#ff7b72"` on its spans; React writes the same property through the DOM API
 *     instead, so the Markdown allow-list keeps refusing `style` and no new injection surface is
 *     opened where none existed. That is the reason for this shape, not tidiness.
 *   - **The code text is escaped by React**, not by the highlighter, so a source file containing
 *     `</span>` cannot escape its element by construction rather than by Shiki's correctness.
 *   - **The colours are ours.** A token carries a colour; the component renders it as a CSS
 *     variable lookup, so the theme lives in `styles.css` beside every other colour rather than in
 *     markup the app does not control.
 *
 * ## Why lazy, and what is eager
 *
 * Shiki's grammars plus a TextMate engine are ~200 kB, and the issue asks for the cost to be
 * MEASURED rather than assumed. So:
 *
 *   - **Eager: a name set.** `@shikijs/langs`' `languageNames`/`languageAliasNames` are a few
 *     hundred short strings and no grammars. This is what makes an unknown language recognisable as
 *     unknown WITHOUT attempting a dynamic import that would fail — the fallback is a decision, not
 *     an error path.
 *   - **Lazy, once per language:** the grammar, via `import.meta.glob`. Vite emits one chunk per
 *     grammar, so a session that never shows a fenced block never fetches one.
 *   - **Lazy, once ever:** the highlighter core and the theme.
 *
 * ## The engine, and why the JavaScript one
 *
 * Shiki ships an Oniguruma engine (wasm, most accurate) and a JavaScript regex engine. The wasm
 * engine needs the page's CSP to permit WebAssembly compilation; this UI is served by the
 * orchestrator under a strict `script-src 'self'` with no `wasm-unsafe-eval`. Widening the policy
 * for the whole origin so that code can be coloured would trade a real security property for a
 * cosmetic one. The JavaScript engine needs no relaxation, and the accuracy difference is invisible
 * in a transcript.
 */
import type { ReactNode } from "react";
import { createElement } from "react";

/** One token: a run of characters sharing a style. */
export interface Token {
  text: string;
  /** A hex colour from the theme, or undefined for the theme's default foreground. */
  color?: string | undefined;
  italic?: boolean | undefined;
}

/**
 * A highlighted block, as data.
 *
 * Lines are separate so the component can render one element per line: a `<pre>` with real
 * newlines renders identically, but per-line elements let a long-line layout be handled in CSS
 * later without re-tokenizing.
 */
export interface HighlightedCode {
  lang: string;
  lines: Token[][];
}

/** The surface of Shiki's core highlighter this module uses, narrowed so a version bump is visible. */
interface HighlighterLike {
  codeToTokens: (code: string, options: { lang: string; theme: string }) => { tokens: RawToken[][] };
  loadLanguage: (...langs: unknown[]) => Promise<void>;
  getLoadedLanguages: () => string[];
}

interface RawToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

export const THEME = "github-dark-default";

/**
 * The name → chunk map, fetched on first use.
 *
 * It lives in its own module (`grammar-map.ts`) so that the map itself is a lazy chunk rather than
 * ~24 kB of eager entry — see that file's comment for the measurement. Until it arrives there is no
 * way to answer "does this build have a grammar for X?", so no answer is attempted.
 */
let grammars: Record<string, () => Promise<{ default: unknown }>> | undefined;
let grammarMapLoading: Promise<Record<string, () => Promise<{ default: unknown }>>> | undefined;

async function grammarMap(): Promise<Record<string, () => Promise<{ default: unknown }>>> {
  if (grammars) return grammars;
  if (!grammarMapLoading) {
    grammarMapLoading = import("./grammar-map.ts")
      .then((module) => {
        grammars = module.grammars;
        return grammars;
      })
      .catch(() => {
        // Retryable: a transient chunk failure must not disable highlighting for the session.
        grammarMapLoading = undefined;
        return {} as Record<string, () => Promise<{ default: unknown }>>;
      });
  }
  return grammarMapLoading;
}

let highlighter: HighlighterLike | undefined;
let loading: Promise<HighlighterLike | undefined> | undefined;
const loaded = new Set<string>();
const grammarLoaders = new Map<string, Promise<{ default: unknown } | undefined>>();

function normalize(language: string): string {
  return language.trim().toLowerCase();
}

/**
 * The grammar file for a language, if this build has one.
 *
 * **Decided by the FILES, not by a name list.** Two attempts at a name gate were wrong, and both
 * failures are worth recording because the corrected version looks like it skips a check:
 *
 *   - `languageNames` holds CANONICAL names only, so every alias (`py`, `sh`, `js`) would have been
 *     refused.
 *   - `languageAliasNames` turns out to be a flat list of alias names with **no mapping** to a
 *     canonical grammar, and it is not even complete: it contains `py` but not `c++` or `c#`, which
 *     ship as `cpp.mjs` and `csharp.mjs`. A gate built on it would refuse real languages while
 *     appearing to check something.
 *
 * Reconstructing Shiki's alias→grammar mapping here would be a second source of truth that drifts on
 * the next release. The question actually being asked is "can this build load a grammar for this
 * language?", and the bundled files answer it directly.
 *
 * The candidates cover the shapes that occur — the name as written (`python`, `objective-c`) and the
 * name with punctuation removed (`c++` → `cpp`, `c#` → `csharp`).
 */
async function grammarFileFor(name: string): Promise<string | undefined> {
  if (name.length === 0) return undefined;
  const map = await grammarMap();
  const flattened = name.replace(/[^a-z0-9]/g, "");
  const candidates = [
    `../../../node_modules/@shikijs/langs/dist/${name}.mjs`,
    `../../../node_modules/@shikijs/langs/dist/${flattened}.mjs`,
  ];
  return candidates.find((candidate) => map[candidate] !== undefined);
}

/** Is there a grammar for this language in this build? Async, because the map is a lazy chunk. */
export async function hasGrammar(language: string): Promise<boolean> {
  return (await grammarFileFor(normalize(language))) !== undefined;
}

/**
 * Load a grammar once.
 *
 * A rejection is NOT cached: a transient chunk-fetch failure (offline, a restart mid-load) should
 * be retryable on the next fenced block rather than disabling a language for the life of the page.
 */
async function loadGrammar(name: string): Promise<{ default: unknown } | undefined> {
  const existing = grammarLoaders.get(name);
  if (existing) return existing;
  const file = await grammarFileFor(name);
  const loader = file ? (await grammarMap())[file] : undefined;
  if (!loader) return undefined;
  const promise = loader().then(
    (module) => module,
    () => {
      grammarLoaders.delete(name);
      return undefined;
    },
  );
  grammarLoaders.set(name, promise);
  return promise;
}

/** The highlighter, created once. `undefined` means highlighting is unavailable, which is not fatal. */
async function getHighlighter(): Promise<HighlighterLike | undefined> {
  if (highlighter) return highlighter;
  if (!loading) {
    loading = (async () => {
      try {
        // Imported here rather than at module scope: this is the expensive half, and a session with
        // no code in it should not pay for it.
        const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
          import("@shikijs/themes/github-dark-default"),
        ]);
        const core = await createHighlighterCore({
          themes: [theme],
          langs: [],
          engine: createJavaScriptRegexEngine(),
        });
        highlighter = core as unknown as HighlighterLike;
        return highlighter;
      } catch {
        // Highlighting is decoration. If it cannot load, code must still render — as plain text,
        // through the normal Markdown pipeline. Failing a transcript over colour would be absurd.
        loading = undefined;
        return undefined;
      }
    })();
  }
  return loading;
}

/** `fontStyle` is a bitfield in Shiki; bit 1 is italic. */
function isItalic(fontStyle: number | undefined): boolean {
  return typeof fontStyle === "number" && (fontStyle & 1) === 1;
}

/**
 * Highlight one fenced block, as data.
 *
 * Returns `undefined` — never an empty array, never a throw — when the language is unknown, has no
 * grammar in this build, or Shiki failed to load. `undefined` is the right signal because it lets
 * the caller keep the ORIGINAL text. An empty token list would be indistinguishable from "this
 * block is empty", and the fallback must render the code, not nothing.
 */
export async function highlightCode(code: string, language: string): Promise<HighlightedCode | undefined> {
  if (code.length === 0) return undefined;
  const name = normalize(language);
  // Refused only after the check, and the check itself is the first thing that touches a lazy
  // chunk: an unknown language costs the map but no grammar.
  if (!(await hasGrammar(name))) return undefined;

  const instance = await getHighlighter();
  if (!instance) return undefined;

  try {
    if (!instance.getLoadedLanguages().includes(name)) {
      const grammar = await loadGrammar(name);
      if (!grammar) return undefined;
      await instance.loadLanguage(grammar.default);
      loaded.add(name);
    }
    const { tokens } = instance.codeToTokens(code, { lang: name, theme: THEME });
    return {
      lang: name,
      lines: tokens.map((line) =>
        line.map((token) => ({
          text: token.content,
          ...(token.color !== undefined ? { color: token.color } : {}),
          ...(isItalic(token.fontStyle) ? { italic: true } : {}),
        })),
      ),
    };
  } catch {
    return undefined;
  }
}

/**
 * A token's colour as a CLASS NAME, not an inline style.
 *
 * This is the decision that keeps `style` out of the sanitizer's allow-list. Shiki's string output
 * writes `style="color:#ff7b72"` on every span; rendering that as a style attribute would mean
 * permitting `style` through DOMPurify — a new injection surface, opened for the sole purpose of
 * drawing colours. Instead the theme was measured: `github-dark-default` uses **11 distinct
 * foreground colours**, so a token's hex maps to one of eleven classes and the colours live in
 * `styles.css` beside every other colour in the app.
 *
 * A value that is not a hex colour, or not one of the theme's, yields `undefined`, so the token
 * inherits the block's foreground. That is the correct degradation for a theme change — readable,
 * merely less colourful — and it means nothing from a grammar can reach a style attribute.
 */
export function colorClass(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const hex = color.replace(/^#/, "").toLowerCase();
  // 3-digit hex is expanded so `#fff` and `#ffffff` name the same class.
  const full =
    hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  return /^[0-9a-f]{6}$/.test(full) ? `tk-${full}` : undefined;
}

/**
 * Render highlighted code as React elements.
 *
 * Exported from here rather than from the component so the token→element mapping is testable without
 * a DOM, and so the ONE place that decides how a token looks is next to the reason it is data.
 */
export function highlightedNodes(code: HighlightedCode): ReactNode {
  return createElement(
    "pre",
    { className: `shiki shiki-${code.lang}` },
    createElement(
      "code",
      null,
      code.lines.map((line, lineIndex) =>
        createElement(
          "span",
          { className: "line", key: lineIndex },
          line.length === 0
            ? // An empty line needs a newline, or the blank row would collapse.
              "\n"
            : [
                ...line.map((token, tokenIndex) =>
                  createElement(
                    "span",
                    {
                      key: tokenIndex,
                      // A class, never a style attribute: see `colorClass`.
                      className: [
                        colorClass(token.color),
                        token.italic ? "tk-i" : undefined,
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined,
                    },
                    token.text,
                  ),
                ),
                "\n",
              ],
        ),
      ),
    ),
  );
}

/** Test seam: the languages already resident, so a test can prove laziness rather than assert it. */
export function loadedLanguages(): string[] {
  return [...loaded].sort();
}

/**
 * Test seam: has the Shiki core been created?
 *
 * Distinct from `loadedLanguages`, which counts GRAMMARS. The core is ~114 kB of machinery plus a
 * ~59 kB engine, and the question "was that fetched for this input?" cannot be answered by a grammar
 * count. It is what makes the unknown-language refusal a measurable claim rather than a description:
 * without the early gate, an unknown language still returns `undefined` — but only after loading
 * ~170 kB to discover there is no grammar for it.
 */
export function coreLoaded(): boolean {
  return highlighter !== undefined;
}
