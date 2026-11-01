/**
 * Blob URLs for the images in a transcript, held in ONE bounded cache (issue: images in the transcript).
 *
 * ## Why a module-level cache rather than `useMemo`/`useState` in the component
 *
 * `ImageViewer.tsx` creates its URL in an effect and revokes it on unmount, which is right for a pane that shows
 * exactly one image for as long as it is open. It is wrong for a transcript, for two reasons that only appear
 * once there are many of them:
 *
 *   1. **The transcript re-plans on every record.** `planEntries` allocates fresh entry objects, and
 *      `Transcript.tsx` re-plans whenever the transcript object changes — during a run, once per streaming delta.
 *      A URL created per mount would be revoked and rebuilt dozens of times a second for images that are not
 *      changing at all: a decode storm over a still conversation.
 *   2. **The transcript unmounts and remounts on every session switch** (`SessionView` carries `key={session.id}`),
 *      so a per-component cache would lose every URL each time the reader changes session and re-decode the whole
 *      conversation on the way back.
 *
 * Keyed by `imageKey(sessionId, messageId, contentIndex)` — see `transcript.ts` for why that pair and not the
 * base64 — a re-render or a re-plan finds the URL that already exists and does no work at all.
 *
 * ## Bounded, because "cache" without a bound is a leak with a nicer name
 *
 * A revoked URL does not free the base64 (that still lives in the transcript, which is where Pi's data lives and
 * where it must stay for the transcript to be reloadable). What a bound protects is the DECODED bitmaps behind
 * live URLs: 37 images at 1100×800 are ~130 MB of RGBA, which is the number that actually kills a tab.
 *
 * The limit is on COUNT rather than total pixels because a count is a fact we have without decoding. `LOAD_BUDGET`
 * is small on purpose: a transcript has one screenful of images at a time, so evicting the tail costs a re-decode
 * only when the reader scrolls far enough back to reach it — and eviction is invisible, because the image simply
 * re-materialises from bytes that never went anywhere.
 *
 * ## Not a hook, and no React in here
 *
 * This module is imported by a component and by tests directly, so it holds no state React owns. `useBlobUrl`
 * below is the only React-shaped thing, and it is deliberately thin: a subscription to a value that already exists.
 */
import { useEffect, useState } from "react";

/**
 * How many live blob URLs to keep.
 *
 * 24 is a judgement, and the reasoning is stated so it can be revised from evidence rather than taste. Pi's default
 * image resize profile caps at 1568×1568 (`docs/models.md`), so 24 *worst case* images is ~226 MB of RGBA — above
 * what a tab should hold. The realistic case is far smaller, because a screenshot is ~1100×800 (~3.5 MB decoded),
 * where 24 is ~85 MB. A transcript renders one screen at a time; anything beyond two dozen is history the reader has
 * scrolled past, and its bytes are still in the transcript so it can be rebuilt for free.
 */
export const MAX_LIVE_IMAGES = 24;

interface Entry {
  url: string;
  /** The type the Blob was built with, so a key reused with different bytes is detected rather than trusted. */
  type: string;
}

/**
 * Insertion-ordered, which is what makes it an LRU: `get` deletes and re-inserts, so the first key is always the
 * least recently used one. A `Map` is used rather than an array precisely because that re-insert is O(1) and the
 * eviction order falls out of `keys().next()`.
 */
const cache = new Map<string, Entry>();

/** Base64 → the bytes it encodes. `atob` is the browser's own decoder; no network, no `FileReader`. */
function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Revoke and forget every cached URL. Exported for tests, which must not leak between cases. */
export function clearImageCache(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
}

/** How many URLs are currently live. Exported so a test can assert the bound rather than infer it. */
export function liveImageCount(): number {
  return cache.size;
}

/**
 * The URL for one image, creating it on first use and REUSING it thereafter.
 *
 * Throws if the payload cannot be decoded (`atob` on malformed base64). That is deliberate: the caller knows whether
 * an image was displayable from `block.refused`, so a payload that passed that check and still fails is a real fault,
 * and swallowing it would leave a blank box with no explanation — the failure mode `ImageViewer` documents at length.
 */
export function blobUrlFor(key: string, type: string, base64: string): string {
  const existing = cache.get(key);
  if (existing !== undefined && existing.type === type) {
    // Re-insert so it moves to the newest position. Without this the cache would be FIFO and evict the image the
    // reader is currently looking at while it holds twenty they scrolled past an hour ago.
    cache.delete(key);
    cache.set(key, existing);
    return existing.url;
  }
  // A reused key with a different type means the key is not describing what we thought (a message renumbered, or a
  // sidecar-built transcript). Revoke the stale URL rather than leave two Blobs alive for one key.
  if (existing !== undefined) {
    URL.revokeObjectURL(existing.url);
    cache.delete(key);
  }

  const blob = new Blob([bytesOf(base64)], { type });
  const url = URL.createObjectURL(blob);
  cache.set(key, { url, type });

  while (cache.size > MAX_LIVE_IMAGES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    const evicted = cache.get(oldest.value);
    if (evicted !== undefined) URL.revokeObjectURL(evicted.url);
    cache.delete(oldest.value);
  }
  return url;
}

/**
 * The URL for one image, or `undefined` for one frame while it is built.
 *
 * `null` is not a possible result: an image that cannot be built throws at the point of building (see `blobUrlFor`),
 * because by the time this is called the block has already been ruled displayable. A caller that wants a stated
 * refusal handles `block.refused` BEFORE reaching here — which is why this hook takes plain values and not a block.
 *
 * The `useState` initialiser does the work on FIRST render rather than in an effect, so the common case (an image
 * already cached, or a fresh one) renders an `<img src>` immediately instead of a blank frame followed by a flip.
 * That flip is the bug `ImageViewer` shipped once: `<img src={undefined}>` fires `error`, which latched a permanent
 * "could not decode" over a perfectly good image.
 */
export function useBlobUrl(key: string, type: string, base64: string): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() => build(key, type, base64));

  useEffect(() => {
    const next = build(key, type, base64);
    setUrl(next);
  }, [key, type, base64]);

  return url;
}

/**
 * `blobUrlFor`, with a decode failure turned into `undefined` rather than a thrown render.
 *
 * The distinction matters at the boundary: `blobUrlFor` throws because a corrupt payload IS an error, and the caller
 * that wants to say so is the component. This wrapper exists so a render that throws does not take the whole pane down
 * with it — the transcript is the reading surface, and one bad screenshot must not blank the conversation.
 *
 * `undefined` therefore means "not this one", which the component reports in words. There is no silent empty box:
 * `images.ts` returning nothing and a component rendering nothing would be the same defect the image was added to fix.
 */
function build(key: string, type: string, base64: string): string | undefined {
  // An empty payload has no URL to give, and it must not take a slot: a transcript that recorded a broken image
  // would otherwise evict a real one to cache a Blob of nothing. The component states this case instead.
  if (base64.length === 0) return undefined;
  try {
    return blobUrlFor(key, type, base64);
  } catch {
    return undefined;
  }
}
