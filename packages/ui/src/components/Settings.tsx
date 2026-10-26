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
 * ## Every fact is allowed to be absent
 *
 * `install` is `undefined` until a snapshot arrives, and stays undefined against an orchestrator
 * older than the field. That renders as **"not reported"**, never as an empty string or a zero: the
 * UI must not claim a version it does not have, and a blank where a path belongs reads as a bug in
 * the surface rather than as a fact that was never sent.
 */
import { useEffect, useRef } from "react";
import { PROTOCOL_VERSION, type InstallFacts } from "@pi-central/protocol";
import { CopyButton } from "./CopyButton.tsx";

/** A row of the `key: value` table, with a copy button when the value is worth copying. */
function Fact({
  label,
  value,
  copyable = false,
  monospace = false,
  note,
}: {
  label: string;
  value: string;
  copyable?: boolean;
  monospace?: boolean;
  note?: string | undefined;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <span className={monospace ? "settings-mono" : undefined}>{value}</span>
        {copyable && <CopyButton text={value} label={label} />}
        {note !== undefined && <span className="settings-note">{note}</span>}
      </dd>
    </>
  );
}

export function Settings({ install, onClose }: { install: InstallFacts | undefined; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus moves INTO the surface, so the keyboard is not left on the page behind it — and `Esc`
    // is bound to the window rather than to the surface, because a user who has tabbed to a control
    // still expects Esc to close it.
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The orchestrator's protocol version, when it has told us. Compared against this UI's below —
  // the pair is the diagnostic for the exact failure that motivated this surface: a skew reported as
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

        <section>
          <h4>This build</h4>
          <dl className="kv">
            <Fact
              label="Version"
              value={install?.version ?? "not reported"}
              note={install === undefined ? "the orchestrator has not sent this yet" : undefined}
            />
            <Fact
              label="Protocol"
              value={orchestratorProtocol === undefined ? "not reported" : `v${orchestratorProtocol}`}
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
            <Fact label="Sessions" value={install?.sessionsRoot ?? "not reported"} copyable monospace />
            <Fact label="Workspaces" value={install?.workspaceRoot ?? "not reported"} copyable monospace />
            <Fact
              label="Agent root"
              value={install?.agentRoot ?? "not reported"}
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
