/**
 * The inspector.
 *
 * The auditable facts about the focused session: what isolation is actually in force, the exact
 * command line, where it works, what it has cost. This pane exists because the orchestrator's
 * whole premise is that isolation is *verifiable* rather than asserted — so the UI has to be
 * able to show the policy, not just a "sandboxed" badge.
 */
import type { LiveSession } from "@pi-central/protocol";
import { formatCost, formatTokens, shortenPath } from "../format.ts";
import { CopyButton } from "./CopyButton.tsx";

export function Inspector({
  session,
  home,
  onStop,
  onRename,
}: {
  session: LiveSession | undefined;
  home: string | undefined;
  onStop: () => void;
  onRename: (name: string) => void;
}) {
  if (!session) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <section>
          <h3>Inspector</h3>
          <p style={{ color: "var(--dim)", fontSize: 12 }}>
            Select a session to see its isolation, paths, and usage.
          </p>
        </section>
      </aside>
    );
  }

  return (
    <aside className="inspector" aria-label="Inspector">
      <section>
        <h3>Isolation</h3>
        <dl className="kv">
          <dt>Mode</dt>
          <dd>
            {session.mode === "sandboxed" ? (
              <span className="chip chip-idle">Safehouse</span>
            ) : (
              <span className="chip chip-no-isolation">NO ISOLATION</span>
            )}
          </dd>
          <dt>Policy</dt>
          <dd>{session.isolation}</dd>
        </dl>
        {session.mode === "direct" && (
          <p style={{ color: "var(--warn-text)", fontSize: 11, marginTop: 8 }}>
            This session runs pi unsandboxed at your user account. It can read and write
            anything you can.
          </p>
        )}
      </section>

      <section>
        <h3>Paths</h3>
        <dl className="kv">
          <dt>Workspace</dt>
          <dd>
            <span>{shortenPath(session.cwd, 40, home)}</span>
            <CopyButton text={session.cwd} label="Path" />
          </dd>
          {session.sessionFile && (
            <>
              <dt>Session file</dt>
              <dd>
                <span>{shortenPath(session.sessionFile, 40, home)}</span>
                <CopyButton text={session.sessionFile} label="Path" />
              </dd>
            </>
          )}
          <dt>Session id</dt>
          <dd>
            <span>{session.id}</span>
            <CopyButton text={session.id} label="Id" />
          </dd>
        </dl>
      </section>

      {/* The exact argv, because "trust me, it is sandboxed" is not verification. */}
      <section>
        <h3>Command</h3>
        <pre className="cmd">{session.command}</pre>
        <div style={{ marginTop: 6 }}>
          <CopyButton text={session.command} label="Command" />
        </div>
      </section>

      <section>
        <h3>Usage</h3>
        <dl className="kv">
          <dt>Messages</dt>
          <dd>{session.messageCount}</dd>
          <dt>Tokens</dt>
          <dd>{formatTokens(session.tokensTotal)}</dd>
          <dt>Cost</dt>
          <dd>{formatCost(session.cost)}</dd>
          <dt>Context</dt>
          <dd>{session.contextPercent === null ? "—" : `${Math.round(session.contextPercent)}%`}</dd>
          <dt>Model</dt>
          <dd>{session.model ?? "—"}</dd>
          <dt>Thinking</dt>
          <dd>{session.thinkingLevel ?? "—"}</dd>
        </dl>
      </section>

      {session.warnings.length > 0 && (
        <section>
          <h3>Warnings</h3>
          {session.warnings.map((warning, index) => (
            <p key={index} style={{ color: "var(--warn-text)", fontSize: 11, margin: "0 0 6px" }}>
              {warning}
            </p>
          ))}
        </section>
      )}

      {session.error && (
        <section>
          <h3>Error</h3>
          <p style={{ color: "var(--danger-text)", fontSize: 11, whiteSpace: "pre-wrap" }}>
            {session.error}
          </p>
        </section>
      )}

      <section>
        <h3>Actions</h3>
        <div className="actions">
          <RenameField current={session.name} onRename={onRename} />
          <button type="button" className="btn" onClick={onStop}>
            Stop session
          </button>
        </div>
      </section>
    </aside>
  );
}

function RenameField({ current, onRename }: { current: string; onRename: (name: string) => void }) {
  return (
    <details>
      <summary className="btn" style={{ cursor: "pointer", fontSize: 12 }}>
        Rename…
      </summary>
      <form
        style={{ marginTop: 6, display: "flex", gap: 6 }}
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get("name");
          if (typeof value === "string" && value.trim().length > 0) onRename(value.trim());
        }}
      >
        <input
          name="name"
          defaultValue={current}
          aria-label="Session name"
          style={{
            flex: 1,
            background: "var(--bg)",
            border: "1px solid var(--line)",
            borderRadius: 6,
            padding: "4px 8px",
            color: "var(--text)",
            font: "12px var(--sans)",
          }}
        />
        <button type="submit" className="btn">
          Save name
        </button>
      </form>
    </details>
  );
}
