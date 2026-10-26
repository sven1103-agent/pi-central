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
import type { Control, HistoricalSession, LiveSession, ModelOption } from "@pi-central/protocol";
import { Connection, socketUrl, type ConnectionStatus } from "./connection.ts";
import {
  directoryAt,
  initialFilesState,
  reduceFiles,
  showsHidden,
  splitFileKey,
} from "./files.ts";
import {
  composerMode,
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
import { Composer, type QueueBehavior } from "./components/Composer.tsx";
import { DialogDock, type DialogAnswer } from "./components/DialogDock.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { Settings } from "./components/Settings.tsx";
import { FilesPanel } from "./components/FilesPanel.tsx";
import { Panel } from "./components/Panel.tsx";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_FILES_DEFAULT_WIDTH,
  PANEL_PREFS_KEY,
  clampPanelWidth,
  defaultPanelPrefs,
  parsePanelPrefs,
  serializePanelPrefs,
  type PanelMode,
  type PanelPrefs,
} from "./panel.ts";
import { ModelPicker } from "./components/ModelPicker.tsx";
import { OpenDirectorySheet } from "./components/OpenDirectorySheet.tsx";
import { ThinkingPicker } from "./components/ThinkingPicker.tsx";
import { HistoryView } from "./components/History.tsx";
import { displayName, formatContext, formatCost, formatTokens, headerLocation } from "./format.ts";
import { stateLabel, type UiState } from "./store.ts";

type Tab = "sessions" | "history";

export function App() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [connectionDetail, setConnectionDetail] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("sessions");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState<LiveSession | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Focus RETURNS to the trigger on close. Without this, closing a surface opened from the keyboard
  // drops focus to the document body, and the next Tab starts from the top of the page — so a
  // keyboard user pays for having looked at the version.
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);

  // Drafts are per session and in memory, so switching focus never loses typing. Never cleared
  // by Esc: that keystroke belongs to the agent.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // The right panel's geometry and mode, restored from the last visit (issue #8; #15 generalises
  // this to drafts and focus). Read through the initialiser so a corrupt value cannot throw during
  // the first render — `parsePanelPrefs` validates every field rather than trusting the JSON.
  const [panel, setPanel] = useState<PanelPrefs>(() => {
    try {
      return parsePanelPrefs(localStorage.getItem(PANEL_PREFS_KEY));
    } catch {
      // `localStorage` throws outright when storage is disabled or the origin is opaque, which is a
      // real configuration rather than a bug — the panel just does not remember itself.
      return defaultPanelPrefs();
    }
  });
  // The viewport width is read for clamping and re-read on resize, because the panel's maximum is a
  // fraction of the window: a window narrowed after a drag must not leave the panel wider than the
  // transcript can survive.
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth);
      setPanel((current) => ({ ...current, width: clampPanelWidth(current.width, window.innerWidth) }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const setPanelWidth = useCallback((width: number, userSized: boolean) => {
    setPanel((current) => ({ ...current, width, userSized }));
  }, []);

  const persistPanel = useCallback(() => {
    // Persisted on gesture END, not per pointermove: a drag emits hundreds of moves and writing
    // `localStorage` synchronously on each one makes the drag stutter.
    setPanel((current) => {
      try {
        localStorage.setItem(PANEL_PREFS_KEY, serializePanelPrefs(current));
      } catch {
        // Storage full or disabled. Losing the remembered width is not worth failing a render over.
      }
      return current;
    });
  }, []);

  const setPanelMode = useCallback(
    (mode: PanelMode) => {
      setPanel((current) => {
        // Widening for `Files` happens ONCE, and only while the user has never dragged the panel.
        // Entering `Files` at 360px would reproduce the original defect — a clipped document — but
        // moving a panel the user has placed is worse than leaving it narrow.
        const width =
          mode === "files" && !current.userSized
            ? clampPanelWidth(PANEL_FILES_DEFAULT_WIDTH, viewportWidth)
            : current.width;
        const next = { ...current, mode, width };
        try {
          localStorage.setItem(PANEL_PREFS_KEY, serializePanelPrefs(next));
        } catch {
          // As above.
        }
        return next;
      });
    },
    [viewportWidth],
  );


  // The file tree has its own reducer: a directory tree is keyed by `(session, path)` and grows on
  // demand, a different lifecycle from session state (issue #8). `filesRef` mirrors it so the
  // connection's event handler can read current state without being rebound on every change.
  const [files, dispatchFiles] = useReducer(reduceFiles, undefined, initialFilesState);
  const filesRef = useRef(files);
  filesRef.current = files;

  const connectionRef = useRef<Connection | undefined>(undefined);

  useEffect(() => {
    const connection = new Connection(socketUrl(), {
      onEvent: (event) => {
        dispatch(event);
        // File messages drive their own reducer (issue #8). They are routed here rather than inside
        // `store.ts` because a directory tree is keyed by `(session, path)` and grows on demand,
        // which is a different lifecycle from session state. Everything else is a session event.
        switch (event.kind) {
          case "files":
            dispatchFiles({
              kind: "filesLoaded",
              sessionId: event.sessionId,
              path: event.path,
              entries: event.entries,
              truncated: event.truncated,
            });
            break;
          case "file":
            dispatchFiles({ kind: "fileLoaded", sessionId: event.sessionId, path: event.path, text: event.text, bytes: event.bytes });
            break;
          case "fileError":
            // `request` says which question failed, so this routes to the right cache instead of
            // guessing. A refused listing becomes `filesFailed` (an error directory), never an empty
            // one — "could not read" and "is empty" are opposite facts.
            if (event.request === "list") {
              dispatchFiles({
                kind: "filesFailed",
                sessionId: event.sessionId,
                path: event.path,
                reason: event.reason,
                ...(event.code === undefined ? {} : { code: event.code }),
                message: event.message,
              });
            } else {
              dispatchFiles({
                kind: "fileFailed",
                sessionId: event.sessionId,
                path: event.path,
                reason: event.reason,
                ...(event.code === undefined ? {} : { code: event.code }),
                message: event.message,
              });
            }
            break;
          default:
            break;
        }
      },
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

  // --- file browsing (issue #8) -----------------------------------------------------------

  /**
   * Request a directory, stating whether dotfiles are wanted.
   *
   * `includeHidden` is sent with EVERY request rather than being a client-side filter. The
   * orchestrator's listing is capped at 2000 entries and sorted directory-first, so filtering 2,000
   * entries here would silently drop dotfiles that the cap had already displaced — the user would
   * turn the toggle on and see nothing change. The flag travels to the read, so the cap is applied
   * to what was asked for.
   */
  const listDirectoryFor = useCallback(
    (sessionId: string, path: string, includeHidden: boolean) => {
      dispatchFiles({ kind: "filesLoading", sessionId, path });
      send({ kind: "listFiles", sessionId, path, includeHidden });
    },
    [send],
  );

  /**
   * Expand a directory, fetching it only when its contents are not already known.
   *
   * The cache check is what makes reopening instant: a directory already loaded is not requested
   * again, so the tree does not flicker through `loading` on every toggle.
   */
  const expandDirectory = useCallback(
    (path: string) => {
      if (!focused) return;
      dispatchFiles({ kind: "setExpanded", sessionId: focused.id, path, expanded: true });
      if (directoryAt(filesRef.current, focused.id, path).status === "loaded") return;
      listDirectoryFor(focused.id, path, showsHidden(filesRef.current, focused.id));
    },
    [focused, listDirectoryFor],
  );

  const openFile = useCallback(
    (path: string) => {
      if (!focused) return;
      dispatchFiles({ kind: "openFile", sessionId: focused.id, path });
      // Re-read on every open, deliberately: unlike a directory listing, a file may have changed on
      // disk since it was last looked at, and showing a stale buffer as current is worse than a
      // re-read. (Directories are cacheable because a tree that reflows under the pointer is its own
      // problem; #10 will add explicit refresh.)
      dispatchFiles({ kind: "fileLoading", sessionId: focused.id, path });
      send({ kind: "readFile", sessionId: focused.id, path });
    },
    [focused, send],
  );

  /**
   * Flip the dotfile toggle, and re-request every directory that is currently on screen.
   *
   * Re-requesting rather than re-filtering is the point: the cached listing was produced with the
   * OLD setting, so it genuinely does not contain the hidden entries. Showing them from the cache is
   * impossible, and pretending otherwise is what the toggle would look like if this were omitted —
   * an on/off switch that changes nothing.
   */
  const toggleHidden = useCallback(() => {
    if (!focused) return;
    const sessionId = focused.id;
    const next = !showsHidden(filesRef.current, sessionId);
    dispatchFiles({ kind: "toggleHidden", sessionId });
    // Every loaded or loading directory for this session, since each was fetched under the old flag.
    const prefix = `${sessionId}\u0000`;
    for (const key of Object.keys(filesRef.current.directories)) {
      if (!key.startsWith(prefix)) continue;
      listDirectoryFor(sessionId, key.slice(prefix.length), next);
    }
  }, [focused, listDirectoryFor]);

  // Load a newly focused session's root once. Keyed on the id, not on `focused`, so switching between
  // two sessions does not refetch a tree already in hand; and skipped for a session already loaded,
  // which is what stops the effect from re-requesting on every re-render.
  const focusedId = focused?.id;
  useEffect(() => {
    if (!focusedId) return;
    if (directoryAt(filesRef.current, focusedId, "").status !== "unloaded") return;
    listDirectoryFor(focusedId, "", showsHidden(filesRef.current, focusedId));
  }, [focusedId, listDirectoryFor]);

  // A stopped session's tree is dropped, so a later session cannot inherit a stale one — and so the
  // cache does not grow without bound as sessions come and go.
  const liveIds = state.live.map((s) => s.id).join("\u0000");
  useEffect(() => {
    const present = new Set(state.live.map((s) => s.id));
    for (const key of Object.keys(filesRef.current.directories)) {
      const { sessionId } = splitFileKey(key);
      if (!present.has(sessionId)) dispatchFiles({ kind: "forgetSession", sessionId });
    }
    // `liveIds` is the change signal; `state.live` is read through the closure fresh on each run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIds]);
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
          {/*
            Labelled, not an icon. A gear glyph would be shorter and would make the version — the
            reason this surface exists — undiscoverable to anyone who reads words rather than shapes.
          */}
          <button
            type="button"
            className="btn btn-quiet"
            ref={settingsTriggerRef}
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </button>
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

      <div className="panes" style={{ "--panel-width": `${panel.width}px` } as React.CSSProperties}>
        <SessionRail
          sessions={state.live}
          focusedId={state.focusedId}
          onFocus={(id) => {
            // Focus is local: switching sessions is a focus change between live processes, not a
            // restart (C2). Nothing is sent to the orchestrator.
            //
            // A DEDICATED action, not a `session` event. Dispatching the session's own data to
            // switch to it was the bug: that event's focus rule is "never steal focus from a session
            // the user is reading", so it always kept the current one and the rail did nothing.
            dispatch({ kind: "focusSession", sessionId: id });
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
              models={focused ? state.models[focused.id] : undefined}
              modelError={focused ? state.modelErrors[focused.id] : undefined}
              onAnswer={onAnswer}
              onRequestModels={() => {
                if (focused) send({ kind: "listModels", sessionId: focused.id });
              }}
              onSelectModel={(provider, modelId) => {
                // Sent, not applied locally: the header must show what Pi reports back, and Pi
                // validates the choice. An optimistic update would display a change that may
                // have been refused.
                if (focused) send({ kind: "setModel", sessionId: focused.id, provider, modelId });
              }}
              thinking={{
                levels: focused ? state.thinkingLevels[focused.id] : undefined,
                error: focused ? state.thinkingLevelErrors[focused.id] : undefined,
              }}
              onRequestThinkingLevels={() => {
                if (focused) send({ kind: "listThinkingLevels", sessionId: focused.id });
              }}
              onSelectThinkingLevel={(level) => {
                if (focused) send({ kind: "setThinkingLevel", sessionId: focused.id, level });
              }}
              onSend={(message, behavior) => {
                if (!focused) return;
                // Only a streaming prompt carries a behavior; the store's `composerMode` is what
                // decides that, and the App forwards the choice rather than re-deciding it.
                send(
                  focused.state === "streaming"
                    ? { kind: "prompt", sessionId: focused.id, message, behavior }
                    : { kind: "prompt", sessionId: focused.id, message },
                );
              }}
              onClearQueueAndStop={() => {
                // One control, because it is one gesture: Pi clears and returns the queued texts,
                // and the abort stops the run. Sending these as separate controls would let a
                // caller abort while discarding what the user typed (issue #3).
                if (focused) send({ kind: "clearQueue", sessionId: focused.id, andStop: true });
              }}
              state={state}
              restored={focused ? state.restoredQueue[focused.id] ?? [] : []}
              onRestored={() => {
                if (focused) {
                  // Cleared once merged, so the effect that merges it cannot run twice on the
                  // same texts. The reducer is the owner of this field, so clearing goes through
                  // an event-like dispatch rather than a second state container.
                  dispatch({ kind: "queueRestored", sessionId: focused.id });
                }
              }}
              draft={focused ? drafts[focused.id] ?? "" : ""}
              onDraftChange={(draft) => {
                if (focused) setDrafts((previous) => ({ ...previous, [focused.id]: draft }));
              }}
            />
          </main>
        )}

        <Panel
          mode={panel.mode}
          onMode={setPanelMode}
          width={panel.width}
          onWidth={setPanelWidth}
          viewportWidth={viewportWidth}
          onCommit={persistPanel}
        >
          {panel.mode === "session" ? (
            <Inspector
              session={tab === "sessions" ? focused : undefined}
              home={home}
              onStop={() => focused && setConfirmStop(focused)}
              onRename={(name) => focused && send({ kind: "rename", sessionId: focused.id, name })}
            />
          ) : focused ? (
            <FilesPanel
              sessionId={focused.id}
              files={files}
              cwd={focused.cwd}
              onExpand={expandDirectory}
              onCollapse={(path) => dispatchFiles({ kind: "setExpanded", sessionId: focused.id, path, expanded: false })}
              onToggleHidden={toggleHidden}
              onOpenFile={openFile}
              onCloseFile={() => dispatchFiles({ kind: "closeFile", sessionId: focused.id })}
            />
          ) : (
            // No session to browse. Said rather than showing an empty tree, which would claim the
            // directory is empty — the distinction the file state module exists to protect.
            <p className="panel-empty">Select a session to browse its working directory.</p>
          )}
        </Panel>
      </div>

      {settingsOpen && (
        <Settings
          install={state.install}
          onClose={() => {
            setSettingsOpen(false);
            settingsTriggerRef.current?.focus();
          }}
        />
      )}

      {sheetOpen && (
        <OpenDirectorySheet
          installationRoot={state.installationRoot}
          onClose={() => setSheetOpen(false)}
          onOpen={onOpenDirectory}
        />
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
  models,
  modelError,
  onAnswer,
  onRequestModels,
  onSelectModel,
  thinking,
  onRequestThinkingLevels,
  onSelectThinkingLevel,
  onSend,
  onClearQueueAndStop,
  restored,
  onRestored,
  state,
  draft,
  onDraftChange,
}: {
  session: LiveSession | undefined;
  transcript: ReturnType<typeof transcriptFor>;
  home: string | undefined;
  historyError: string | undefined;
  models: ModelOption[] | undefined;
  modelError: string | undefined;
  onAnswer: (dialogId: string, answer: DialogAnswer) => void;
  onRequestModels: () => void;
  onSelectModel: (provider: string, modelId: string) => void;
  thinking: { levels: string[] | undefined; error: string | undefined };
  onRequestThinkingLevels: () => void;
  onSelectThinkingLevel: (level: string) => void;
  onSend: (message: string, behavior: QueueBehavior) => void;
  onClearQueueAndStop: () => void;
  restored: string[];
  onRestored: () => void;
  state: UiState;
  draft: string;
  onDraftChange: (draft: string) => void;
}) {
  // The model request state lives inside ModelPicker, which is remounted per session by the `key`
  // on SessionView, so focusing another session starts from a clean "not asked yet".
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
        {/* The model control lives in the header because that is where the value it changes is
            shown, and because a model change is a session-level decision like rename or stop
            rather than a per-message one. */}
        <ModelPicker
          session={session}
          models={models}
          error={modelError}
          onRequest={onRequestModels}
          onSelect={onSelectModel}
        />
        {/* Beside the model, because the two are coupled: the levels are per-model, so a change to
            one invalidates the other. */}
        <ThinkingPicker
          session={session}
          levels={thinking.levels}
          error={thinking.error}
          onRequest={onRequestThinkingLevels}
          onSelect={onSelectThinkingLevel}
        />
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
          state={state}
          unavailableReason={composerMode(session).reason}
          onSend={onSend}
          onClearQueueAndStop={onClearQueueAndStop}
          restored={restored}
          onRestored={onRestored}
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
