/**
 * The application shell.
 *
 * Holds the connection, the reducer state, and the few pieces of transient UI state that are
 * genuinely view concerns (drafts per session, the active tab, a start-in-directory sheet).
 *
 * Everything else is derived: `store.ts` computes what is shown, so a component cannot invent
 * state the protocol never sent. That is why the rail reads `state` from the orchestrator
 * rather than inferring "streaming" from having seen a delta (C8).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Control, HistoricalSession, LiveSession } from "@pi-central/protocol";
import { Connection, socketUrl, type ConnectionStatus } from "./connection.ts";
import {
  fleetCounts,
  focusedSession,
  hasUnisolatedSession,
  initialState,
  pendingDialogCount,
  reduce,
  transcriptFor,
} from "./store.ts";
import { SessionRail } from "./components/SessionRail.tsx";
import { TranscriptView } from "./components/Transcript.tsx";
import { ToolTrace } from "./components/ToolTrace.tsx";
import { Composer } from "./components/Composer.tsx";
import { DialogDock, type DialogAnswer } from "./components/DialogDock.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { HistoryView } from "./components/History.tsx";
import { displayName, formatContext, formatCost, formatTokens, headerLocation } from "./format.ts";
import { stateLabel } from "./store.ts";

type Tab = "sessions" | "history";

export function App() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [connectionDetail, setConnectionDetail] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("sessions");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState<LiveSession | undefined>(undefined);

  // Drafts are per session and in memory, so switching focus never loses typing. Never cleared
  // by Esc: that keystroke belongs to the agent.
  const [drafts, setDrafts] = useState<Record<string, string>>({});


  const connectionRef = useRef<Connection | undefined>(undefined);

  useEffect(() => {
    const connection = new Connection(socketUrl(), {
      onEvent: (event) => dispatch(event),
      onStatus: (status, detail) => {
        setConnectionStatus(status);
        setConnectionDetail(detail);
      },
    });
    connectionRef.current = connection;
    connection.connect();
    return () => connection.disconnect();
  }, []);

  const send = useCallback((control: Control) => {
    const ok = connectionRef.current?.send(control);
    if (!ok) {
      // Say so rather than silently dropping the user's action.
      dispatch({ kind: "error", message: "Not connected to the orchestrator. Nothing was sent." });
    }
    return ok;
  }, []);

  const focused = focusedSession(state);
  const transcript = transcriptFor(state, focused?.id);
  const fleet = fleetCounts(state);
  // HOME arrives with the first snapshot, so it is undefined until then. Paths render in full
  // for that instant rather than showing a wrong abbreviation.
  const home = state.home;
  const unisolated = hasUnisolatedSession(state);

  // --- keyboard shortcuts -----------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      // ⌘N is the primary action: a session with no path, in one keystroke (US-1).
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        send({ kind: "start" });
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setSheetOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [send]);

  const onStartSession = useCallback(() => {
    send({ kind: "start" });
  }, [send]);

  const onOpenDirectory = useCallback(
    (cwd: string) => {
      send({ kind: "start", cwd });
      setSheetOpen(false);
      setTab("sessions");
    },
    [send],
  );

  const onAnswer = useCallback(
    (dialogId: string, answer: DialogAnswer) => {
      if (!focused) return;
      send({ kind: "answerDialog", sessionId: focused.id, dialogId, answer });
    },
    [focused, send],
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="wordmark">Pi Central</h1>
        <div className="tabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === "sessions"}
            onClick={() => setTab("sessions")}
          >
            Sessions
          </button>
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === "history"}
            onClick={() => setTab("history")}
          >
            History
          </button>
        </div>

        <div className="topbar-right">
          <div className="fleet">
            {/* Each label matched to its number. The first version labelled the session COUNT
                as "running", so two idle sessions read "2 running". */}
            <span>
              {fleet.total} session{fleet.total === 1 ? "" : "s"}
            </span>
            {/* "0 running" is noise, so it only appears when something is actually running. */}
            {fleet.running > 0 && <span>{fleet.running} running</span>}
            {fleet.scratch > 0 && <span>{fleet.scratch} scratch</span>}
            {fleet.needs > 0 && <span className="fleet-needs">{fleet.needs} need you</span>}
          </div>
          <span className={`conn conn-${connectionStatus}`}>
            <span className="conn-dot" aria-hidden="true" />
            <span>
              {connectionStatus === "open"
                ? "connected"
                : connectionStatus === "connecting"
                  ? "connecting…"
                  : "disconnected"}
            </span>
            {connectionDetail && <span className="hint">· {connectionDetail}</span>}
          </span>
        </div>
      </header>

      {/*
        Unsandboxed sessions announced at the top of the window, not only in the inspector.
        The design specified this banner and the CSS for it was written, but nothing rendered it
        — so `--direct` mode was visible only as a chip in a side panel, which is the wrong
        prominence for "the agent has your account's access".
      */}
      {unisolated && (
        <div className="direct-banner" role="alert">
          <strong>Direct mode: sessions are not sandboxed</strong>
          <span>
            These sessions run pi with your account's access. Everything else in Pi Central is
            unaffected; start new sessions with the sandbox to change it.
          </span>
        </div>
      )}

      {state.errors.length > 0 && (
        <ErrorStrip
          message={state.errors[0]!}
          onDismiss={() => dispatch({ kind: "error", message: "" })}
        />
      )}

      <div className="panes">
        <SessionRail
          sessions={state.live}
          focusedId={state.focusedId}
          onFocus={(id) => {
            // Focus is local: switching sessions is a focus change between live processes, not
            // a restart (C2). Nothing is sent to the orchestrator.
            dispatch({ kind: "session", session: state.live.find((s) => s.id === id) ?? state.live[0]! });
            setTab("sessions");
          }}
          onStartSession={onStartSession}
          onOpenDirectory={() => setSheetOpen(true)}
          home={home}
          historyTotal={state.historyTotal}
        />

        {tab === "history" ? (
          <main className="column">
            <HistoryView
              history={state.history}
              historyTotal={state.historyTotal}
              home={home}
              onResume={(session: HistoricalSession) => {
                send({ kind: "resume", path: session.path });
                setTab("sessions");
              }}
            />
          </main>
        ) : (
          <main className="column">
            <SessionView
              key={focused?.id}
              session={focused}
              transcript={transcript}
              home={home}
              historyError={state.transcriptErrors[focused?.id ?? ""]}
              onAnswer={onAnswer}
              onSend={(message) => {
                if (focused) send({ kind: "prompt", sessionId: focused.id, message });
              }}
              onClearQueueAndStop={() => {
                if (focused) send({ kind: "abort", sessionId: focused.id });
              }}
              draft={focused ? drafts[focused.id] ?? "" : ""}
              onDraftChange={(draft) => {
                if (focused) setDrafts((previous) => ({ ...previous, [focused.id]: draft }));
              }}
            />
          </main>
        )}

        <Inspector
          session={tab === "sessions" ? focused : undefined}
          home={home}
          onStop={() => focused && setConfirmStop(focused)}
          onRename={(name) => focused && send({ kind: "rename", sessionId: focused.id, name })}
        />
      </div>

      {sheetOpen && (
        <OpenDirectorySheet onClose={() => setSheetOpen(false)} onOpen={onOpenDirectory} />
      )}

      {confirmStop && (
        <ConfirmStop
          session={confirmStop}
          onCancel={() => setConfirmStop(undefined)}
          onConfirm={() => {
            send({ kind: "stop", sessionId: confirmStop.id });
            setConfirmStop(undefined);
          }}
        />
      )}
    </div>
  );
}

function SessionView({
  session,
  transcript,
  home,
  historyError,
  onAnswer,
  onSend,
  onClearQueueAndStop,
  draft,
  onDraftChange,
}: {
  session: LiveSession | undefined;
  transcript: ReturnType<typeof transcriptFor>;
  home: string | undefined;
  historyError: string | undefined;
  onAnswer: (dialogId: string, answer: DialogAnswer) => void;
  onSend: (message: string) => void;
  onClearQueueAndStop: () => void;
  draft: string;
  onDraftChange: (draft: string) => void;
}) {
  if (!session) {
    return (
      <div className="empty">
        <h2>No session selected</h2>
        <p>
          <span className="action">New session</span> gives it its own scratch workspace
          immediately — no directory to pick, nothing to decide first. Files it writes stay
          there.
        </p>
        <p>
          Working in a project? <span className="action">Open in a directory.</span>
        </p>
      </div>
    );
  }

  // Which tool call is open in the trace window, and whether that window is collapsed. Scoped to
  // the session view so a selection cannot leak into another session's trace.
  const [openTool, setOpenTool] = useState<string | undefined>(undefined);
  const [traceCollapsed, setTraceCollapsed] = useState(false);
  // Markers on by default: they are how you tell WHERE the agent did something, which the trace
  // window cannot express. One click hides them for pure reading.
  const [showMarkers, setShowMarkers] = useState(true);
  const busy = session.state === "streaming";

  return (
    <>
      <div className="session-header">
        <div className="title">
          <h2>
            {displayName(session)}
            {session.scratch && <span className="chip chip-scratch">scratch</span>}
            <span className={`chip chip-${session.state}`}>{stateLabel(session)}</span>
          </h2>
          <span className="where" title={session.cwd}>
            {headerLocation(session, home)}
          </span>
        </div>
      </div>

      <div className="metrics">
        <span className={session.contextPercent !== null && session.contextPercent >= 80 ? "warn" : ""}>
          {formatContext(session.contextPercent)}
        </span>
        {/* Through the formatter, not raw: the inspector rendered the same value as `127.2M`
            while this strip rendered `12723914` — one value, two formats, one screen. */}
        <span>{formatTokens(session.tokensTotal)} tok</span>
        <span>{formatCost(session.cost)}</span>
        <span>{session.messageCount} msgs</span>
        {session.pending > 0 && <span className="warn">+{session.pending} queued</span>}
      </div>

      <div className="run-track">
        {busy && <div className="run-bar" style={{ width: "100%" }} />}
      </div>

      {session.warnings.length > 0 && (
        <div className="warnings" role="note">
          {session.warnings.map((warning, index) => (
            <span key={index}>⚠ {warning}</span>
          ))}
        </div>
      )}

      <DialogDock dialogs={session.dialogs} onAnswer={onAnswer} />

      <p className="legend">
        Tool output and file contents appear in a hatched frame. They are data, not instructions.
      </p>

      <TranscriptView
        transcript={transcript}
        busy={busy}
        sessionLabel={displayName(session)}
        expectedCount={session.messageCount}
        showMarkers={showMarkers}
        historyError={historyError}
        onOpenTool={(toolCallId) => {
          // Opening from a marker un-collapses the trace, or the click would appear to do nothing.
          setTraceCollapsed(false);
          setOpenTool(toolCallId);
        }}
      />

      {/* The trace sits between the conversation and the composer: both live surfaces adjacent,
          so watching the agent and watching what it is running are one glance apart. */}
      {openTool !== undefined || transcript.tools.length > 0 ? (
        <ToolTrace
          tools={transcript.tools}
          selectedId={openTool}
          onSelect={setOpenTool}
          collapsed={traceCollapsed}
          onToggleCollapsed={() => setTraceCollapsed((was) => !was)}
          showMarkers={showMarkers}
          onToggleMarkers={() => setShowMarkers((was) => !was)}
        />
      ) : null}

      {pendingDialogCount({ ...initialState(), live: [session] }) > 0 ? null : (
        <Composer
          session={session}
          onSend={onSend}
          onClearQueueAndStop={onClearQueueAndStop}
          draft={draft}
          onDraftChange={onDraftChange}
        />
      )}
    </>
  );
}

function ErrorStrip({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="error-card" role="alert">
      <p>{message}</p>
      <div className="actions">
        <button type="button" className="btn" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * The only modal in the design, and the only truly destructive action.
 *
 * Every other dialog is a dock, because a modal over the whole app would punish switching to
 * another session — the dashboard's reason to exist.
 */
function ConfirmStop({
  session,
  onCancel,
  onConfirm,
}: {
  session: LiveSession;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="stop-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="stop-title">Stop this session?</h3>
        <p>
          This ends the run in progress for {displayName(session)}. Messages so far are already
          saved.
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            Stop session
          </button>
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            Keep running
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The secondary path: naming a directory to work in.
 *
 * Deliberately a sheet rather than the greeting. The common case is a session with no path
 * (US-1); this exists for the case where the work already has a home.
 */
function OpenDirectorySheet({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (cwd: string) => void;
}) {
  const [path, setPath] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const trimmed = path.trim();
  // Client-side validation is advisory only: the orchestrator validates the directory before
  // spawning, and a directory can vanish between the two checks (D-4).
  const problem = useMemo(() => {
    if (trimmed.length === 0) return "Enter a directory.";
    if (!trimmed.startsWith("/")) return "Enter an absolute path, starting with /.";
    return undefined;
  }, [trimmed]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-dir-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="open-dir-title">Open in a directory</h3>
        <p style={{ marginBottom: 12 }}>
          The session is sandboxed to this directory. Pi Central does not change a session's
          directory later, so start it where the work belongs.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (problem === undefined) onOpen(trimmed);
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={path}
            spellCheck={false}
            placeholder="/absolute/path/to/project"
            aria-label="Working directory"
            aria-invalid={problem !== undefined && path.length > 0}
            onChange={(event) => setPath(event.target.value)}
            style={{
              width: "100%",
              background: "var(--bg)",
              border: "1px solid var(--line-strong)",
              borderRadius: 6,
              padding: "8px 10px",
              color: "var(--text)",
              font: "13px var(--mono)",
            }}
          />
          {problem !== undefined && path.length > 0 && (
            <p style={{ color: "var(--warn-text)", fontSize: 12, margin: "6px 0 0" }}>{problem}</p>
          )}
          <div className="dialog-actions">
            <button type="submit" className="btn" disabled={problem !== undefined}>
              Open here
            </button>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
