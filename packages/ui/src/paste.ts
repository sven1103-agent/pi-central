/**
 * Getting an image out of a paste or a drop, and down to a size worth sending (issue: clipboard images).
 *
 * ## Why downscaling happens in the browser
 *
 * It is the only end that can. The orchestrator receives base64 and cannot re-encode without a decoder it does not have
 * and should not grow; Pi downscales too, but only for models whose catalogue declares an `inputLimits.images.resize`
 * profile, and by then the bytes have already crossed the socket and been stored in the session file. So a 6 MB retina
 * screenshot would either blow the transport's 8 MB frame limit or sit in the conversation permanently at full size,
 * for a model that will shrink it again anyway.
 *
 * ## The two limits, and why they are not the same number
 *
 *   - `MAX_ATTACHMENT_BYTES` (3 MB decoded) is the HARD limit, checked against the encoded result below. It matches the
 *     orchestrator's, and it exists so the reader is told before sending rather than after.
 *   - `TARGET_EDGE` (1568 px) is a QUALITY decision, not a limit. It is Pi's own default resize profile — the largest
 *     edge a vision model is given — so a screenshot is never shipped wider than the model can use. Downscaling to it is
 *     lossless in effect: the model would have seen 1568 px either way, and the difference is bytes not information.
 *
 * ## What this cannot do
 *
 * It cannot run outside a browser tab. `createImageBitmap`, `OffscreenCanvas` and `ClipboardEvent.clipboardData` do not
 * exist in this project's test environment, which is why every decision worth testing lives in `attachments.ts` and this
 * module is deliberately thin: read the item, draw it smaller, encode it. The arithmetic is elsewhere.
 */

/** The longest edge an attachment is downscaled to. Pi's own default resize profile, so nothing is lost that was used. */
export const TARGET_EDGE = 1568;

/** Re-encode quality for a downscaled JPEG. Above this the bytes stop shrinking; below it artefacts become visible. */
export const JPEG_QUALITY = 0.85;

/** What a paste or drop yielded, before it becomes an `Attachment`. */
export interface CapturedImage {
  mediaType: string;
  data: string;
  label: string;
}

/**
 * The image files in a `DataTransfer` (a drop, or a paste), oldest first.
 *
 * Filtered by media type HERE rather than later, because a paste can carry text alongside an image and a drop can carry a
 * folder. Passing everything on would make `attachments.ts` reject a `.txt` with a sentence about images, which is a
 * confusing answer to "I dropped a folder".
 */
export function imageFilesFrom(transfer: DataTransfer | null): File[] {
  if (transfer === null) return [];
  const files: File[] = [];
  // `files` is the drop path; `items` is the paste path, and some browsers populate only one of them.
  for (const file of Array.from(transfer.files ?? [])) {
    if (file.type.startsWith("image/")) files.push(file);
  }
  if (files.length > 0) return files;
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null && file.type.startsWith("image/")) files.push(file);
  }
  return files;
}

/**
 * Read one image file, downscale it to `TARGET_EDGE`, and return base64.
 *
 * The three browser APIs are used in the order that fails most gracefully: `createImageBitmap` (fast, off the main
 * thread where available) falls back to an `HTMLImageElement` + object URL for a browser that lacks it, and the canvas is
 * `OffscreenCanvas` when present so the raster does not touch the document.
 *
 * Returns `null` for a file the browser cannot decode — a corrupt image, or a format it pretends to support. `null` is
 * reported by the caller as "could not read that image", which is honest; a thrown error here would take the paste
 * handler down with it and the reader would see nothing at all.
 */
export async function captureImage(file: File, label?: string): Promise<CapturedImage | null> {
  try {
    const bitmap = await decode(file);
    if (bitmap === null) return null;

    const { width, height } = fit(bitmap.width, bitmap.height, TARGET_EDGE);
    // A PNG is re-encoded as PNG so transparency survives; everything else goes to JPEG, which is what a screenshot
    // should have been in the first place and is an order of magnitude smaller.
    const mediaType = file.type === "image/png" || file.type === "image/gif" ? "image/png" : "image/jpeg";
    const encoded = await draw(bitmap, width, height, mediaType);
    if (bitmap.close !== undefined) bitmap.close();

    return { mediaType, data: encoded, label: label ?? (file.name.length > 0 ? file.name : "pasted image") };
  } catch {
    return null;
  }
}

/** A decoded image, in the two shapes the two decoding paths produce. */
interface Decoded {
  width: number;
  height: number;
  close?: () => void;
  /** Only on the `HTMLImageElement` path. */
  element?: HTMLImageElement;
  /** Only on the `ImageBitmap` path. */
  bitmap?: ImageBitmap;
}

async function decode(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height, close: () => bitmap.close(), bitmap };
  }
  // The fallback: an object URL and an `<img>`. The URL is revoked on the next tick rather than immediately, because
  // some browsers have not finished reading it when `decode()` resolves.
  const url = URL.createObjectURL(file);
  try {
    const element = new Image();
    element.src = url;
    await element.decode();
    return { width: element.naturalWidth, height: element.naturalHeight, element };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * The dimensions to draw at, preserving aspect ratio.
 *
 * Only ever shrinks. Upscaling a small image to the target edge would add bytes and no information, and a 40px icon sent
 * as 1568px is the kind of "helpful" resizing that makes a chip's stated size look wrong.
 */
export function fit(width: number, height: number, edge: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const longest = Math.max(width, height);
  if (longest <= edge) return { width: Math.round(width), height: Math.round(height) };
  const scale = edge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Draw to a canvas of the given size and read it back as base64, without the `data:` prefix. */
async function draw(source: Decoded, width: number, height: number, mediaType: string): Promise<string> {
  if (width <= 0 || height <= 0) throw new Error("nothing to draw");

  const painter =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });

  const context = painter.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (context === null) throw new Error("no 2d context");

  // A transparent PNG flattened onto black would be a surprising result, so the background is left alone and only the
  // encoded TYPE decides what happens to alpha. JPEG has none, which is the honest reason a transparent screenshot
  // converted to JPEG comes out on black — stated here rather than discovered.
  context.drawImage(
    (source.bitmap ?? source.element) as CanvasImageSource,
    0,
    0,
    width,
    height,
  );

  const blob =
    painter instanceof OffscreenCanvas
      ? await painter.convertToBlob({ type: mediaType, quality: JPEG_QUALITY })
      : await new Promise<Blob | null>((resolve) =>
          (painter as HTMLCanvasElement).toBlob(resolve, mediaType, JPEG_QUALITY),
        );
  if (blob === null) throw new Error("encode failed");

  return (await blobToBase64(blob)).replace(/^data:[^;]+;base64,/, "");
}

/** A Blob's bytes as base64, via `FileReader` (which is present wherever the rest of this is). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("could not read the encoded image"));
    reader.readAsDataURL(blob);
  });
}
