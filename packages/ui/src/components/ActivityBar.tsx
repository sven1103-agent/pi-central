/**
 * The two vertical activity bars (issue #239 follow-up: "what apps usually have").
 *
 * ## Why the navigation moved to the edges
 *
 * The topbar had become a single 44px strip holding nine things: the mark, the word mark, a "Sessions"
 * button, two view tabs, fleet counts, a connection dot, and two actions. Nothing in it said which of
 * those were *navigation*, which were *state*, and which were *actions* — they were one flex row
 * separated by a gap.
 *
 * The shape every desktop app converges on splits those by job, onto the edges:
 *
 *   - **left = the whole app.** Sessions, History, Settings. Reachable from anywhere.
 *   - **right = the open context.** Session details, Files, Trace — and only when a session is open.
 *
 * That is the same decomposition this UI already had, just lying on its side: the right-hand modes were
 * already three tabs inside the panel (`MODES` in `panel.ts`), and the left-hand three were three
 * unrelated controls. Promoting them to bars does not add a new information architecture, it makes the
 * existing one legible.
 *
 * ## Why one component, used twice, rather than two
 *
 * The two bars differ in *content*, not in *behaviour*: a column of 44px square controls with a label,
 * a tooltip, an accessible name and a selected state. Writing that twice is how the two drifts — one
 * gets `aria-expanded`, the other does not. `side` is the only difference that reaches the markup, and
 * it exists solely for the border.
 */

export type ActivityItem = {
  /**
   * The element id, used verbatim — a control in another region may name it (`aria-labelledby`), so it is
   * the caller's to choose and must not be rewritten here.
   */
  id: string;
  /** One or two words, shown in the tooltip. Never rendered as visible text: the bar is 48px wide. */
  label: string;
  /** The glyph. Text rather than SVG so the bar needs no asset pipeline and inherits `currentColor`. */
  glyph: string;
  onSelect: () => void;
  /** Selected/active state, for the bar's own affordance. */
  active?: boolean | undefined;
  /** Pressed state, for a toggle (the rail). `undefined` makes the button a plain action. */
  expanded?: boolean | undefined;
  /** Id of the region this control shows or hides, when there is one. */
  controls?: string | undefined;
};

/**
 * One bar.
 *
 * `role="tablist"` only for the context bar: those three items are alternative *views of the same
 * thing*, which is what a tablist means, and it is what the panel's `aria-labelledby` needs. The app
 * bar is a plain `nav` — Sessions and Settings are destinations, not alternative views of one document,
 * and announcing them as tabs would promise a tabpanel that does not exist.
 */
export function ActivityBar({
  side,
  label,
  items,
  header,
  children,
  as = "nav",
}: {
  side: "left" | "right";
  label: string;
  items: readonly ActivityItem[];
  /**
   * AT THE TOP of the bar, above the items and behind a rule.
   *
   * Reported from use: "make this a top icon on the right bar. Right bottom is out of reach." The footer slot
   * put a control at the end of a full-height column, so on a tall window the panel toggle sat far from the
   * modes it belongs to.
   *
   * It is separated by a rule because it is a different KIND of control from the items below: those select a
   * view, this shows or hides the region the views live in. Unseparated it reads as one more mode.
   */
  header?: React.ReactNode;
  /** Pinned to the end of the bar: the bottom is where a settings control belongs. */
  children?: React.ReactNode;
  as?: "nav" | "tablist";
}) {
  /*
   * `role="tablist"` goes on the GROUP of modes, not on the bar itself.
   *
   * The bar also holds a footer (the panel's show/hide toggle), and a tablist may contain only tabs — a
   * plain `<button>` inside one is invalid ARIA, and assistive tech is entitled to ignore it. The first
   * version put the role on the outer element, so the toggle was a non-tab child of a tablist.
   */
  const groupRole =
    as === "tablist"
      ? { role: "tablist" as const, "aria-label": label, "aria-orientation": "vertical" as const }
      : {};

  return (
    <div className={`navrail navrail-${side}`} data-side={side}>
      {header !== undefined && (
        <>
          <div className="navrail-group">{header}</div>
          {/* Separates a bar-level control from the view items: `aria-hidden` because it is a visual rule,
              and the grouping is already carried by the elements' own roles. */}
          <div className="navrail-rule" aria-hidden="true" />
        </>
      )}
      <div className="navrail-group" {...groupRole}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role={as === "tablist" ? "tab" : undefined}
            /*
              The caller's id, VERBATIM: the panel body names it from `aria-labelledby`, and prefixing it
              here (the first version emitted `activity-right-` + the id) made the reference dangle.
            */
            id={item.id}
            className="navrail-item"
            aria-selected={as === "tablist" ? item.active === true : undefined}
            aria-current={as === "nav" && item.active === true ? "page" : undefined}
            aria-expanded={item.expanded}
            aria-controls={item.controls}
            // Roving tabindex, matching the panel's mode tabs: only the selected item is in the tab
            // order, so Tab moves past the group instead of through every destination in it.
            tabIndex={as === "tablist" ? (item.active === true ? 0 : -1) : undefined}
            title={item.label}
            aria-label={item.label}
            onClick={item.onSelect}
          >
            <span className="navrail-glyph" aria-hidden="true">
              {item.glyph}
            </span>
          </button>
        ))}
      </div>
      {children !== undefined && <div className="navrail-group navrail-end">{children}</div>}
    </div>
  );
}
