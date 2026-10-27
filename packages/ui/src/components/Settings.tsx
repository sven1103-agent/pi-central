/**
 * Settings — facts about the running installation (issue #58).
 *
 * ## Why this exists at all
 *
 * Three of these facts were previously printed **only** to the terminal at startup:
 *
 *     sessions root: ~/.pi/agent/sessions
 *     default workspace: ~/.local/share/pi-central/workspaces
 *     agent root: …/agent (managed)
 *
 * A user who closed that terminal could not answer "where are my sessions on disk?" from the app.
 * The version was not reported anywhere at all, so "is this the build with the fix?" was unanswerable
 * from the running process — and that question becomes routine the moment there are releases.
 *
 * ## What is deliberately NOT here
 *
 * **No preference control.** The update-detection toggle belongs on this surface, but it does not
 * appear until it works (#55). A control that looks functional and is not is worse than its absence —
 * the same rule that made the refusal reasons in the file tree explicit rather than generic. What is
 * here instead is a sentence saying so, because "why can I not turn this on?" deserves an answer
 * rather than a missing box.
 *
 * ## A placeholder is not a value
 *
 * Every fact is allowed to be absent: `install` is `undefined` until a snapshot arrives, and stays
 * undefined against an orchestrator older than the field. Two consequences, and the first was a real
 * bug found by looking at a screenshot of this very surface:
 *
 *   1. **An absent fact is not copyable.** The first version passed `install?.sessionsRoot ??
 *      "not reported"` and rendered a copy button beside it, so the button put the literal string
 *      `not reported` on the clipboard. Offering to copy a placeholder is worse than offering
 *      nothing, so `Fact` takes `string | undefined` and derives the placeholder itself.
 *   2. **The reason is stated once, not six times.** Each row said "the orchestrator has not sent this
 *      yet", which is six repetitions of one fact and buries the actionable part.
 */
import { useEffect, useRef } from "react";
import { PROTOCOL_VERSION, type InstallFacts } from "@pi-central/protocol";
import { CopyButton } from "./CopyButton.tsx";

/**
 * A row of the `key: value` table.
 *
 * `value` is `string | undefined` rather than a pre-substituted string, deliberately: the placeholder
 * is derived HERE, so no call site can hand a placeholder to the copy button by forgetting to check.
 * That makes the bug above unrepresentable rather than merely fixed.
 */
function Fact({
  label,
  value,
  copyable = false,
  monospace = false,
  note,
}: {
  label: string;
  value: string | undefined;
  copyable?: boolean;
  monospace?: boolean;
  note?: string | undefined;
}) {
  const missing = value === undefined;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {/*
          The placeholder is NOT styled as a machine string. "not reported" is prose about an absence;
          rendering it in the mono face would make it look like a value that happens to read oddly.
        */}
        <span className={missing ? "settings-absent" : monospace ? "settings-mono" : undefined}>
          {missing ? "not reported" : value}
        </span>
        {copyable && !missing && <CopyButton text={value} label={label.toLowerCase()} />}
        {note !== undefined && <span className="settings-note">{note}</span>}
      </dd>
    </>
  );
}

export function Settings({
  install,
  ready,
  onClose,
}: {
  install: InstallFacts | undefined;
  /**
   * Whether a snapshot has arrived yet.
   *
   * The difference between "the orchestrator has not answered yet" and "this orchestrator does not
   * send these facts" — which are different problems with different fixes, and only the second means
   * something is out of date. Without it the surface would have to say "not reported" and leave the
   * reader to guess, which is how the version skew in issue #8 stayed confusing.
   */
  ready: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus moves INTO the surface, so the keyboard is not left on the page behind it — and `Esc` is
    // bound to the window rather than to the surface, because a user who has tabbed to a control
    // still expects Esc to close it.
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The orchestrator's protocol version, when it has told us. Compared against this UI's below — the
  // pair is the diagnostic for the exact failure that motivated this surface: a skew reported as
  // `unknown kind`, from a connection that had said `hello`.
  const orchestratorProtocol = install?.protocol;
  const skew = orchestratorProtocol !== undefined && orchestratorProtocol !== PROTOCOL_VERSION;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="settings-title">This installation</h3>

        {/*
          One explanation, stated once. `role="status"` rather than `alert`: it describes a state the
          user opened the surface to read, so announcing it assertively would be noise.

          When a snapshot HAS arrived and the facts are still absent, the cause is knowable — this
          orchestrator does not send the field — so the message names it and gives the fix. That is
          the same move as the version-skew message in `connection.ts`: turn a state that looks like a
          broken UI into one that says what to do.
        */}
        {install === undefined && (
          <p className="settings-absent-note" role="status">
            {ready ? (
              <>
                <strong>This orchestrator is older than this UI.</strong> It does not report the facts
                below, so nothing here can be shown. Restart it to pick up the current build — see{" "}
                <code>docs/DOGFOODING.md</code>.
              </>
            ) : (
              <>Waiting for the orchestrator to send these facts…</>
            )}
          </p>
        )}

        <section>
          <h4>This build</h4>
          <dl className="kv">
            <Fact label="Version" value={install?.version} />
            <Fact
              label="Protocol"
              value={orchestratorProtocol === undefined ? undefined : `v${orchestratorProtocol}`}
              note={
                orchestratorProtocol === undefined
                  ? undefined
                  : skew
                    ? `MISMATCH — this UI speaks v${PROTOCOL_VERSION}. One half is out of date; see docs/DOGFOODING.md.`
                    : `matches this UI (v${PROTOCOL_VERSION})`
              }
            />
          </dl>
        </section>

        <section>
          <h4>Where things live</h4>
          <dl className="kv">
            <Fact label="Sessions" value={install?.sessionsRoot} copyable monospace />
            <Fact label="Workspaces" value={install?.workspaceRoot} copyable monospace />
            <Fact
              label="Agent root"
              value={install?.agentRoot}
              copyable
              monospace
              note={
                install === undefined
                  ? undefined
                  : install.agentRootManaged
                    ? "managed by Pi Central"
                    : "external — not created or modified by Pi Central"
              }
            />
          </dl>
        </section>

        <section>
          <h4>Updates</h4>
          {/*
            A statement, not a control. Update checking is not built (#55), and a disabled checkbox
            would imply the feature exists and is merely switched off.
          */}
          <p className="settings-note settings-updates">
            This build does not check for updates. When it does, checking will be <strong>off unless you
            turn it on</strong>, will send nothing but the package name, and will never install anything
            without asking.
          </p>
        </section>

        <div className="dialog-actions">
          <button type="button" className="btn" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
