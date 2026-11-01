/**
 * Accepting an image on a prompt, and refusing one with a reason (issue: clipboard images).
 *
 * ## Why this is its own module
 *
 * Because it is the ONLY place untrusted bytes enter a control message, and a trust decision buried in a `switch`
 * arm is a trust decision nobody reviews. `transport.ts` parses; this decides; `supervisor.ts` forwards. The three
 * steps are separate so the middle one can be tested without a socket, a process, or a base64 payload of real size.
 *
 * ## The threat that is actually being handled
 *
 * Not a malicious image — Pi and the provider handle the bytes, and this codebase does not decode them. What is being
 * handled is **a client claiming something the orchestrator has not verified**:
 *
 *   1. **A type of the client's choosing.** `mimeType` is handed to a provider. If the browser sends `text/html`, some
 *      provider receives a claim about content that the browser invented. So the allow-list is checked here, and the
 *      value that reaches Pi is the one from this list — never the string the client sent.
 *   2. **A size the client did not respect.** The browser downscales before sending (it is the only end that can), but
 *      the browser is not the authority on a limit. `MAX_PROMPT_IMAGE_BYTES` is enforced here, and it is deliberately
 *      BELOW the transport's frame limit so an oversized image produces a stated refusal instead of a closed socket.
 *   3. **A payload that is not base64 at all.** A `data:` prefix, a `\n`-wrapped blob, or a truncated string would
 *      otherwise be forwarded and fail deep inside Pi, where the error names a provider rather than the paste.
 *
 * ## Why the cap is a count of BYTES and not of characters
 *
 * `data` is base64, so its length is 4/3 of the payload. A cap applied to the string length would accept a 1.33x
 * larger image than it announced, which is exactly the kind of off-by-a-third that makes a limit advisory. The
 * comparison is done on the decoded size, computed without decoding — see `base64Bytes`.
 *
 * ## What this cannot do, stated rather than implied
 *
 * It cannot tell a PNG from a JPEG with the wrong `mediaType`; it does not sniff magic numbers, unlike `files.ts`.
 * Sniffing here would duplicate a decision Pi already makes when it builds the provider request, and the consequence of
 * a mismatch is a provider error rather than a security boundary. What matters is that the value is from a closed set.
 */

/** The formats a prompt may carry. The same four the transcript will draw, for the reason `PromptImage` records. */
export const PROMPT_IMAGE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/**
 * The largest image a prompt may carry, in DECODED bytes.
 *
 * 3 MB, and the number is derived rather than chosen. The transport refuses a frame above 8 MB
 * (`transport.ts`), base64 costs 4/3, and a JSON envelope adds a little on top — so 3 MB decodes to ~4 MB of base64 and
 * leaves roughly 4 MB of headroom for the rest of the frame (a long prompt, several images). An image above this is
 * refused with words the reader can act on ("downscale it"), which is the outcome the transport's silent close was
 * denying them.
 *
 * Deliberately BELOW `MAX_IMAGE_BYTES`'s 8 MB, which is the FILE VIEWER's cap. They are different acts: viewing reads
 * a file from disk into one `<img>`, while a prompt copies bytes into a message that is stored in the session and sent
 * to a provider on every subsequent turn. Conversation history is not the place for an 8 MB screenshot.
 */
export const MAX_PROMPT_IMAGE_BYTES = 3 * 1024 * 1024;

/** What was accepted: the type as verified, and the payload unchanged. */
export interface AcceptedImage {
  mediaType: string;
  data: string;
}

/** Why an image was refused. A closed set, so the caller must handle each rather than print prose. */
export type ImageRefusal =
  | "not-an-object"
  | "missing-type"
  | "missing-data"
  | "unsupported-type"
  | "too-large"
  | "not-base64";

/** The sentence a reader sees. Written here so the UI and the log cannot describe the same refusal differently. */
export function refuseImage(refusal: ImageRefusal, detail?: { type?: string; bytes?: number }): string {
  switch (refusal) {
    case "unsupported-type":
      return `an image of type ${detail?.type ?? "unknown"} cannot be sent — prompts accept PNG, JPEG, GIF and WebP`;
    case "too-large":
      return `that image is ${formatMegabytes(detail?.bytes ?? 0)} decoded, above the ${formatMegabytes(MAX_PROMPT_IMAGE_BYTES)} limit for a prompt — downscale it and paste again`;
    case "not-base64":
      return "that image's data is not valid base64 — it may have been truncated in transit";
    case "missing-type":
      return "an image arrived without a media type";
    case "missing-data":
      return "an image arrived with no data";
    case "not-an-object":
      return "an image arrived in an unrecognised shape";
  }
}

function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "an unknown size";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The decoded size of a base64 string, without decoding it.
 *
 * Padding is subtracted rather than approximated: a limit that reports a size one byte wrong is a limit whose own
 * message is wrong, and this project treats a displayed value that is off by one as a defect rather than a rounding.
 */
export function base64Bytes(data: string): number {
  if (data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * A base64 payload, or not.
 *
 * The alphabet plus padding, checked structurally. This is not a decode — `Buffer.from(x, "base64")` is famously
 * forgiving and silently ignores anything it does not understand, so a validation built on it would accept `"!!!!"`
 * and forward an empty image. Length is required to be a multiple of four because that is what base64 IS; a client
 * that strips padding is not producing base64.
 */
export function isBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(data);
}

/**
 * Validate one image from a control message.
 *
 * Takes `unknown` on purpose: the value crossed a socket as JSON, so its type is a claim rather than a fact, and the
 * signature should force the caller to confront that instead of accepting a `PromptImage` the transport merely cast to.
 */
export function acceptImage(raw: unknown): { ok: true; image: AcceptedImage } | { ok: false; reason: ImageRefusal } {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not-an-object" };
  const candidate = raw as { mediaType?: unknown; data?: unknown };

  if (typeof candidate.mediaType !== "string" || candidate.mediaType.length === 0) {
    return { ok: false, reason: "missing-type" };
  }
  if (typeof candidate.data !== "string" || candidate.data.length === 0) {
    return { ok: false, reason: "missing-data" };
  }

  /*
   * Lowercased BEFORE the allow-list, and the lowercased value is what is forwarded.
   *
   * `image/PNG` and `image/png` are the same format, and a provider may be strict about the spelling. Comparing
   * case-insensitively and then sending the canonical form means a client's capitalisation cannot decide whether an
   * image works — and the value that reaches Pi is still one of the four in the list, never the client's string.
   */
  const mediaType = candidate.mediaType.toLowerCase();
  if (!PROMPT_IMAGE_TYPES.includes(mediaType)) return { ok: false, reason: "unsupported-type" };

  if (!isBase64(candidate.data)) return { ok: false, reason: "not-base64" };

  const bytes = base64Bytes(candidate.data);
  if (bytes > MAX_PROMPT_IMAGE_BYTES) return { ok: false, reason: "too-large" };

  return { ok: true, image: { mediaType, data: candidate.data } };
}

/**
 * The largest TOTAL encoded payload one prompt may carry.
 *
 * ## Why a per-image cap is not enough, and what the measurement showed
 *
 * The transport refuses a frame above 8 MB. A single image at `MAX_PROMPT_IMAGE_BYTES` encodes to 4.19 MB of base64 —
 * comfortably inside it. **Four** of them, in one envelope, is 16.78 MB: over the limit, so `ws` closes the socket with
 * code 1009 and the client gets no reply at all. The reader would see the composer empty itself into a dead connection.
 *
 * That was measured, not estimated, and it is the reason this constant exists. A limit on each part does not bound the
 * whole, which is the general form of the mistake.
 *
 * 6 MB encoded leaves ~2 MB of headroom in an 8 MB frame for the message text, the envelope, and the identifiers — enough
 * for a very long prompt and the four images the composer allows, provided they are not all at the maximum.
 */
export const MAX_PROMPT_IMAGES_ENCODED_BYTES = 6 * 1024 * 1024;

/** The outcome of validating a whole prompt's images. */
export type PromptImages =
  | { ok: true; images: AcceptedImage[] }
  | { ok: false; message: string };

/**
 * Validate every image on a prompt, or refuse the prompt.
 *
 * **All or nothing.** Accepting three of four would send a message the reader did not write, and they would have no way
 * to know which one went missing — the model simply would not mention it. A partial send is worse than a refusal,
 * because a refusal is visible.
 *
 * Two limits apply: each image individually, and the encoded TOTAL. The second is what keeps the frame inside the
 * transport's limit — see `MAX_PROMPT_IMAGES_ENCODED_BYTES` for the measurement that made it necessary.
 */
export function acceptImages(raw: unknown): PromptImages {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, message: "images must be a list" };
  if (raw.length === 0) return { ok: true, images: [] };

  const images: AcceptedImage[] = [];
  for (const entry of raw) {
    const result = acceptImage(entry);
    if (!result.ok) {
      const type = typeof entry === "object" && entry !== null ? (entry as { mediaType?: unknown }).mediaType : undefined;
      const bytes =
        typeof entry === "object" && entry !== null && typeof (entry as { data?: unknown }).data === "string"
          ? base64Bytes((entry as { data: string }).data)
          : undefined;
      return {
        ok: false,
        message: refuseImage(result.reason, {
          ...(typeof type === "string" ? { type } : {}),
          ...(bytes !== undefined ? { bytes } : {}),
        }),
      };
    }
    images.push(result.image);
  }

  /*
   * The total, checked AFTER the individual ones so a single oversized image is still reported as itself.
   *
   * Summing the ENCODED lengths, because that is what the frame carries. The message names both the total and the limit:
   * "too much" without a number is the kind of refusal that leaves a reader guessing which image to drop.
   */
  const encoded = images.reduce((total, image) => total + image.data.length, 0);
  if (encoded > MAX_PROMPT_IMAGES_ENCODED_BYTES) {
    return {
      ok: false,
      message: `these images total ${(encoded / (1024 * 1024)).toFixed(1)} MB encoded, above the ${(
        MAX_PROMPT_IMAGES_ENCODED_BYTES /
        (1024 * 1024)
      ).toFixed(1)} MB limit for one prompt — remove one or downscale them`,
    };
  }

  return { ok: true, images };
}
