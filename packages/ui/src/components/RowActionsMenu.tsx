/**
 * A row's actions, behind a `⋯` button (asked for from use; DESIGN.md §712 already specified it).
 *
 * ## Why a menu rather than buttons in the row
 *
 * The row offered Resume, Forget and Delete as three inline buttons pinned to its bottom-right corner. In a 288px
 * column they overflowed: they overlapped the row's own text, spilled past the edge, and were partly unclickable —
 * reported as *"noboday can hit the right controls in the stopped session card ;) why not a menu icon (vertical
 * ellipsis) with a submenue for the actions?"*
 *
 * A menu is also the shape DESIGN.md had already chosen — *"rail rows reveal a `⋯` actions button"* — and it does not
 * grow with the number of actions, which is what broke when Stop became a fourth one.
 *
 * ## Why the items are always in the DOM and hidden with `display: none`
 *
 * Rather than mounting them on open. `display: none` removes a subtree from the tab order, so nothing unreachable is
 * focusable, and it means the rendered output states what a row OFFERS — which is what the tests assert. Mounting on
 * open would make every such assertion depend on simulating a click that SSR never runs.
 *
 * ## Keyboard
 *
 * `Escape` closes and returns focus to the trigger; a click outside closes. The trigger is `aria-haspopup="menu"` with
 * `aria-expanded`, so the state is announced rather than implied by a glyph.
 */
import { useEffect, useRef, useState } from "react";

export interface RowActionItem {
  /** Stable identity, used as the React key and by tests. */
  key: string;
  label: string;
  /** What the action does — or, for a destructive one, what it does not undo. */
  title: string;
  onSelect: () => void;
  /**
   * Present but not selectable — used to state WHY an action is missing, in the place the action would be.
   *
   * A row whose orchestrator cannot retry used to say so in a sentence under the row. In a menu the reason belongs
   * where the reader is looking for the action, and a disabled item says both "there is no Retry" and why, without
   * adding a line to every row.
   */
  disabled?: boolean;
  /** Extra classes, so an item can be asserted by what it is (`.rail-row-delete`) rather than by its text. */
  className?: string;
}

export function RowActionsMenu({ label, items }: { label: string; items: readonly RowActionItem[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Focus back to the trigger, or a keyboard user is left with nothing focused after the menu closes.
      triggerRef.current?.focus();
    };
    // `true` (capture) so the click that closes the menu is seen before the row's own handler opens the session.
    const onPointerDown = () => setOpen(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="rail-row-menu" data-open={open ? "true" : "false"}>
      <button
        ref={triggerRef}
        type="button"
        className="rail-row-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        /*
         * Named for the session, because "Actions" alone is useless in a list of ten — the same rule the History
         * checkboxes and the row's context meter follow.
         */
        aria-label={`Actions for ${label}`}
        title="Session actions"
        onClick={(event) => {
          // The row's own click focuses the session; opening the menu must not also do that.
          event.stopPropagation();
          setOpen((was) => !was);
        }}
      >
        {/* A glyph with an accessible name above, and `aria-hidden` so it is not announced twice. */}
        <span aria-hidden="true">⋯</span>
      </button>

      <div className="rail-row-menu-list" role="menu" aria-label={`Actions for ${label}`}>
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={`rail-row-menu-item${item.className === undefined ? "" : ` ${item.className}`}`}
            title={item.title}
            disabled={item.disabled === true}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
