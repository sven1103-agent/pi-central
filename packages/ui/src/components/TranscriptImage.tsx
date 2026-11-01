/**
 * An image inside a turn (issue: images in the transcript, a pasted screenshot, a `read` of a PNG).
 *
 * ## What this replaces
 *
 * `blocksFromContent` used to drop image blocks with the note *"the transcript has no image viewer"*. That was true
 * and it stopped being acceptable the moment a screenshot could be pasted into the composer: the turn then rendered
 * as nothing at all, which reads as "the reader sent no message" — a false statement about the conversation.
 *
 * ## The four things this must get right, each of which is a way to get it wrong
 *
 * 1. **Nothing is drawn that cannot be.** `block.refused` is decided in the reducer, not here, and each refusal is
 *    STATED. An empty box reads as "this session contains no image", which is a different fact from "this one is a
 *    TIFF" or "its payload is empty".
 * 2. **The URL survives a re-render.** It comes from `images.ts`, keyed by `(session, message, block)`, precisely
 *    because the transcript re-plans on every streaming delta. A URL built per render would be revoked and rebuilt
 *    dozens of times a second for an image that is not changing.
 * 3. **It cannot push the next turn off the screen.** `max-height` in CSS, plus `loading="lazy"` and
 *    `decoding="async"`: the decode is deferred until the image is near the viewport and never blocks the main
 *    thread, which is what keeps a 37-image conversation scrollable while a run streams.
 * 4. **The bytes are the ones Pi recorded.** A blob URL built from the block's own base64, with the type Pi stated —
 *    not a re-sniffed guess. `ImageViewer` makes the same argument for the file pane, and the reason is the same:
 *    a `.png` full of HTML must never reach a renderer as an image.
 *
 * ## ADR-0006
 *
 * This is a subresource, not markup. An `<img src="blob:…">` is inert: it cannot run script and cannot load a
 * further subresource, and `UI_CSP`'s `img-src 'self' data: blob:` already permits the scheme (guarded by
 * `test/csp-blob.test.mjs`). The single `dangerouslySetInnerHTML` insertion point stays in `Prose`.
 */
import { useState } from "react";
import { base64Bytes, type ImageBlock } from "../transcript.ts";
import { formatBytes } from "../format.ts";
import { useBlobUrl } from "../images.ts";

export function TranscriptImage({
  block,
  identity,
  role,
}: {
  block: ImageBlock;
  /** The blob-URL key: `imageKey(sessionId, messageId, block.contentIndex)`. */
  identity: string;
  /** Whose words this image accompanies, for the caption and the alt text. */
  role: "user" | "assistant" | "tool" | "system";
}) {
  // A payload that passed the reducer's checks and still fails to decode (truncated base64, say). Reported rather
  // than left blank — see `ImageViewer`'s note on the same distinction.
  const [broken, setBroken] = useState(false);

  const refused = block.refused;
  const bytes = base64Bytes(block.base64);
  const size = bytes > 0 ? formatBytes(bytes) : "no data";

  /*
    Refusals first, and BEFORE the hook.

    Conditional hooks are illegal, so the hook cannot be called here and skipped below. `useBlobUrl` is therefore
    called unconditionally — with an empty payload when refused, which the cache answers without building a Blob
    (see `images.ts`: an empty `base64` never reaches `blobUrlFor` through this path because `refused` is checked
    here, and `build` returns a URL for `""` harmlessly). The alternative — an early `return` above the hook — is
    the one thing this file must not do.
  */
  const url = useBlobUrl(identity, block.type, refused === undefined && !broken ? block.base64 : "");

  if (refused === "unsupported-type") {
    return (
      <figure className="turn-image is-refused">
        <p className="turn-image-note" role="note">
          <strong>{block.type}</strong> image not shown — this view displays PNG, JPEG, GIF and WebP only.
          Its {size} are recorded in the session, so the agent can still see it.
        </p>
      </figure>
    );
  }

  if (refused === "no-payload") {
    return (
      <figure className="turn-image is-refused">
        <p className="turn-image-note" role="note">
          This message recorded a <strong>{block.type}</strong> image with no data. Nothing can be shown, and
          nothing is missing from the view: the session itself holds an empty payload.
        </p>
      </figure>
    );
  }

  if (broken || url === undefined) {
    return (
      <figure className="turn-image is-refused">
        <p className="turn-image-note" role="note">
          <strong>Could not display this image</strong> — the browser could not decode its {size} as{" "}
          {block.type}. The session holds it; this view cannot draw it.
        </p>
      </figure>
    );
  }

  return (
    <figure className="turn-image">
      <img
        className="turn-image-img"
        src={url}
        /*
         * The alt text names WHAT and WHOSE, because that is what a reader who cannot see it needs in order to follow
         * the conversation: "your screenshot" and "the assistant's image" are different turns. Not the base64, and not
         * the filename (there is none — Pi records no path for a pasted image).
         */
        alt={`Image in ${role === "user" ? "your" : `the ${role}'s`} message`}
        onError={() => setBroken(true)}
        /*
         * `lazy` + `async`, and neither is cosmetic.
         *
         * `lazy` defers the fetch AND the decode for an image that is not near the viewport. A conversation with 37
         * screenshots would otherwise decode all of them on open, which is ~130 MB of RGBA and a visible stall on the
         * exact interaction this feature is for (a reload). `async` keeps whatever raster remains off the main thread
         * so a streaming run does not stutter while images resolve.
         */
        loading="lazy"
        decoding="async"
      />
      <figcaption className="turn-image-meta">
        {block.type} · {size}
      </figcaption>
    </figure>
  );
}
