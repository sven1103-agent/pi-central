/**
 * Prose rendering — the single sanitized insertion point (ADR-0006).
 *
 * This is the ONLY component in the UI allowed to use `dangerouslySetInnerHTML`, and there is
 * an invariant test that counts it. The point of a single site is that it is countable: the
 * rule is enforced by a test rather than by remembering.
 *
 * The HTML comes from `renderMarkdown`, which is markdown-it({html:false}) → DOMPurify. The
 * safety argument lives there, in one place, next to the ordering it depends on.
 */
import { useMemo } from "react";
import { renderMarkdown } from "../markdown.ts";

export function Prose({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // Memoized on the text: re-sanitizing on every keystroke of a long message would be the
  // most expensive thing the UI does.
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="prose"
      // eslint-disable-next-line react/no-danger -- the single audited site, see ADR-0006
      dangerouslySetInnerHTML={{ __html: html }}
      data-streaming={streaming || undefined}
    />
  );
}
