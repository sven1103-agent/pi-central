/**
 * The images a reader's own message NAMES by path, previewed in that message.
 *
 * ## The gap this closes, with numbers
 *
 * 181 of the 5 912 user messages in this machine's session store name an image file — `@img_6.png shows the latest
 * screenshot…`, `use the ui-reviewer subagent to see and review: @img_7.png`. Until now that rendered as literal text,
 * and the picture appeared only if the agent happened to `read` it later, inside a collapsed activity group. The
 * reference and the referent were in different places with a disclosure between them.
 *
 * ## Why this is a separate component from `TranscriptImage`
 *
 * A pasted image is CONTENT: it is part of what the reader sent, and `TranscriptImage` draws it at full turn size. This
 * is a REFERENCE: the message still says `@img_6.png`, and the preview is an annotation of that sentence — so it is
 * capped small (`--image-ref`, 12vh) and it EXPANDS. Drawing a referenced file at pasted-image size would let one `@`
 * mention of a 4000px screenshot push the next two turns off the screen, for an image the reader may already know.
 *
 * ## The three states, and why each is stated
 *
 *   loading   → a quiet line, because a spinner in the middle of prose is worse than a word
 *   refused   → the orchestrator's own reason, never a blank space. "No such file" and "not an image" and "too large"
 *               are different facts and the reader needs the one that applies.
 *   loaded    → the picture, expandable
 *
 * `unloaded` renders nothing at all. That is not an oversight: a turn whose file has not been requested yet is the
 * normal state for the first frame, and a placeholder that flips to an image a moment later is a layout shift in the
 * middle of the conversation — the thing `loading="lazy"` on pasted images exists to avoid.
 */
import { useEffect, useState } from "react";
import { formatBytes } from "../format.ts";
import { useBlobUrl } from "../images.ts";
import type { FileState } from "../files.ts";

export function ReferencePreview({
  path,
  state,
  /** Stable per (session, message, path): the blob-URL cache key. */
  identity,
}: {
  path: string;
  state: FileState;
  identity: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (state.status === "unloaded") return null;

  if (state.status === "loading") {
    return (
      <p className="turn-image-ref is-pending" role="status">
        Reading <span className="mono">{path}</span>…
      </p>
    );
  }

  if (state.status === "error") {
    /*
     * The orchestrator's reason, in its own words where one was given.
     *
     * `reason` is a closed set (ADR-0007), so each case is handled rather than printed generically — and the `code` is
     * shown because `ENOENT` and `EACCES` need different fixes, which is the same argument `FileErrorNote` makes.
     */
    return (
      <p className="turn-image-ref is-refused" role="note">
        <span className="mono">{path}</span> —{" "}
        {state.reason === "not-found"
          ? "this file is not in the session's directory."
          : state.reason === "binary"
            ? "this file is not an image this view can draw."
            : state.reason === "escapes-cwd" || state.reason === "absolute-path"
              ? "this path is outside the session's directory, so it was refused."
              : state.reason === "permission"
                ? "this file could not be read: permission denied."
                : /* `too-large` and `unreadable` carry the orchestrator's own sentence, which quotes the size or the OS
                     error. Re-phrasing them here would be a second copy of a number that must not disagree. */
                  state.message}
        {state.code !== undefined && <span className="turn-image-ref-code mono"> {state.code}</span>}
      </p>
    );
  }

  // Loaded, but text: the reader named something like `notes.png` that is not actually a picture. Said plainly rather
  // than dropped, because "I referenced a file and no preview appeared" is indistinguishable from a broken feature.
  if (state.content.kind === "text") {
    return (
      <p className="turn-image-ref is-refused" role="note">
        <span className="mono">{path}</span> — this file is text, not an image.
      </p>
    );
  }

  return (
    <ReferenceImage
      path={path}
      type={state.content.type}
      base64={state.content.base64}
      bytes={state.bytes}
      identity={identity}
      expanded={expanded}
      onToggle={() => setExpanded((was) => !was)}
    />
  );
}

/**
 * The picture itself, split out so the `useBlobUrl` hook is not called behind a conditional return.
 *
 * React's rules forbid a hook after an early return, and `ReferencePreview` has four of them. A child component is the
 * honest way to keep both: the parent decides whether there IS an image, and this one builds the URL for it.
 */
function ReferenceImage({
  path,
  type,
  base64,
  bytes,
  identity,
  expanded,
  onToggle,
}: {
  path: string;
  type: string;
  base64: string;
  bytes: number;
  identity: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const url = useBlobUrl(identity, type, broken ? "" : base64);

  // A new image (a different file behind the same key) resets the failure, so one bad file cannot poison the slot.
  useEffect(() => {
    setBroken(false);
  }, [base64, type]);

  if (broken || url === undefined) {
    return (
      <p className="turn-image-ref is-refused" role="note">
        <span className="mono">{path}</span> — the browser could not decode this {type} file.
      </p>
    );
  }

  return (
    <figure className={`turn-image-ref${expanded ? " is-expanded" : ""}`}>
      {/*
        A BUTTON, not a click handler on the image: this opens and closes, so it has to be reachable and operable from
        the keyboard, and it has to announce its state. `aria-expanded` is what makes it a disclosure rather than a
        mystery picture that sometimes grows.
      */}
      <button
        type="button"
        className="turn-image-ref-button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? `Collapse ${path}` : `Expand ${path}`}
      >
        <img
          className="turn-image-ref-img"
          src={url}
          alt={`Preview of ${path}`}
          onError={() => setBroken(true)}
          loading="lazy"
          decoding="async"
        />
      </button>
      <figcaption className="turn-image-ref-meta">
        <span className="mono">{path}</span> · {type} · {formatBytes(bytes)}
        <span className="turn-image-ref-hint">{expanded ? "click to collapse" : "click to enlarge"}</span>
      </figcaption>
    </figure>
  );
}
