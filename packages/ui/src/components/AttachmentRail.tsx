/**
 * The images attached to the prompt being written.
 *
 * ## Why a separate component rather than markup inside the composer
 *
 * The composer is already the densest part of the app — a rail, an unavailable-reason line, the field, a chrome row, a
 * notices row and a sheet. Adding four chips, a drop target and a refusal line inline would make it the place where every
 * new idea goes. This is one surface with one job: show what will be sent, and let each be removed.
 *
 * ## What it must get right, each of which is a way to get it wrong
 *
 * 1. **Tell the truth about size BEFORE sending.** A chip shows the decoded size, so a 2.9 MB screenshot is visibly
 *    close to the limit rather than a surprise refusal after typing.
 * 2. **Be removable by keyboard, individually, and labelled.** A chip whose only affordance is a small × is unusable
 *    with a screen reader, and one that removes "the last attachment" is a different feature.
 * 3. **Refuse visibly.** A refusal is a sentence in the composer's own chrome row, not a toast somewhere else — the
 *    reader's eyes are on the field, and a message that appears in a corner is a message that gets missed.
 * 4. **Never show a broken thumbnail as a blank box.** The preview is a real `<img>` from a blob URL; if the browser
 *    cannot decode it, the chip says so. The same rule as `TranscriptImage`.
 */
import { useEffect, useMemo, useState } from "react";
import { formatBytes } from "../format.ts";
import { MAX_ATTACHMENTS, type Attachment } from "../attachments.ts";

export function AttachmentRail({
  attachments,
  onRemove,
}: {
  attachments: readonly Attachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <ul className="attach-rail" aria-label={`${attachments.length} image${attachments.length === 1 ? "" : "s"} attached`}>
      {attachments.map((attachment) => (
        <AttachmentChip key={attachment.id} attachment={attachment} onRemove={onRemove} />
      ))}
      {attachments.length >= MAX_ATTACHMENTS && (
        <li className="attach-limit" role="status">
          {MAX_ATTACHMENTS} of {MAX_ATTACHMENTS} — remove one to add another
        </li>
      )}
    </ul>
  );
}

function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove: (id: string) => void }) {
  const [broken, setBroken] = useState(false);

  /*
   * The blob URL is created here and revoked on unmount, which is the opposite of the transcript's shared cache — and
   * deliberately so. An attachment is a resource with a SHORT, knowable lifetime: it exists while the chip exists, and
   * the chip exists only until the prompt is sent. There is no re-render storm to protect against (the composer does not
   * re-plan on every record) and no reuse to gain, so the simple owned-lifetime version is the correct one here.
   */
  const url = useMemo(() => {
    if (broken) return undefined;
    const binary = atob(attachment.data);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return URL.createObjectURL(new Blob([bytes], { type: attachment.mediaType }));
  }, [attachment.data, attachment.mediaType, broken]);

  useEffect(() => {
    if (url === undefined) return undefined;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return (
    <li className="attach-chip">
      {url !== undefined ? (
        <img
          className="attach-thumb"
          src={url}
          // The label, not "attachment": a reader with several needs to tell them apart, and the label is the only
          // handle either of them has on which image this is.
          alt={`Attached image: ${attachment.label}`}
          onError={() => setBroken(true)}
          decoding="async"
        />
      ) : (
        <span className="attach-thumb is-broken" aria-hidden="true">
          <span className="attach-thumb-mark">?</span>
        </span>
      )}
      <span className="attach-meta">
        <span className="attach-label" title={attachment.label}>
          {attachment.label}
        </span>
        <span className="attach-size mono">
          {attachment.mediaType.replace("image/", "").toUpperCase()} · {formatBytes(attachment.bytes)}
        </span>
      </span>
      <button
        type="button"
        className="attach-remove"
        onClick={() => onRemove(attachment.id)}
        // Named, because "Remove" repeated four times tells a screen reader nothing about which.
        aria-label={`Remove ${attachment.label}`}
        title={`Remove ${attachment.label}`}
      >
        Remove
      </button>
    </li>
  );
}
