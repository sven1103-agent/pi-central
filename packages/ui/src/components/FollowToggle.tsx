/**
 * Whether the transcript scrolls itself to new output (issue #86).
 *
 * The reader asked for this control in the issue, and the reason is a genuine disagreement about what
 * a transcript is for:
 *
 * > *"User wants to automatically follow the transcript. User is investigating and reading outputs in
 * > their own pace, enforcing auto-follow would not enable them to do so."*
 *
 * The existing model — follow while at the bottom, stop when you scroll away, resume when you return —
 * already serves both, but it makes the reader **prove** their intent over and over: every glance at
 * something further up silently turns following off, and it stays off until they scroll back down.
 * Someone who reads at their own pace therefore cannot leave the pane at all.
 *
 * So the toggle is not a second mechanism; it is a way to say *once* what the scroll position says
 * every time. Off means the transcript never moves on its own, and the explicit *Jump to latest* is
 * still there for when they want it — which is the difference between "do not move me" and "do not
 * let me move".
 *
 * The label states the state with `aria-pressed` carrying it to assistive tech — and it now carries a SWITCH, because
 * a pill whose only difference between states is a word is a label wearing a button's clothes. A reviewer put it
 * plainly: `auto-follow off` "reads equally as a state and as a command".
 *
 * The switch is the affordance and the dot is its position; the words stay, because colour and position are never the
 * only carrier of meaning in this project.
 */
export function FollowToggle({ following, onToggle }: { following: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="follow-toggle"
      aria-pressed={following}
      onClick={onToggle}
      title={
        following
          ? "Stop scrolling to new output automatically. Jump to latest still works."
          : "Scroll to new output automatically whenever you are at the end of the transcript."
      }
    >
      <span className="follow-toggle-track" aria-hidden="true">
        <span className="follow-toggle-dot" />
      </span>
      {/* The state is in the WORD as well as the track, so a monochrome or `forced-colors` rendering still reads. */}
      <span className="follow-toggle-label">{following ? "auto-follow on" : "auto-follow off"}</span>
    </button>
  );
}
