/**
 * Images attached to a prompt in the composer, before they are sent (issue: clipboard images).
 *
 * ## The shape of the problem
 *
 * An attachment is not a draft and not a transcript entry. It is a thing the reader has selected that belongs to no
 * message yet, with three awkward properties:
 *
 *   1. **It is large.** A screenshot is 100 KB to several MB once encoded. It must not go to `localStorage`, and it must
 *      not be held longer than the prompt it belongs to — hence `clearAttachments` on send, on abort, and on a session
 *      switch.
 *   2. **It has a lifecycle the user can see.** Pasting five files must show five, each removable, and the reader must be
 *      able to tell which one is too large BEFORE typing a message and pressing Enter.
 *   3. **It must be per SESSION.** Drafts are per session (`App.tsx`), and an attachment that leaked from one session to
 *      another would be sent to the wrong agent in the wrong directory — a worse leak than a stray draft, because it is
 *      content rather than text.
 *
 * ## Why this is a module rather than `useState` in the composer
 *
 * The rules are arithmetic and validation: how many may be attached, how big one may be, what happens when the sixth is
 * pasted, whether a duplicate is a second attachment. A component cannot be exercised for those in this test setup
 * (static render, no effects, no data transfer), so the decisions live here where they can be.
 *
 * The size and type limits intentionally DUPLICATE nothing: `MAX_PROMPT_IMAGE_BYTES` lives in the orchestrator
 * (`prompt-images.ts`) and is the authority. What is here is a client-side PRE-CHECK so the reader is told before
 * sending, and the numbers are stated once, in `attachmentLimits`, so this file cannot drift from the sentence the
 * orchestrator would otherwise have to say after the fact.
 */

/**
 * The largest single attachment accepted by the composer, in decoded bytes.
 *
 * **Equal to the orchestrator's cap, deliberately, and hard-coded rather than imported.** The orchestrator does not ship
 * to the browser, so importing its constant would pull a Node-flavoured module into the bundle — and this one is a
 * PRE-CHECK, so the reader is told before sending rather than after the fact. The orchestrator remains the authority;
 * this only decides whether to bother it.
 *
 * The duplication is a real cost, and it is pinned: `packages/ui/test/attachments.test.mjs` reads BOTH files and asserts
 * the two numbers are equal, so changing one alone fails a test instead of surfacing as a paste that the composer
 * accepts and the orchestrator refuses. That is the only kind of guard that works for a value that must exist twice.
 */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/**
 * How many images may ride on one prompt.
 *
 * Four. The budget is not arbitrary: four screenshots is a "before/after/full/cropped" set, which is the shape these
 * arrive in, and every provider prices per image — so a limit is a kindness as well as a guard. Beyond four the composer
 * refuses with a sentence rather than silently dropping the fifth.
 */
export const MAX_ATTACHMENTS = 4;

/**
 * The largest TOTAL encoded payload one prompt may carry: 6 MB of base64.
 *
 * ## Why a per-image cap was not enough, with the measurement
 *
 * The transport refuses a frame above 8 MB. One image at `MAX_ATTACHMENT_BYTES` encodes to 4.19 MB — inside it. **Four**
 * of them is 16.78 MB, so `ws` closes the socket with 1009 and the client gets no reply at all: the composer would empty
 * itself into a dead connection with no message. Measured, not estimated. A limit on each part does not bound the whole.
 *
 * The number matches the orchestrator's `MAX_PROMPT_IMAGES_ENCODED_BYTES`; `attachments.test.mjs` reads both files and
 * asserts they are equal, so the pre-check cannot drift from the authority.
 */
export const MAX_TOTAL_ENCODED_BYTES = 6 * 1024 * 1024;

/** The formats a paste may produce. Must match the orchestrator's allow-list. */
export const ATTACHMENT_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** One image waiting to be sent. */
export interface Attachment {
  /**
   * Stable identity for React keys and for removal.
   *
   * A counter rather than the base64 or the filename: two pastes of the same screenshot are two attachments the reader
   * added twice, and keying on content would make the second unremovable — React would collapse them into one key.
   */
  id: string;
  /** `image/png` and friends, lowercase, already checked against `ATTACHMENT_TYPES`. */
  mediaType: string;
  /** Base64, no `data:` prefix. */
  data: string;
  /** Decoded size, for the chip. */
  bytes: number;
  /**
   * Where it came from, for the chip's label.
   *
   * A pasted screenshot has no filename in any browser (`ClipboardItem` exposes a type and bytes), so this is
   * `"pasted image"` for a paste and the file's name for a drop. The distinction is worth showing because it is the only
   * handle a reader has on what they attached.
   */
  label: string;
}

/** Why a paste or drop was refused. A closed set, so the composer must handle each. */
export type AttachmentRefusal = "unsupported-type" | "too-large" | "too-many" | "batch-too-large";

/** The sentence a reader sees. One place, so the chip list and a toast cannot describe the same refusal differently. */
export function refuseAttachment(refusal: AttachmentRefusal, detail: { type?: string; bytes?: number } = {}): string {
  switch (refusal) {
    case "unsupported-type":
      return `${detail.type ?? "that file"} cannot be attached — PNG, JPEG, GIF and WebP only`;
    case "too-large":
      return `that image is ${megabytes(detail.bytes ?? 0)}, above the ${megabytes(MAX_ATTACHMENT_BYTES)} limit — downscale it and paste again`;
    case "too-many":
      return `a prompt can carry ${MAX_ATTACHMENTS} images — remove one to add another`;
    case "batch-too-large":
      return `these images total ${megabytes(detail.bytes ?? 0)} encoded, above the ${megabytes(MAX_TOTAL_ENCODED_BYTES)} limit for one prompt — remove one or downscale them`;
  }
}

function megabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "an unknown size";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Decoded size of base64, without decoding. Mirrors `prompt-images.ts#base64Bytes`, and a test pins them equal. */
export function attachmentBytes(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * Add one attachment to the list, or say why not.
 *
 * Returns a new list rather than mutating, so the caller can keep it in React state without a copy of its own. Refusals
 * leave the list UNCHANGED — a partial add is the failure this shape prevents.
 */
export function addAttachment(
  current: readonly Attachment[],
  candidate: { mediaType: string; data: string; label: string },
  nextId: string,
): { ok: true; attachments: Attachment[] } | { ok: false; reason: AttachmentRefusal } {
  const mediaType = candidate.mediaType.toLowerCase();
  if (!ATTACHMENT_TYPES.includes(mediaType)) return { ok: false, reason: "unsupported-type" };

  const bytes = attachmentBytes(candidate.data);
  if (bytes > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too-large" };

  /*
   * The cap is checked BEFORE the add, not after.
   *
   * Adding and then trimming would make the fifth paste silently evict the first — and the reader would send a set they
   * did not compose. A refusal is visible; a silent eviction is not.
   */
  if (current.length >= MAX_ATTACHMENTS) return { ok: false, reason: "too-many" };

  /*
   * The TOTAL, checked before the add rather than after.
   *
   * Summed on the ENCODED lengths, because that is what the frame carries. Without this the composer would happily hold
   * four images that the orchestrator refuses — or worse, a frame the transport closes the socket over.
   */
  const total = current.reduce((sum, attachment) => sum + attachment.data.length, 0) + candidate.data.length;
  if (total > MAX_TOTAL_ENCODED_BYTES) return { ok: false, reason: "batch-too-large" };

  return {
    ok: true,
    attachments: [...current, { id: nextId, mediaType, data: candidate.data, bytes, label: candidate.label }],
  };
}

/** Remove one by id. Unknown ids are a no-op, so a double click cannot throw or corrupt the list. */
export function removeAttachment(current: readonly Attachment[], id: string): Attachment[] {
  return current.filter((attachment) => attachment.id !== id);
}

/**
 * Can this prompt be SENT?
 *
 * A message with no words but with images is complete — a screenshot with no question is a question ("what is this?"),
 * and Pi accepts an empty message when images are present because the image is the content. That is why this is not
 * simply `message.trim().length > 0`.
 */
export function canSend(message: string, attachments: readonly Attachment[]): boolean {
  return message.trim().length > 0 || attachments.length > 0;
}

/**
 * Whether a model can accept images, from `ModelOption.input`.
 *
 * Three states, and the middle one is the point:
 *
 *   - `"yes"`   — Pi reported the model accepts `image`
 *   - `"no"`    — Pi reported an `input` list WITHOUT `image`: the affordance must be suppressed, or a paste would fail
 *                 at the provider with an error the reader cannot act on
 *   - `"unknown"` — Pi reported no `input` at all. Treated as permitted: a missing catalogue field is not a statement
 *                 that the model is text-only, and hiding the feature on unknown would remove it for every model whose
 *                 entry omits the field. The failure mode of "unknown → allowed" is one provider error; the failure mode
 *                 of "unknown → hidden" is a feature that silently does not exist.
 */
export function imageSupport(input: readonly string[] | undefined): "yes" | "no" | "unknown" {
  if (input === undefined) return "unknown";
  return input.includes("image") ? "yes" : "no";
}

/**
 * The payload form sent on the wire.
 *
 * `{ mediaType, data }` rather than the attachment itself: `id`, `bytes` and `label` are composer state, and sending them
 * would put a client's bookkeeping into a message the model sees. The wire shape is stated in `PromptImage`.
 */
export function toPromptImages(attachments: readonly Attachment[]): { mediaType: string; data: string }[] {
  return attachments.map(({ mediaType, data }) => ({ mediaType, data }));
}
