/**
 * The session's details behind a PEEK RAIL, for reading focus (issue #275, third slice).
 *
 * ## What the report said
 *
 * With reading focus on, the session header was still a 340px column beside the conversation — the one piece of chrome
 * the mode had not removed, holding exactly the width the mode existed to give back. And nothing named it: a block of
 * name, path, meter, provider, model and thinking, sitting beside text. Two complaints, one component: *"we see the
 * current transactions detail panel, when the conversation has the window. First, i dont know what this means. Maybe for
 * the reader mode, we can show the details when hovering a minimal version of the detail panel, and have an option to pin
 * it open manually"*.
 *
 * So it gets two states and a word:
 *
 *   - **resting**: a narrow tab on the conversation's trailing edge, carrying the state word and the context percentage
 *     — "idle · ctx 37%" is the answer to "i dont know what this means", and it is the one number that changes a
 *     decision. It costs about 28px.
 *   - **open**: hovering, focusing it, or pinning reveals the details over the trailing edge.
 *
 * ## Why an OVERLAY, and not a column that widens on hover
 *
 * A layout that reflows on hover is the failure `roster.ts` records for row order — *"a row that jumps while you aim at
 * it is the original complaint"*. Widening a track on pointerenter would move every line of prose under the cursor. An
 * overlay takes the panel out of flow, so hovering changes what is ON TOP of the conversation, never where the
 * conversation is.
 *
 * ## Why pinning is a real state, not "hover with the mouse parked"
 *
 * A reader comparing a model against a transcript, or watching context fill, needs the details there without holding
 * the pointer still. And a hover-only surface is unusable by keyboard and touch, so the tab is a `<button>` with
 * `aria-expanded`, it opens on focus, and Escape unpins.
 *
 * ## What it deliberately does not know
 *
 * A `LiveSession`. It takes the two facts its tab shows as strings, so the shell renders the same tab for a session it
 * is still loading and the component cannot disagree with the header about what state a session is in — that formatting
 * lives in `store.ts` and `format.ts`, and is used once by the caller.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The session's state as a colour family, from the words the rest of the app uses (`stateLabel`).
 *
 * Derived from the WORD rather than the session so this component keeps knowing only what its tab shows. An unknown word
 * is `idle`: a neutral dot is a safe wrong answer, while a loud one would claim a problem nobody reported.
 */
export function toneOf(stateWord: string): "ok" | "busy" | "attention" | "bad" | "idle" {
  switch (stateWord) {
    case "idle":
      return "ok";
    case "working":
    case "starting":
      return "busy";
    case "needs you":
      return "attention";
    case "failed":
      return "bad";
    case "stopped":
    case "registered":
      return "idle";
    default:
      return "idle";
  }
}

/**
 * `ctx 37%` or `ctx 85% full` → `37%` / `85%`: the number alone, because a 30px strip has no room for the sentence and the
 * sentence is the tooltip. `ctx —` stays `—` — an unreported measurement is not a zero.
 */
export function shortContext(label: string): string {
  return label.replace(/^ctx\s*/, "").replace(/\s*full$/, "");
}

export function SessionPeek({
  /** The session's state, in the words the rest of the app uses (`stateLabel`). */
  stateWord,
  /** `ctx 37%` — or `ctx —` when the session has not reported a measurement. */
  contextLabel,
  /** Is that measurement near the threshold? Drives the one colour change in the tab. */
  nearFull = false,
  /** Accessible name for the tab: what opening it reveals, in one phrase. */
  label,
  children,
  pinned,
  onPinned,
  onOpenChange,
}: {
  stateWord: string;
  contextLabel: string;
  nearFull?: boolean;
  label: string;
  /** The details themselves — the very same element the wide layout renders as a column. */
  children: React.ReactNode;
  pinned: boolean;
  onPinned: (pinned: boolean) => void;
  /**
   * Report whether the panel is showing, so the LAYOUT can answer.
   *
   * The panel is a grid item beside the prose now — the original companion — so opening it changes the row's track
   * widths rather than floating a box over the text. That width lives on the wrapper, which is the transcript's element,
   * so the one component that knows whether the pointer is here has to say so upward. A callback rather than lifting the
   * hover state: hover is this component's business, and a parent re-render must not reset it.
   */
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const [hovered, setHovered] = useState(false);
  const [focusedWithin, setFocusedWithin] = useState(false);

  const open = pinned || hovered || focusedWithin;

  /** Told once per change, in an effect: reporting during render would be a state write in another component's render. */
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  /**
   * A grace period on LEAVE, and none on ENTER.
   *
   * Moving diagonally across the corner dips out of the tab for a few pixels; without the delay the panel strobes.
   * Opening is immediate because a reader who moved the pointer here has already decided.
   */
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The scrolling box, so a focus that scrolled it sideways can be undone — see `onFocusCapture` below. */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const enter = useCallback(() => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
    setHovered(true);
  }, []);
  const leave = useCallback(() => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHovered(false), 220);
  }, []);
  useEffect(
    () => () => {
      if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
    },
    [],
  );

  /*
   * Escape closes the panel WHENEVER IT IS SHOWING — hovered, focused or latched.
   *
   * A window listener rather than a key handler on the panel: the reader may have tabbed into a picker inside it, and
   * expecting them to get back to the tab before they can dismiss is the same "aim before you can close" problem as a
   * hover-only surface. Capture phase and `stopPropagation`, because the composer's own Escape stops a run — one
   * keystroke must not do both.
   *
   * Guarded on `open` and NOT on `pinned`. The first version only claimed the key while latched, so a reader who
   * hovered the tab — the ordinary case — pressed Escape to dismiss the overlay and hit the composer's handler instead:
   * the overlay stayed and the run stopped. A dismissal key that performs an irreversible action in the other mode is
   * not a dismissal key.
   */
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      /*
       * All three states are cleared, not just the latch: leaving `hovered` set would make Escape look broken while the
       * pointer is parked on the tab, and nothing would re-arm it until the pointer left and came back.
       */
      setHovered(false);
      setFocusedWithin(false);
      if (pinned) onPinned(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, pinned, onPinned]);

  return (
    <div
      className={`session-peek${open ? " is-open" : ""}${pinned ? " is-pinned" : ""}`}
      onPointerEnter={enter}
      onPointerLeave={leave}
      /*
       * Containment, tracked with `relatedTarget`: without it, moving between two controls INSIDE the panel would read
       * as leaving and close the thing the reader is using.
       */
      onFocus={() => setFocusedWithin(true)}
      /*
       * A FOCUS THAT SCROLLED THE PANEL SIDEWAYS IS PUT BACK.
       *
       * `overflow-x: hidden` does not prevent horizontal scrolling — it prevents the BAR. Programmatic scrolling still
       * works, and the browser performs it: focusing an element wider than its scrollport scrolls the nearest scrollable
       * ancestor to reveal it. So tabbing to the Model `<select>` inside a panel whose content was 90px too wide moved the
       * box right and clipped the leftmost glyph of every line — reported as the panel "clipping its own content on the
       * left" while the right side had room to spare, which is the signature of `scrollLeft > 0` (issue #281).
       *
       * The CSS now makes the content fit, so this should never have anything to undo. It is here because the failure is
       * invisible to a reader — nothing looks broken, one side of the box is simply gone — and "the content fits" is a
       * promise made by rules that live in a different file from the focus that broke it.
       */
      onFocusCapture={() => {
        const panel = panelRef.current;
        if (panel !== null && panel.scrollLeft !== 0) panel.scrollLeft = 0;
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setFocusedWithin(false);
      }}
    >
      {/*
        THE TAB, and it is the whole resting state.

        It states the session's state and its context pressure rather than showing a generic mark, because that is the
        answer to "i dont know what this means" — the reader learns what the block holds without opening it. `aria-controls`
        names the panel and `aria-expanded` states the fact, so pressing it is explicable to assistive tech.
      */}
      <button
        type="button"
        className="session-peek-tab"
        aria-expanded={open}
        aria-controls="session-peek-panel"
        aria-label={`${label} — ${stateWord}, ${contextLabel}`}
        title={`${label} — ${stateWord}, ${contextLabel}\n${pinned ? "Click to unpin" : "Hover to peek, click to pin"}`}
        onClick={() => onPinned(!pinned)}
      >
        {/*
          A SMALL ICON, A DOT AND A NUMBER — all horizontal, because the first version was the words "Details · idle · ctx 37%"
          set in `vertical-rl` at 10px, and the reader's question was fair: *"why is the tab vertical with text I can't
          read"*. Rotated small text is the least legible thing a 30px strip can hold.

          What each part says, without words: the glyph is "settings and details" (the same sliders the model and thinking
          pickers are), the dot is the session's state in the colours the rest of the app already uses, and the number is
          the one figure that changes a decision. The sentence is the tooltip and the accessible name, so nothing depends on
          colour alone and the words are one hover away.
        */}
        <svg className="session-peek-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M2 4h6M12 4h2M2 8h2M8 8h6M2 12h7M13 12h1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="10" cy="4" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="6" cy="8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="11" cy="12" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        <span className={`session-peek-dot is-${toneOf(stateWord)}`} aria-hidden="true" title={stateWord} />
        <span className={`session-peek-ctx mono${nearFull ? " is-full" : ""}`} aria-hidden="true">
          {shortContext(contextLabel)}
        </span>
      </button>

      {/*
        THE PANEL.

        Always in the DOM so `aria-controls` never names nothing — the trap `PanelToggle` documents for the right panel —
        and `inert` while closed, so a panel nobody can see cannot be tabbed into. `inert` rather than `hidden`: the
        content must keep its layout so the overlay does not jump a frame when it opens.
      */}
      <div
        className="session-peek-panel"
        id="session-peek-panel"
        ref={panelRef}
        aria-hidden={!open}
        {...(open ? {} : { inert: true })}
      >
        {/*
          THE SAME FRAME CLASS AS THE WIDE LAYOUT'S COLUMN, and that is a correctness fix rather than a shortcut.

          Every rule that lays the details out inside their box — the picker grid's rows and gaps, the label column, the
          stats row, the control bar, and the narrow-form overrides — is scoped to `.transcript-header .…`. The first
          version wrapped the children in a differently named element, so all twenty-five of those selectors matched
          nothing: the content rendered as unstyled blocks, Provider and Model as bare text beside their selects, with no
          grouping and no widths. Reported from a screenshot as exactly that.

          Naming this box `.transcript-header` makes the two frames share ONE set of layout rules, so a fact added to the
          header cannot be laid out in the column and not here. The positioning differences (this is an overlay, that is a
          grid item) live in `.session-peek-panel`, which composes with it — two classes, two concerns, no duplication.
        */}
        <div className="transcript-header">{children}</div>
      </div>
    </div>
  );
}
