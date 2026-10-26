/**
 * `Files` mode: the tree, and the open document (issue #8).
 *
 * ## The layout problem this solves
 *
 * The first attempt put the tree and the document at the bottom of the inspector's single scroll
 * column. In a real window that meant the document was clipped horizontally (a 320px panel is not a
 * readable measure), and reachable only by scrolling past `Command` and `Usage`. Three rules here:
 *
 *   1. **The document gets its own scroll.** It is a flex sibling that fills the remaining height, not
 *      a block with a `max-height` inside a scrolling parent. The previous version had both, so two
 *      scrollbars competed — a defect I introduced and the screenshots showed.
 *   2. **The tree and the document do not share a line budget.** They are separate grid areas, so a
 *      long document cannot push the tree out of view.
 *   3. **Long lines are not wrapped.** Wrapping makes line numbers lie, and the panel is now
 *      resizable, so making room is the reader's call rather than the layout's.
 *
 * ## Narrow vs. wide, and why the switch is in CSS
 *
 * Below `FILES_SPLIT_MIN_WIDTH` there is not enough room for both panes — a 280px split gives neither
 * one a usable width — so the document takes the whole panel and a `‹ Files` row goes back. Above it,
 * both are shown side by side.
 *
 * The switch is a **container query** in `styles.css`, keyed on the panel's own width rather than the
 * viewport's, because the panel is resizable: the window can be 2560px while the panel is 300px, and
 * a viewport media query would get that exactly backwards. The breakpoint constant is duplicated in
 * `panel.ts` and asserted equal by a test, since CSS cannot import TypeScript.
 */
import { openFileFor, type FilesState } from "../files.ts";
import { FilePane } from "./FilePane.tsx";
import { FileTree } from "./FileTree.tsx";

export function FilesPanel({
  sessionId,
  files,
  cwd,
  onExpand,
  onCollapse,
  onToggleHidden,
  onOpenFile,
  onCloseFile,
}: {
  sessionId: string;
  files: FilesState;
  cwd: string;
  onExpand: (path: string) => void;
  onCollapse: (path: string) => void;
  onToggleHidden: () => void;
  onOpenFile: (path: string) => void;
  onCloseFile: () => void;
}) {
  // Resolved once, so the header and the body are produced by the same lookup and cannot name one
  // file while showing another.
  const open = openFileFor(files, sessionId);

  return (
    <div className="files-panel">
      {open && (
        /*
          Only visible when the panel is too narrow for both panes — hidden by the container query
          when there is room. It is rendered always rather than conditionally, so the query has
          something to hide and the markup does not depend on a width JavaScript would have to
          measure.
        */
        <div className="files-back">
          <button type="button" className="btn btn-quiet" onClick={onCloseFile}>
            ‹ Files
          </button>
          <span className="files-back-path" title={open.path}>
            {open.path}
          </span>
        </div>
      )}

      <div className={`files-body${open ? " has-file" : ""}`}>
        <div className="files-tree">
          <FileTree
            sessionId={sessionId}
            state={files}
            cwd={cwd}
            onExpand={onExpand}
            onCollapse={onCollapse}
            onToggleHidden={onToggleHidden}
            onOpenFile={onOpenFile}
          />
        </div>
        {open && (
          <div className="files-doc">
            <FilePane path={open.path} state={open.state} onClose={onCloseFile} />
          </div>
        )}
      </div>
    </div>
  );
}
