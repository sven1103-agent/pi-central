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
}: {
  stateWord: string;
  contextLabel: string;
  nearFull?: boolean;
  label: string;
  /** The details themselves — the very same element the wide layout renders as a column. */
  children: React.ReactNode;
  pinned: boolean;
  onPinned: (pinned: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focusedWithin, setFocusedWithin] = useState(false);

  const open = pinned || hovered || focusedWithin;

  /**
   * A grace period on LEAVE, and none on ENTER.
   *
   * Moving diagonally across the corner dips out of the tab for a few pixels; without the delay the panel strobes.
   * Opening is immediate because a reader who moved the pointer here has already decided.
   */
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
   * Escape unpins, while the panel is showing.
   *
   * A window listener rather than a key handler on the panel: the reader may have tabbed into a picker inside it, and
   * expecting them to get back to the tab before they can dismiss is the same "aim before you can close" problem as a
   * hover-only surface. Capture phase and `stopPropagation`, because the composer's own Escape stops a run — one
   * keystroke must not do both.
   */
  useEffect(() => {
    if (!pinned) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onPinned(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [pinned, onPinned]);

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
        title={`${label} · hover to peek, click to pin`}
        onClick={() => onPinned(!pinned)}
      >
        <span className="session-peek-word" aria-hidden="true">
          {pinned ? "Pinned" : "Details"}
        </span>
        <span className="session-peek-state" aria-hidden="true">
          {stateWord}
        </span>
        <span className={`session-peek-ctx mono${nearFull ? " is-full" : ""}`} aria-hidden="true">
          {contextLabel}
        </span>
      </button>

      {/*
        THE PANEL.

        Always in the DOM so `aria-controls` never names nothing — the trap `PanelToggle` documents for the right panel —
        and `inert` while closed, so a panel nobody can see cannot be tabbed into. `inert` rather than `hidden`: the
        content must keep its layout so the overlay does not jump a frame when it opens.
      */}
      <div className="session-peek-panel" id="session-peek-panel" aria-hidden={!open} {...(open ? {} : { inert: true })}>
        {children}
      </div>
    </div>
  );
}
