/**
 * A copy affordance for any machine value.
 *
 * Every path, command, and id in this UI may be truncated by necessity. Sniffing a middle-
 * ellipsised mono string and retyping it is impossible, so each one gets a copy button — and
 * the result is announced through a live region rather than shown only as a colour change.
 */
import { useState } from "react";
import { copyText } from "../format.ts";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="copy"
      title={`Copy ${label.toLowerCase()}`}
      onClick={async () => {
        const ok = await copyText(text);
        setCopied(ok);
        // Reset so the button does not claim a state it no longer has.
        setTimeout(() => setCopied(false), 1_500);
      }}
    >
      {copied ? "Copied" : `Copy ${label.toLowerCase()}`}
    </button>
  );
}
