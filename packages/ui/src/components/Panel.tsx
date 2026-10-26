/**
 * The right panel: a region with modes, and a resizable edge.
 *
 * ## What changed, and why
 *
 * This was `Inspector` mounted directly into the shell — a fixed 320px column of session facts.
 * Issue #8 added a file tree and a document view to it, and a real window showed the result: the
 * document text was clipped mid-word with a horizontal scrollbar, and the file viewer sat at the
 * bottom of one long scroll region below `Command` and `Usage`. Three separate faults:
 *
 *   1. **The wrong region.** A file browser is not a session fact, and `Inspector` grew to hold both.
 *   2. **A fixed width.** 320px minus padding is not a readable measure for a document.
 *   3. **One scroll column.** A document that shares a scrollbar with session metadata is reachable
 *      only by scrolling past everything else.
 *
 * So the region now has **modes** (`Session` | `Files`) and a **draggable edge**. `Inspector` goes
 * back to being only session facts; the file browser gets the whole panel and its own scroll.
 *
 * ## The split of responsibility
 *
 * This component owns the REGION: the mode tabs, the resize handle, and which body is mounted. It
 * does not know what a session or a file is — it takes `children` for the body. That is deliberate:
 * the previous version's problem was one component accumulating concerns, and re-creating that here
 * would defeat the change.
 *
 * ## Why the resize arithmetic is not in here
 *
 * Drag and keyboard resizing is where the sign and clamp bugs live, and this repository's component
 * tests render to static HTML, so they execute no handlers. The arithmetic is in `panel.ts`, pure
 * and tested; this file only wires events to it.
 */
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  panelMaxWidth,
  resizePanelTo,
  type PanelMode,
} from "../panel.ts";

/** The modes, in tab order. Named here so the tab list and the body cannot disagree. */
const MODES: { mode: PanelMode; label: string }[] = [
  { mode: "session", label: "Session" },
  { mode: "files", label: "Files" },
];

export function Panel({
  mode,
  onMode,
  width,
  onWidth,
  viewportWidth,
  /** False when the panel is a sheet rather than a column, so there is no edge to drag. */
  resizable = true,
  /** Called once a drag or key gesture ends, so the width can be persisted rather than on every frame. */
  onCommit,
  children,
}: {
  mode: PanelMode;
  onMode: (mode: PanelMode) => void;
  width: number;
  onWidth: (width: number, userSized: boolean) => void;
  viewportWidth: number;
  resizable?: boolean;
  onCommit?: () => void;
  children: ReactNode;
}) {
  // Drag state in a ref, not state: a re-render per pointermove is what makes a drag feel sticky, and
  // nothing rendered depends on the intermediate values.
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | undefined>(undefined);

  const max = panelMaxWidth(viewportWidth);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizable) return;
    // Stops the drag from selecting the document text underneath, which otherwise leaves the whole
    // panel highlighted blue the moment you grab the edge.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // `startWidth - delta`, not `width - delta`: accumulating against the live width compounds
    // rounding and drifts away from the pointer.
    onWidth(clampPanelWidth(state.startWidth - (event.clientX - state.startX), viewportWidth), true);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit?.();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!resizable) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    // Prevented so the arrow keys do not also scroll the panel body, which would make the gesture
    // move two things at once.
    event.preventDefault();
    onWidth(resizePanelTo(event.key as "ArrowLeft", width, viewportWidth), true);
    onCommit?.();
  }

  return (
    <aside className="panel" aria-label="Panel">
      <div className="panel-head">
        <div className="tabs" role="tablist" aria-label="Panel view">
          {MODES.map(({ mode: value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`panel-tab-${value}`}
              className="tab"
              aria-selected={mode === value}
              aria-controls={`panel-body-${value}`}
              // Roving tabindex: only the selected tab is in the tab order, so Tab moves past the
              // group rather than through both tabs.
              tabIndex={mode === value ? 0 : -1}
              onClick={() => onMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/*
        `key` on the body would remount it and lose scroll position when switching modes, which for a
        document view means jumping back to line 1. Both bodies are therefore rendered from the same
        element with a stable id, and only the content changes.
      */}
      <div
        className="panel-body"
        id={`panel-body-${mode}`}
        role="tabpanel"
        aria-labelledby={`panel-tab-${mode}`}
        tabIndex={-1}
      >
        {children}
      </div>

      {resizable && (
        /*
          A 1px visual edge with a wider invisible hit area: the gutter between panes is a 1px line of
          `--line`, and a 1px target is not grabbable. The element is a child of the panel and sits
          over the gutter, so the shell's grid stays three columns.
        */
        <div
          className="panel-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          aria-valuenow={width}
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuemax={max}
          // Spoken rather than read as a bare number: "512" alone gives no unit.
          aria-valuetext={`${width} pixels`}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={handleKeyDown}
          onDoubleClick={() => {
            // Reset is the only way back to the default without guessing the number. `userSized`
            // goes false so the Files auto-widen may apply again.
            onWidth(PANEL_DEFAULT_WIDTH, false);
            onCommit?.();
          }}
        />
      )}
    </aside>
  );
}
