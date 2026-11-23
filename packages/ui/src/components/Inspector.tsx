/**
 * The inspector.
 *
 * The auditable facts about the focused session: what isolation is actually in force, the exact
 * command line, where it works, what it has cost. This pane exists because the orchestrator's
 * whole premise is that isolation is *verifiable* rather than asserted — so the UI has to be
 * able to show the policy, not just a "sandboxed" badge.
 */
import type { LiveSession, ToolsetStatus } from "@pi-central/protocol";
import { formatCost, formatTokens, shortenPath } from "../format.ts";
import { hasProcess, isRunning } from "../roster.ts";
import { CopyButton } from "./CopyButton.tsx";

/** One control in the Actions section. */
export interface SessionControl {
  key: string;
  label: string;
  /** What it does — or, when destructive, what it does not undo. */
  title: string;
  onSelect: () => void;
  /** Present but not selectable, used to state WHY an action is missing. */
  disabled?: boolean;
  /** Rendered in the danger colour. Only ever Delete. */
  danger?: boolean;
}

/**
 * Which controls this session offers, as a list.
 *
 * ## Why they live here rather than on the rail row
 *
 * They were row-level buttons, then a row-level `⋯` menu. Both are cramped in a 288px column: the buttons overlapped
 * the row's text and could not be hit, and the menu was reported as *"very tiny"*. Asked for from use: *"maybe we
 * introduce these as session control actions in the session companion next to the transcript?"* — this panel, which
 * already held Rename and Stop and has the width for full-size controls.
 *
 * ## The rules, and why each is a case
 *
 *   - **running** → Stop, and nothing destructive: a process holds the transcript open, so deleting it would leave a
 *     file being written to after it was unlinked.
 *   - **failed** → Retry, plus the housekeeping. A retry the connected orchestrator cannot perform is a DISABLED item
 *     stating the reason, never a button that fails when pressed.
 *   - **stopped** → Resume, plus the housekeeping. Resume spends a spawn, so it comes first and says what it does not
 *     undo.
 *
 * Order throughout: the action that continues work first, the irreversible one last.
 */
export function sessionControlsFor(
  session: LiveSession,
  caps: {
    onStop?: (() => void) | undefined;
    onResume?: (() => void) | undefined;
    onRetry?: (() => void) | undefined;
    retryAvailable: boolean;
    onForget?: (() => void) | undefined;
    onDelete?: (() => void) | undefined;
    /** Compact this session's context now (issue #263). Absent when the orchestrator cannot. */
    onCompact?: (() => void) | undefined;
    /** Open the reload confirmation (issue #274). Absent when the orchestrator cannot reload. */
    onReload?: (() => void) | undefined;
  },
): SessionControl[] {
  const controls: SessionControl[] = [];
  const housekeeping = () => {
    if (caps.onForget !== undefined) {
      controls.push({
        key: "forget",
        label: "Forget",
        // The two titles are read side by side, and their difference IS the point.
        title: "Remove from the rail. The session file is not deleted.",
        onSelect: caps.onForget,
      });
    }
    if (caps.onDelete !== undefined) {
      controls.push({
        key: "delete",
        label: "Delete transcript",
        title: "Delete this session's transcript from disk. This cannot be undone.",
        onSelect: caps.onDelete,
        danger: true,
      });
    }
  };

  if (session.state === "failed") {
    if (caps.retryAvailable && caps.onRetry !== undefined) {
      controls.push({ key: "retry", label: "Retry", title: "Try this session again in the same directory", onSelect: caps.onRetry });
    } else if (!caps.retryAvailable) {
      controls.push({
        key: "retry-unavailable",
        label: "Retry unavailable",
        title: "Restart the orchestrator to retry: it speaks an older protocol",
        onSelect: () => {},
        disabled: true,
      });
    }
    housekeeping();
    return controls;
  }

  if (isRunning(session)) {
    /*
     * COMPACTION is MANUAL, and this is where it lives (issue #263).
     *
     * Pi compacts on its own when the context crosses a threshold. That is the automatic mechanism, and it is not the
     * only reason a reader wants a summary: a long session may be cheaper to compact before starting another task,
     * and an idle session at 60% still has a context worth thinning. So the trigger is not gated on `isNearFull` —
     * that predicate colours the number and warns, and the reader decides whether to act before Pi would.
     *
     * `hasProcess` rather than `isRunning`: `isRunning` includes `failed` so a failed row keeps its Retry, and a
     * dead process cannot compact anything. The orchestrator refuses it with a stated reason, but a control whose
     * only possible outcome is a refusal should not be drawn.
     */
    if (caps.onCompact !== undefined && hasProcess(session)) {
      const compacting = session.compacting === true;
      controls.push({
        key: "compact",
        label: compacting ? "Compacting context" : "Compact context",
        // The cost is stated on the control: this spends a model call, and the reader deciding whether to do it
        // deserves to know that before the click rather than in a bill afterwards.
        title: compacting
          ? "A compaction is already running. It spends a model call and may take a minute."
          : "Summarize this session's context now. This spends a model call and may take a minute.",
        onSelect: caps.onCompact,
        disabled: compacting,
      });
    }
    /*
     * RELOAD (issue #274) — for a running session only, because the command is delivered to a live Pi and there is
     * nothing to deliver to a stopped one. What it does is bounded and worth stating on the control: Pi shuts down
     * and rebinds its extension instances, the transcript and the working directory are untouched, and a run in
     * flight is refused by Pi unless the reader confirms that the run is affected.
     */
    if (caps.onReload !== undefined && hasProcess(session)) {
      const reloading = session.reloading === true;
      controls.push({
        key: "reload",
        label: reloading ? "Reloading resources" : "Reload resources",
        title: reloading
          ? "A reload is already running. Pi shuts down and rebinds its extensions, so this is not instant."
          : "Re-read extensions, skills, prompt templates, MCP servers and context files without stopping the session. The transcript and the working directory are untouched.",
        onSelect: caps.onReload,
        disabled: reloading,
      });
    }
    if (caps.onStop !== undefined) {
      controls.push({ key: "stop", label: "Stop session", title: "Stop this session. Its transcript stays on disk.", onSelect: caps.onStop });
    }
    return controls;
  }

  // Not running (stopped): the whole housekeeping set, Resume first.
  if (caps.onResume !== undefined) {
    controls.push({
      key: "resume",
      label: "Resume session",
      title: "Start this session again in the same directory. Its transcript continues.",
      onSelect: caps.onResume,
    });
  }
  housekeeping();
  return controls;
}

export function Inspector({
  session,
  home,
  onStop,
  onRename,
  onResume,
  onRetry,
  retryAvailable = true,
  onForget,
  onDelete,
  onCompact,
  toolset,
  toolsetError,
  onRefreshToolset,
  onReload,
}: {
  session: LiveSession | undefined;
  home: string | undefined;
  onStop: () => void;
  onRename: (name: string) => void;
  /** Start a stopped session again. Absent when the caller cannot. */
  onResume?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  /** False when the connected orchestrator speaks an older protocol (issue #11). */
  retryAvailable?: boolean;
  onForget?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  /** Compact this session's context now (issue #263). Absent when the orchestrator cannot. */
  onCompact?: (() => void) | undefined;
  /** What was established about this session's toolset, or `undefined` when nobody asked (issue #274). */
  toolset?: ToolsetStatus | undefined;
  /** Why the toolset question could not be answered. Distinct from `unknown` freshness, which IS an answer. */
  toolsetError?: string | undefined;
  /** Ask again. Absent when the connected orchestrator speaks an older protocol. */
  onRefreshToolset?: (() => void) | undefined;
  /** Open the reload confirmation. Absent when the orchestrator cannot reload or the session has no process. */
  onReload?: (() => void) | undefined;
}) {
  if (!session) {
    return (
      <div className="inspector">
        <section>
          <h3>Inspector</h3>
          <p style={{ color: "var(--dim)", fontSize: 12 }}>
            Select a session to see its isolation, paths, and usage.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="inspector">
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
          {session.sidecarOrigin !== undefined && (
            <>
              <dt>Browser</dt>
              <dd>
                {/* The address it can SEE, not the port it listens on: a reader whose preview is on another port needs
                    the one that works, and the sidecar serves exactly one. */}
                <span className="chip chip-idle mono">{session.sidecarOrigin}</span>
              </dd>
            </>
          )}
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
            <CopyButton text={session.cwd} label="path" />
          </dd>
          {session.sessionFile && (
            <>
              <dt>Session file</dt>
              <dd>
                <span>{shortenPath(session.sessionFile, 40, home)}</span>
                <CopyButton text={session.sessionFile} label="path" />
              </dd>
            </>
          )}
          {/*
            Pi's own session id, labelled as such. This previously showed `session.id` —
            Pi Central's handle `s1` — under the label "Session id", which is a different and
            false claim: Pi's id is a uuid, and it is the one a person needs in order to find
            the session file or pass it to `pi --session`.
          */}
          <dt>Session id</dt>
          <dd>
            {session.sessionId ? (
              <>
                <span>{session.sessionId}</span>
                <CopyButton text={session.sessionId} label="session id" />
              </>
            ) : (
              <span title="Pi has not reported its session id yet">—</span>
            )}
          </dd>
          {/* The handle is shown too, but named for what it is: it addresses the process. */}
          <dt>Handle</dt>
          <dd>
            <span>{session.id}</span>
            <CopyButton text={session.id} label="handle" />
          </dd>
        </dl>
      </section>

      {/* The exact argv, because "trust me, it is sandboxed" is not verification. */}
      <section>
        <h3>Command</h3>
        <pre className="cmd">{session.command}</pre>
        <div style={{ marginTop: 6 }}>
          <CopyButton text={session.command} label="command" />
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

      {/*
        THE TOOLSET (issue #274).

        Placed between Usage and Warnings because it answers a question of the same kind as the model and the
        context meter — "what does this session have, and is what I just installed in it?" — rather than a fact
        about the launch.

        The three answers are rendered as three different sentences, and that is the whole component. "Up to date"
        over a check that failed, or over a location it never looked at, is the fabricated-clean-result failure
        C14 describes: the reader would connect nothing, reload nothing, and look in the wrong place.
      */}
      <section>
        <h3>Toolset</h3>
        {toolset === undefined && toolsetError === undefined ? (
          <p className="hint" style={{ margin: 0 }}>
            Not checked.{" "}
            {onRefreshToolset === undefined ? (
              "Reload the page to ask."
            ) : (
              <button type="button" className="btn btn-quiet btn-inline" onClick={onRefreshToolset}>
                Check for changes
              </button>
            )}
          </p>
        ) : toolsetError !== undefined ? (
          // A question that could not be ASKED is not an answer of "unknown". Saying so is the difference between
          // "the check found nothing to report" and "the check is broken".
          <p style={{ color: "var(--danger-text)", fontSize: 11, margin: 0, whiteSpace: "pre-wrap" }}>
            Could not check: {toolsetError}
          </p>
        ) : (
          toolset !== undefined && <ToolsetReport status={toolset} onRefresh={onRefreshToolset} />
        )}
      </section>

      {session.warnings.length > 0 && (        <section>
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

      {/*
        The session's controls, full size, in the companion panel.

        They were row-level buttons and then a `⋯` menu on the rail row, both cramped in a 288px column — the buttons
        overlapped the text and could not be hit, and the menu was "very tiny". This panel already held Rename and Stop,
        and has the width for labels that say what they do.

        Rebuilt from `sessionControlsFor` on every render rather than held in state: the list depends only on the
        session's state and which callbacks the shell can offer, so deriving it means a stale action cannot survive a
        state change (a Stop button left over on a stopped session is the bug this panel already had once).
      */}
      <section>
        <h3>Actions</h3>
        <div className="actions">
          <RenameField current={session.name} onRename={onRename} />
          {sessionControlsFor(session, {
            onStop,
            ...(onResume === undefined ? {} : { onResume }),
            ...(onRetry === undefined ? {} : { onRetry }),
            retryAvailable,
            ...(onForget === undefined ? {} : { onForget }),
            ...(onDelete === undefined ? {} : { onDelete }),
            ...(onCompact === undefined ? {} : { onCompact }),
            ...(onReload === undefined ? {} : { onReload }),
          }).map((control) => (
            <button
              key={control.key}
              type="button"
              className={`btn${control.danger === true ? " btn-danger" : ""}`}
              title={control.title}
              disabled={control.disabled === true}
              onClick={control.onSelect}
            >
              {control.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * What the toolset check found, in the three forms it can honestly take (issue #274).
 *
 * ## Why each value is a different sentence, and not a badge colour
 *
 * A single word ("Stale" / "Fresh" / "Unknown") would be shorter and would lose the only thing this panel is for:
 * the reader's next decision. `unchanged` has to name what it looked at, because a session can be stale for a
 * reason outside every watched location — an `extensions` path in the agent's `settings.json`, an MCP server from an
 * installed package. `unknown` has to name what stopped it from looking, because "I could not check" and "the check
 * found nothing" are the two claims C14 exists to keep apart.
 *
 * ## Why the watched locations are listed
 *
 * It is the evidence for the sentence above it. A claim that a toolset is current, made without saying what was
 * compared, is exactly the unverifiable assertion the Inspector's own header refuses ("isolation is verifiable rather
 * than asserted").
 */
function ToolsetReport({
  status,
  onRefresh,
}: {
  status: ToolsetStatus;
  onRefresh?: (() => void) | undefined;
}) {
  const present = status.watched.filter((location) => location.mtimeMs !== undefined);
  const absent = status.watched.length - present.length;
  return (
    <>
      {status.freshness === "changed" ? (
        <p style={{ color: "var(--warn-text)", fontSize: 11, margin: "0 0 6px" }}>
          <strong>Changed since this session loaded them.</strong> A file under one of the locations below is newer
          than the moment this session read its resources, so it may not have what you just installed. Reloading is
          what proves it either way.
        </p>
      ) : status.freshness === "unchanged" ? (
        <p style={{ fontSize: 11, margin: "0 0 6px" }}>
          No change in the {present.length} location{present.length === 1 ? "" : "s"} below since this session read
          its resources.
          {/*
            The limit, stated where the claim is made. Without it, "no change" reads as "up to date", which this check
            cannot establish — see the `unwatched` field's comment.
          */}
          {status.unwatched.length > 0 && (
            <span style={{ color: "var(--dim)" }}>
              {" "}
              It cannot see {status.unwatched.join(", ")}.
            </span>
          )}
        </p>
      ) : (
        <p style={{ color: "var(--warn-text)", fontSize: 11, margin: "0 0 6px" }}>
          <strong>Cannot tell.</strong>{" "}
          {status.resourcesLoadedAt === undefined
            ? "Pi Central never saw this session read its resources, so there is nothing to compare against."
            : status.unreadable.length > 0
              ? `${status.unreadable.length} location${status.unreadable.length === 1 ? "" : "s"} could not be read, so this is not evidence that nothing changed.`
              : "Nothing could be compared."}
        </p>
      )}
      <dl className="kv">
        <dt>Checked</dt>
        <dd>
          {present.length === 0 ? (
            <span title="None of the watched locations exists on this machine">none</span>
          ) : (
            <span>
              {present.length} location{present.length === 1 ? "" : "s"}
              {absent > 0 ? ` (${absent} absent)` : ""}
            </span>
          )}
        </dd>
        {status.resourcesLoadedAt !== undefined && (
          <>
            <dt>Loaded</dt>
            <dd>{new Date(status.resourcesLoadedAt).toLocaleTimeString()}</dd>
          </>
        )}
      </dl>
      {present.length > 0 && (
        <details>
          <summary className="hint" style={{ cursor: "pointer" }}>
            What was compared
          </summary>
          <ul className="toolset-paths">
            {present.map((location) => (
              <li key={location.path} title={location.path}>
                <span className="mono">{location.kind}</span>{" "}
                <span style={{ color: "var(--dim)" }}>{location.scope}</span>{" "}
                <span className="mono">{location.path}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {status.unreadable.length > 0 && (
        <ul className="toolset-paths">
          {status.unreadable.map((location) => (
            <li key={location.path} style={{ color: "var(--danger-text)" }}>
              <span className="mono">{location.path}</span> {location.code ?? "unreadable"}
            </li>
          ))}
        </ul>
      )}
      {onRefresh !== undefined && (
        <button type="button" className="btn btn-quiet btn-inline" onClick={onRefresh} style={{ marginTop: 6 }}>
          Check again
        </button>
      )}
    </>
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
