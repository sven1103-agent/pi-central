/**
 * The control that shows or hides the right panel (issue #75).
 *
 * ## Why the label states the ACTION, not the state
 *
 * A button labelled by its state ("Panel open") is read as a status and then clicked twice by anyone
 * who takes it for one. This says what pressing it will do — the same rule the dotfile toggle
 * follows, and for the same reason.
 *
 * ## Why it is in the topbar, and why it is not inside `Panel`
 *
 * The panel is **collapsed by default** now, so a control inside it would be unreachable at exactly
 * the moment it is needed: a thing that disappears with the region it controls cannot bring it back.
 * `styles.css` recorded this as the answer when the panel stopped being hidden below 1440px — *"A
 * toggle is the right answer and needs a control in the topbar"* — so this is that control, placed
 * where the note said it should go.
 *
 * ## No `aria-controls`
 *
 * Deliberate. `aria-controls` would name the panel's id, and the panel is not rendered while
 * collapsed — so the attribute would point at nothing for the whole time it is most needed, which is
 * worse than omitting it. `aria-expanded` alone still tells assistive tech the current state and that
 * pressing changes it.
 */
export function PanelToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-quiet"
      aria-expanded={!collapsed}
      onClick={onToggle}
      title={
        collapsed
          ? "Show the session and file panel"
          : "Hide the session and file panel and give the transcript the room"
      }
    >
      {collapsed ? "Show panel" : "Hide panel"}
    </button>
  );
}
