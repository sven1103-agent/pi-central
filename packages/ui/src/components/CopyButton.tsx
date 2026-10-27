/**
 * A copy affordance for any machine value.
 *
 * Every path, command, and id in this UI may be truncated by necessity. Sniffing a middle-
 * ellipsised mono string and retyping it is impossible, so each one gets a copy button — and
 * the result is announced through a live region rather than shown only as a colour change.
 */
import { useState } from "react";
import { copyText } from "../format.ts";

/**
 * The label is rendered VERBATIM (issue #72).
 *
 * It used to be lower-cased for display: `Copy ${label.toLowerCase()}`. That is a correctness bug as
 * soon as a label can be a path, because **paths are case-sensitive** on a case-sensitive filesystem —
 * the button would display `changelog.md` while copying `CHANGELOG.md`, and the visible text is what a
 * reader checks against.
 *
 * So the caller passes the words it wants shown, and this renders them. `FilePane` passes
 * `` `path ${path}` ``, which reads `Copy path CHANGELOG.md` — the whole point being that a screen
 * reader (and the reader) is told WHICH path, since a tree may hold several.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="copy"
      title={`Copy ${label}`}
      onClick={async () => {
        const ok = await copyText(text);
        setCopied(ok);
        // Reset so the button does not claim a state it no longer has.
        setTimeout(() => setCopied(false), 1_500);
      }}
    >
      {copied ? "Copied" : `Copy ${label}`}
    </button>
  );
}
