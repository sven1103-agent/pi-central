/**
 * The open file's contents (issue #8).
 *
 * ## Inert, always
 *
 * The text is rendered as a **text node**, never as markup. It is untrusted for the same reason a
 * transcript is: it came off the filesystem, and a file in a working directory may have been written
 * by the agent, by a dependency, or by whoever sent the repository. ADR-0006's single
 * `dangerouslySetInnerHTML` site stays in `MessageBody`; a component test asserts this one escapes.
 *
 * ## The header is a slot, not a fixed strip
 *
 * It holds the path, a size, a copy-path button, the wrap toggle and a close button. Editing (a
 * documented amendment to ADR-0007, not built yet) would add Save/Revert here. It is laid out as a row
 * with the path flexible precisely so that can happen without the path being squeezed out.
 *
 * ## Why the copy-path button is here
 *
 * Pi's `@path` reference is argv-only and Pi **exits** if it is used in RPC mode — verified in Pi's
 * own `parseArgs` and `prepareInitialMessage`. So there is no `@` to delegate to. Copying the
 * relative path is the honest alternative: it needs no new wire kind and no Pi cooperation, and the
 * agent already has a `read` tool. This is the affordance that makes browsing useful.
 */
import { formatBytes } from "../format.ts";
import { fileAt } from "../files.ts";
import { CopyButton } from "./CopyButton.tsx";
import { FileErrorNote } from "./FileErrorNote.tsx";

export function FilePane({
  path,
  state,
  wrapped,
  onToggleWrap,
  onClose,
}: {
  path: string;
  state: ReturnType<typeof fileAt>;
  /** Whether long lines wrap. Defaults to wrapped — see `showsWrapped`. */
  wrapped: boolean;
  onToggleWrap: () => void;
  onClose: () => void;
}) {
  const lines = state.status === "loaded" ? state.text.split("\n") : [];

  return (
    <div className="filepane">
      <div className="filepane-head">
        <span className="filepane-path" title={path}>
          {path}
        </span>
        {state.status === "loaded" && (
          <span className="filepane-meta">
            {lines.length} line{lines.length === 1 ? "" : "s"} · {formatBytes(state.bytes)}
          </span>
        )}
        {/* The relative path, ready to paste into the prompt. Labelled so a screen reader hears
            which path is being copied, since the tree may hold several. */}
        <CopyButton text={path} label={`Copy path ${path}`} />
        {/*
          The wrap toggle (issue #73). Labelled by the ACTION, not the state: a control that reads
          "Wrapped" is taken for a status and clicked twice by anyone who believes it.

          It is in the header rather than a menu because it answers the one thing a reader of a wide
          document wants, and the header is where the document's own controls already live.
        */}
        {state.status === "loaded" && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={onToggleWrap}
            aria-pressed={wrapped}
            title={
              wrapped
                ? "Stop wrapping long lines, and scroll sideways instead"
                : "Wrap long lines so the whole line is readable without scrolling sideways"
            }
          >
            {wrapped ? "No wrap" : "Wrap lines"}
          </button>
        )}
        <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close file">
          Close
        </button>
      </div>

      {state.status === "unloaded" || state.status === "loading" ? (
        <p className="filetree-note" role="status">
          Reading…
        </p>
      ) : state.status === "error" ? (
        <FileErrorNote path={path} reason={state.reason} code={state.code} message={state.message} />
      ) : (
        <>
          {/*
            Line numbers and the text are separate elements, so a line number cannot be selected as
            part of the content and copying the code does not begin with its numbering.

            Wrapping is the reader's choice now (issue #73), and the default is ON. The earlier version
            forced `pre` on the grounds that "this is a code surface, and wrapping makes line numbers
            lie" — right about code, wrong about the common case. The panel hosts whatever is opened,
            and what is opened most often is prose, where there are no logical lines to preserve and
            the forced horizontal scrollbar sat hundreds of pixels below the line being read.

            A wrapped continuation keeps its number on the first visual line, which is what keeps the
            numbering useful rather than a lie.
          */}
          <ol className={wrapped ? "filepane-lines is-wrapped" : "filepane-lines"}>
            {lines.map((line, index) => (
              <li key={index}>
                <span className="filepane-line-no" aria-hidden="true">
                  {index + 1}
                </span>
                {/* A text node. React escapes it; there is no `dangerouslySetInnerHTML` near this. */}
                <span className="filepane-line-text">{line === "" ? "\u00a0" : line}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
