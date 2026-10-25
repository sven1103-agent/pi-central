/**
 * The untrusted-content rendering pipeline (ADR-0006).
 *
 * Everything the UI displays from Pi — assistant prose, tool output, file contents, diff
 * bodies — is **attacker-influenced**. It routinely carries text from repository files,
 * fetched pages, command output, and dependency sources. None of it is trustworthy.
 *
 * This module is the single place where such a string may become markup. The order is the
 * safety property, not a detail:
 *
 *   untrusted string
 *     → markdown-it with { html: false }   (model output has no need to emit raw HTML)
 *     → DOMPurify                          (defence in depth, even with HTML off)
 *     → a string of sanitized HTML
 *
 * The result is inserted with `dangerouslySetInnerHTML` at exactly ONE call site, and a test
 * asserts that. An earlier draft of this comment said "no dangerouslySetInnerHTML outside it"
 * — the point of the single site is that it is *countable*, so the invariant is enforced by
 * counting rather than by review.
 *
 * Why the effort is proportionate: this UI holds a WebSocket to the orchestrator and can
 * issue `prompt`, `abort`, `set_model`, `switch_session`. Script executing in this origin is
 * not "an XSS bug" — it is remote control of every supervised session, with the user's own
 * privileges.
 */
import MarkdownIt from "markdown-it";
import createDOMPurify from "dompurify";

/**
 * DOMPurify's module shape differs by environment, and the difference is not cosmetic.
 *
 * In a browser the default export is an **instance** bound to the real `window`. In Node it
 * is a **factory** that needs a `window` supplied. Calling `.sanitize()` on the Node export
 * throws `addHook is not a function` — which is how this was found.
 *
 * Resolved once, lazily, so the browser path is the plain instance and the Node path is only
 * used by tests.
 */
type Purifier = { sanitize: (html: string, config?: Record<string, unknown>) => string; addHook: (name: string, cb: (node: unknown) => void) => void };

let cachedPurifier: Purifier | undefined;

function getPurifier(): Purifier {
  if (cachedPurifier) return cachedPurifier;

  const candidate = createDOMPurify as unknown;
  const purifier =
    typeof candidate === "function"
      ? (candidate as (window: unknown) => unknown)(globalThis.window)
      : candidate;
  const resolved = purifier as Purifier;

  // Install the link hardening once per instance, so it cannot be forgotten by a caller
  // (ADR-0006: link *behaviour* is part of the decision, not just the href).
  resolved.addHook("afterSanitizeAttributes", (node: unknown) => {
    const element = node as { tagName?: string; setAttribute?: (k: string, v: string) => void };
    if (element.tagName === "A" && typeof element.setAttribute === "function") {
      element.setAttribute("rel", "noopener noreferrer nofollow");
      element.setAttribute("target", "_blank");
    }
  });

  cachedPurifier = resolved;
  return resolved;
}

/**
 * `html: false` is the first line of defence and the one that actually matters.
 *
 * With it enabled, a README containing `<script>` would be parsed as markup and only
 * DOMPurify would stand between the reader and execution. With it disabled, that tag renders
 * as visible escaped source, which is both correct and safe: someone reading a Markdown file
 * that contains raw HTML wants to *see* it.
 *
 * `linkify: true` creates links from bare URLs. Those are still sanitized below.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false, // no smart quotes: this is code-adjacent text, fidelity beats prettiness
});

/**
 * Harden every generated anchor.
 *
 * markdown-it already refuses `javascript:` in link destinations, and DOMPurify would strip
 * it, but link *behaviour* is also part of the decision (ADR-0006): a click must not
 * navigate this origin away, and a `target=_blank` without `rel=noopener` hands the opener
 * to the linked page.
 *
 * Registered on the purifier instance in `getPurifier`, so it cannot be skipped.
 */

/**
 * Render untrusted Markdown to sanitized HTML.
 *
 * The ONLY function in the UI permitted to produce HTML from untrusted input. Returns a
 * string deliberately: the caller must make the single `dangerouslySetInnerHTML` insertion,
 * which keeps that decision visible at the call site rather than hidden in a component.
 */
export function renderMarkdown(source: string): string {
  if (!source) return "";
  return getPurifier().sanitize(md.render(source), {
    // Allow the tags Markdown actually emits, plus the table/footnote set. Anything absent
    // here cannot survive sanitization even if a future markdown-it plugin emits it.
    ALLOWED_TAGS: [
      "p", "br", "hr", "strong", "em", "del", "s", "blockquote", "code", "pre",
      "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
      "a", "img", "table", "thead", "tbody", "tr", "th", "td",
      "span", "div", "sup", "sub",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "target", "rel", "colspan", "rowspan"],
    // No data: or javascript: in hrefs; the hook above adds rel/target afterwards.
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
  });
}

/**
 * Render untrusted plain text for display.
 *
 * Tool output, command results, and file previews are NOT Markdown. Running them through the
 * Markdown pipeline would reinterpret their contents (a `*` in a diff, `_` in a filename,
 * a leading `#` in a shell transcript) and change what the user sees. This returns plain text
 * for React to escape, which is the honest rendering.
 */
export function renderPlain(source: string): string {
  return source;
}

/**
 * Would this string be rewritten by the Markdown pipeline?
 *
 * Used by the transcript to decide between prose and preformatted rendering, and to surface
 * that decision in the UI. Kept trivial on purpose: the caller decides, the pipeline does
 * not guess.
 */
export function looksLikeMarkdown(source: string): boolean {
  const head = source.slice(0, 4000);
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.*\|)/.test(head) || /\[[^\]]+\]\([^)]+\)/.test(head);
}

/**
 * A link target is safe to offer as "open" only if it is an absolute URL with a permitted
 * scheme.
 *
 * No base is passed to `URL`, and that is the whole point. The first version passed
 * `"https://local.invalid"` as a base, which silently defeated the check: `new URL` resolves
 * a relative reference against the base, so `/etc/passwd` became
 * `https://local.invalid/etc/passwd` and every relative string reported protocol `https:`.
 * A relative link is meaningless for an "open this link" affordance anyway, and the render
 * pipeline strips it (ALLOWED_URI_REGEXP requires a scheme), so it must be refused here too.
 *
 * Having no base means a scheme-less string throws, which is the behaviour we want.
 */
export function isNavigable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}
