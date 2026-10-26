/**
 * Byte formatting, shared by both sides of the wire (issue #8).
 *
 * ## Why this is in `protocol` rather than duplicated
 *
 * Both the orchestrator and the UI must render a file size, and they must agree. The orchestrator
 * phrases a refusal — *"big.log is 4.2 MB, above the 256.0 KB limit"* — while the tree shows the same
 * file's size beside its name. Two implementations would let those two strings disagree, and this
 * project has already shipped that bug once: the inspector rendered `127.2M` while the metric strip
 * beside it rendered `12723914`, one value in two formats on one screen.
 *
 * It is not a wire TYPE, so it does not belong in `envelopes.ts` — but it is part of the shared
 * contract between the two processes, which is what `protocol` is for. `own-installation.ts` is here
 * for the same reason: a pure function both sides must implement identically.
 *
 * Binary units (1024), matching `formatTokens`, so a size in the tree and the size quoted in a
 * refusal cannot differ by a factor of 1000 either.
 *
 * The CAP itself is deliberately NOT here. `MAX_FILE_BYTES` lives in the orchestrator's `files.ts`,
 * next to the check that enforces it: the client must never decide what is readable, and a second
 * copy of the number would be a second thing to keep in step — the drift this module exists to
 * prevent. Adding one here that nothing used was a mistake, and it is recorded rather than quietly
 * deleted.
 */

/** A file size a reader can judge: `512 B`, `2.0 KB`, `5.0 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
