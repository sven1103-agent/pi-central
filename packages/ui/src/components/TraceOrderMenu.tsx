/**
 * The order control: a SORT glyph that opens a small menu.
 *
 * ## Why a menu and not a `<select>`
 *
 * A native select was the first answer, and it works — but it reads as a FORM FIELD in a strip of chrome, and at
 * `--fs-2xs` its platform-drawn arrow is the heaviest mark in the header. The control is not filling in a value, it is
 * choosing an ORDER; a sort glyph says that, and the menu says the rest.
 *
 * ## Why a sort glyph and not a filter funnel
 *
 * A funnel means FILTER: narrow the set down. This control reorders the same set and hides nothing, so a funnel promised
 * something the menu does not do. The glyph is now three bars of decreasing length with an arrow — the ordinary "sort"
 * mark — and the filled/inactive distinction is carried by the ARROW rather than by the body of the shape.
 *
 * ## Why it is built rather than imported
 *
 * The repository has no component library and no icon set — every affordance so far has been words or CSS. One small
 * SVG plus an ARIA menu is less machinery than a dependency, and it lets the keyboard behaviour be exactly right:
 *
 *   - `aria-haspopup="menu"` + `aria-expanded` on the trigger, so the state is announced;
 *   - `role="menu"` / `role="menuitemradio"`, because the items are a set of mutually exclusive choices;
 *   - Escape closes and returns focus to the trigger, because a surface opened from the keyboard must be closable from
 *     it — the rule `Settings` follows;
 *   - a click outside closes it, and the outside listener is registered on the CAPTURE phase so it also catches a click
 *     on a row underneath rather than letting the menu linger over a changed selection.
 *
 * The menu is not a `popover` element or a portal: it is positioned against the trigger, and the trace panel is a plain
 * column with no transformed ancestor, so `position: absolute` resolves where it is written.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { TraceOrder } from "../trace.ts";

const CHOICES: { value: TraceOrder; label: string; hint: string }[] = [
  { value: "oldest", label: "Oldest first", hint: "the order the calls happened in" },
  { value: "newest", label: "Newest first", hint: "most recent at the top" },
];

export function TraceOrderMenu({
  order,
  onOrder,
}: {
  order: TraceOrder;
  onOrder: (order: TraceOrder) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  /** Close, and put focus back where it came from. */
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  // Escape and outside clicks. Both are on the capture phase so a click on a row underneath does not select it first.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (menuRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
        return;
      }
      // Roving focus: the items are a short list, so arrows move between them without a tab stop each.
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = current === -1 ? (step === 1 ? 0 : items.length - 1) : (current + step + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  // Focus the selected item when the menu opens, so the keyboard lands on the current choice.
  useEffect(() => {
    if (!open) return;
    const selected = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    selected?.focus();
  }, [open]);

  return (
    <div className="trace-order">
      <button
        ref={triggerRef}
        type="button"
        className="trace-order-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        /*
          The state is in the label for assistive tech AND in the icon's shape: the glyph is drawn filled when an order
          other than the default is active, so "this list is filtered" is visible without opening the menu or reading a
          tooltip.
        */
        aria-label={`Order: ${CHOICES.find((c) => c.value === order)?.label ?? "Oldest first"}`}
        title={`Order: ${CHOICES.find((c) => c.value === order)?.label ?? "Oldest first"}`}
        data-active={order !== "oldest" ? "true" : undefined}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          // Enter/Space open by default for a button; ArrowDown is the menu idiom.
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          {/*
            A SORT mark: three bars of decreasing length, with a direction arrow.
            
            The bars carry the idea (a list being ordered) and the arrow carries the STATE — it points down for oldest
            first and up for newest first. So the current order is legible without opening the menu, and it is a shape,
            not a colour, so `forced-colors` cannot remove it.
          */}
          <path
            d="M2 3.5h7M2 8h5M2 12.5h3"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            fill="none"
          />
          <path
            d={order === "oldest" ? "M12.5 2.5v11m0 0-2.2-2.2m2.2 2.2 2.2-2.2" : "M12.5 13.5v-11m0 0-2.2 2.2m2.2-2.2 2.2 2.2"}
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
            fill="none"
          />
        </svg>
      </button>

      {open && (
        <div ref={menuRef} id={menuId} className="trace-order-menu" role="menu" aria-label="Order the calls">
          {CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="menuitemradio"
              aria-checked={order === choice.value}
              className="trace-order-item"
              onClick={() => {
                onOrder(choice.value);
                close(true);
              }}
            >
              {/* A tick for the current choice: `aria-checked` carries it to assistive tech, and the glyph to the eye. */}
              <span className="trace-order-tick" aria-hidden="true">
                {order === choice.value ? "✓" : ""}
              </span>
              <span className="trace-order-item-label">{choice.label}</span>
              <span className="trace-order-item-hint">{choice.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
