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
 * It currently holds the path, a size, a copy-path button and a close button. Editing (a documented
 * amendment to ADR-0007, not built yet) would add Save/Revert here. It is laid out as a row with the
 * path flexible precisely so that can happen without the path being squeezed out.
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
  onClose,
}: {
  path: string;
  state: ReturnType<typeof fileAt>;
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
        /*
          Line numbers and the text are separate elements, so a line number cannot be selected as part
          of the content and copying the code does not begin with its numbering.

          Long lines are NOT wrapped: this is a code surface, and wrapping turns one logical line into
          three visual ones, which makes line numbers lie. The panel is resizable so the reader can
          make room instead — which is the whole point of the resize work.
        */
        <ol className="filepane-lines">
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
      )}
    </div>
  );
}
