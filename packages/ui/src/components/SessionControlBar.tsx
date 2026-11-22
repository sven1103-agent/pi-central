/**
 * The session control bar: icon buttons, with the word available on hover and to assistive tech.
 *
 * ## The history, because it explains the shape
 *
 *   1. inline buttons on the rail row — unclickable in a 288px column;
 *   2. a `⋯` menu in the same corner — *"very tiny"*;
 *   3. the side panel — invisible, because that panel is collapsed by default;
 *   4. a labelled button bar under the model pickers — worked, but *"the words are too long"*;
 *   5. glyph + word — *"not sure if it is an improvement"*, and mine also wrapped and drew `⌫` as a tofu box.
 *
 * Asked for: *"maybe the words are too long. Can we try icons only? For delete we can use a trash bin (and maybe in
 * red). resume in green."*
 *
 * ## Why INLINE SVG and not a character
 *
 * The previous attempt used Unicode marks, and `⌫` (U+232B) rendered as an empty box on macOS because the platform
 * fallback does not carry the Technical block. An inline path cannot fail that way: there is no font to miss it. It is
 * also the pattern already in the codebase (`TraceOrderMenu`), so this is not a new technique.
 *
 * ## What keeps icon-only safe here
 *
 * The objection in `DESIGN.md` §681 — *"an icon makes it undiscoverable to anyone who reads words"* — is real, and two
 * things answer it:
 *
 *   - **`aria-label` carries the full label**, so a screen reader announces "Resume session", never "play".
 *   - **`title` gives the same words on hover**, so a reader who does not recognise a shape waits half a second rather
 *     than acting on a guess. The destructive one also states its consequence there.
 *
 * Colour is used as reinforcement, not as the carrier: green for the action that continues work, red for the one that
 * removes a file. Both are the app's existing tokens (`--ok`, `--danger-text`) rather than new hues, so the bar belongs
 * to the theme — and both marks are also distinct in SHAPE (a play triangle, a bin), so nothing depends on colour
 * vision.
 */
import type { LiveSession } from "@pi-central/protocol";
import { sessionControlsFor } from "./Inspector.tsx";

/** What the shell can offer. Absent callbacks mean the action is not rendered — never a button that would fail. */
export interface SessionControlCaps {
  onStop?: (() => void) | undefined;
  onResume?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  retryAvailable?: boolean | undefined;
  onForget?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  /**
   * Compact this session's context (issue #263).
   *
   * Absent when the connected orchestrator speaks an older protocol. The near-full test is NOT here: it lives in
   * `sessionControlsFor`, so the rail, this bar and the composer's command list cannot disagree about when the
   * affordance exists.
   */
  onCompact?: (() => void) | undefined;
  /**
   * Open the reload confirmation (issue #274).
   *
   * Absent when the connected orchestrator speaks an older protocol, and the SHELL withholds it further for a
   * session with no process — the same division as `onCompact`, so the bar, the panel and the composer cannot
   * disagree about when a reload is offered.
   */
  onReload?: (() => void) | undefined;
}

/**
 * The icon for a control, as an inline path.
 *
 * 16×16, stroked with `currentColor` so the theme drives it and `forced-colors` still draws the shape. Each is a
 * recognisable silhouette rather than a symbol: a play triangle, a bin, a square, a circular arrow.
 */
function ControlIcon({ control }: { control: string }) {
  const common = {
    viewBox: "0 0 16 16",
    width: 16,
    height: 16,
    // Decoration: the button carries the label, so an announced path would add "graphic" before every action.
    "aria-hidden": true,
    focusable: "false" as const,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (control) {
    case "resume":
      // A filled play triangle: the one shape that means "continue" without a legend.
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <path d="M5 3.5v9l7-4.5z" />
        </svg>
      );
    case "retry":
      // A circular arrow, the same idea the retry notice already uses.
      return (
        <svg {...common}>
          <path d="M3 8a5 5 0 1 1 1.6 3.7" />
          <path d="M3 4.5V8h3.5" />
        </svg>
      );
    case "stop":
      // A filled square: the transport-control convention for "stop".
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <rect x="4" y="4" width="8" height="8" rx="1" />
        </svg>
      );
    case "delete":
      // A trash bin: lid, body, and two slats. Asked for by name.
      return (
        <svg {...common}>
          <path d="M3 4.5h10" />
          <path d="M6.5 4.5V3h3v1.5" />
          <path d="M4.5 4.5 5 13h6l.5-8.5" />
          <path d="M7 7v3.5M9 7v3.5" />
        </svg>
      );
    case "compact":
      /*
       * Two arrows pressing toward a centre line: context being made smaller. A silhouette rather than a glyph, for
       * the same reason every other icon here is inline — `⌫` once rendered as an empty box on macOS.
       */
      return (
        <svg {...common}>
          <path d="M8 2.5v4M5.5 4.5 8 7l2.5-2.5" />
          <path d="M8 13.5v-4M5.5 11.5 8 9l2.5 2.5" />
        </svg>
      );
    case "reload":
      /*
       * A circular arrow, drawn as an open arc with an arrowhead rather than the closed ring Unicode uses for
       * "refresh" (U+27F3), which renders as tofu in some fallbacks — the defect that made `⌫` an empty box.
       *
       * The gap in the stroke is what makes it read as a rotation rather than as a circle: an unbroken ring at 16px
       * is a dot with a hole in it.
       */
      return (
        <svg {...common}>
          <path d="M13 8a5 5 0 1 1-1.9-3.9" />
          <path d="M13.5 2.5v3h-3" />
        </svg>
      );
    case "reload-unavailable":
      // Reachable only if the shell offers the control it has gated off; drawn as the generic dot rather than
      // inventing a second mark for a state that should not occur.
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" />
        </svg>
      );
    case "forget":
      /*
       * A list with a minus, NOT an eye with a slash.
       *
       * The eye-slash means "visibility off" in essentially every icon system — password reveal, layer visibility,
       * tracking prevention — so a reader guessed "hide" by luck and could guess something else entirely. What Forget
       * actually does is "take this session off the rail and keep the file", and a list with a line removed says that
       * and nothing else.
       *
       * Three rules and a minus, so it stays legible at 16px: at this size a 16px glyph is about 40 device pixels on a
       * retina display but only 16 logical ones, and detail finer than that turns to mush.
       */
      return (
        <svg {...common}>
          <path d="M2.5 4h11M2.5 8h6M2.5 12h11" />
          <path d="M11 8h3.5" strokeWidth="2" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" />
        </svg>
      );
  }
}

export function SessionControlBar({
  session,
  onStop,
  onResume,
  onRetry,
  retryAvailable = true,
  onForget,
  onDelete,
  onCompact,
  onReload,
}: { session: LiveSession } & SessionControlCaps) {
  /*
   * Built from `sessionControlsFor`, so WHICH actions exist is decided in one place and stays a tested pure function.
   * This component only draws them.
   */
  const controls = sessionControlsFor(session, {
    ...(onStop === undefined ? {} : { onStop }),
    ...(onResume === undefined ? {} : { onResume }),
    ...(onRetry === undefined ? {} : { onRetry }),
    retryAvailable,
    ...(onForget === undefined ? {} : { onForget }),
    ...(onDelete === undefined ? {} : { onDelete }),
    ...(onCompact === undefined ? {} : { onCompact }),
    ...(onReload === undefined ? {} : { onReload }),
  });

  if (controls.length === 0) return null;

  return (
    <div className="session-controls" role="group" aria-label="Session actions">
      {controls.map((control) => (
        <button
          key={control.key}
          type="button"
          /*
           * NO `btn` class. `.btn` is defined after these rules in the stylesheet and sets a border, a background and a
           * radius — so it silently won the cascade and the "no chrome" version still drew as bordered buttons. Reported
           * from a screenshot. These are the only buttons in the app that are icon-only, so they get their own class and
           * no shared one.
           */
          className={`session-control session-control-${control.key}${
            control.danger === true ? " session-control-danger" : ""
          }`}
          /*
           * The full label as the accessible name — the icon is decoration. `title` gives the same words on hover, and
           * for the destructive one it also states the consequence, which is the fact a reader needs before pressing.
           */
          aria-label={control.label}
          title={`${control.label} — ${control.title}`}
          disabled={control.disabled === true}
          onClick={control.onSelect}
        >
          <ControlIcon control={control.key} />
        </button>
      ))}
    </div>
  );
}
