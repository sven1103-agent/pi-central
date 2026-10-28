/**
 * An image from the session's working directory (issue #106).
 *
 * ## `<img src={blobUrl}>`, and nothing else
 *
 * Not inline SVG, not `dangerouslySetInnerHTML`, not a `data:` URI we build by hand. Three reasons,
 * in order of how much they matter:
 *
 *   1. **ADR-0006 keeps exactly one insertion point.** An image rendered as an `<img>` is a
 *      subresource, not markup, so the invariant test still counts one `dangerouslySetInnerHTML` in
 *      the whole UI. Inlining an SVG would quietly make it two.
 *   2. **An `<img>`-embedded SVG cannot execute script** and cannot load a subresource: browsers
 *      treat `file://` and script inside an image document as inert. The CSP (`img-src 'self' data:`)
 *      covers the rest. That is a *layered* guarantee rather than a promise about our own parser.
 *   3. **The type is the orchestrator's.** It sniffed magic numbers; the browser is told what the
 *      bytes are rather than being invited to guess. A `.png` containing HTML never reaches here as
 *      an image — it comes back as text.
 *
 * ## Why the blob URL is created here and not held in state
 *
 * A URL is a resource with a lifetime. Held in the store it would be recreated on every render and
 * never revoked; held in a `useEffect` with a cleanup it is created once per image and released when
 * the pane unmounts or the file changes. The `revokeObjectURL` in the cleanup is the point: a session
 * with 8 MB images would otherwise accumulate them for as long as the tab is open.
 */
import { useEffect, useMemo, useState } from "react";
import { formatBytes } from "../format.ts";

/** Base64 → the bytes it encodes, without a network round trip or a `FileReader`. */
function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function ImageViewer({
  path,
  type,
  base64,
  bytes,
}: {
  path: string;
  /** `image/png`, `image/jpeg`, `image/gif`, `image/webp` or `image/svg+xml` — from the orchestrator. */
  type: string;
  base64: string;
  bytes: number;
}) {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [broken, setBroken] = useState(false);

  // Rebuilt only when the image itself changes, so a parent re-render does not make a new URL.
  const blob = useMemo(() => new Blob([bytesOf(base64)], { type }), [base64, type]);

  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    setBroken(false);
    return () => URL.revokeObjectURL(next);
  }, [blob]);

  /**
   * Nothing is rendered until the blob URL exists — and the reason is a bug this shipped with.
   *
   * `url` is `undefined` on the first render, and `<img src={undefined}>` renders an `<img>` with NO
   * `src`. A browser fires **`error`** for that, which set `broken` on the very first frame — so the
   * component switched to the failure note and never showed the real image once the effect produced
   * the URL a moment later. It failed permanently, for every image, while the orchestrator's bytes
   * were perfectly good.
   *
   * Returning nothing for one frame is the honest version: there is nothing to show yet, and an
   * `<img>` with no source is not a thing that can be "displayed".
   */
  if (url === undefined) return null;

  if (broken) {
    // A file whose bytes are a valid image header but whose payload is truncated or corrupt. Said
    // plainly rather than left as a blank box, for the same reason every other refusal in this pane
    // is stated: an empty pane reads as "this file is empty", which is a different fact.
    return (
      <p className="filetree-note filetree-error" role="note">
        <strong>Could not display {path}</strong>
        <span className="filetree-error-detail">
          {/* Stated precisely, because the over-claiming version was wrong twice: it said "a
              image/png" (ungrammatical) and implied the whole file was a valid header. What we know
              is narrower — the orchestrator recognised the leading bytes, and the browser could not
              decode the result, so the file is truncated or the payload is corrupt. */}
          The browser could not decode this image. Its leading bytes are a valid {type} header, so the
          file is most likely truncated or corrupt.
        </span>
      </p>
    );
  }

  return (
    <div className="imagepane">
      <img
        className="imagepane-img"
        src={url}
        // The filename, so the image is described for anyone who cannot see it. Not "image", which
        // describes nothing.
        alt={path}
        onError={() => setBroken(true)}
      />
      <p className="imagepane-meta">
        {type} · {formatBytes(bytes)}
      </p>
    </div>
  );
}
