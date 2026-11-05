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
import { PROTOCOL_VERSION, supportsDelete, supportsPlaces, supportsRetry, type Control, type HistoricalSession, type LiveSession, type ModelOption } from "@pi-central/protocol";
import { Connection, socketUrl, type ConnectionStatus } from "./connection.ts";
import { ConfirmDelete } from "./components/ConfirmDelete.tsx";
import { StoppedSession } from "./components/StoppedSession.tsx";
import type { SessionControlCaps } from "./components/SessionControlBar.tsx";
import {
  SKEW_PREFIX,
  assessProtocolSkew,
  assessServedUi,
  noteProtocolAgreement,
  ownEntry,
  safeSessionStorage,
} from "./update-check.ts";
import logoIcon from "./assets/logo-icon.svg";
import { readTracePrefs, writeTracePrefs, type SessionScroll } from "./scroll.ts";
import {
  directoryAt,
  fileAt,
  type FileState,
  initialFilesState,
  reduceFiles,
  newestMtime,
  showsHidden,
  showsWrapped,
  splitFileKey,
  staleDirectories,
  TREE_REREAD_MS,
} from "./files.ts";
import {
  composerMode,
  fleetCounts,
  focusedSession,
  focusedStoppedRow,
  firstPromptFor,
  hasUnisolatedSession,
  initialState,
  pendingDialogCount,
  reduce,
  transcriptFor,
} from "./store.ts";
import { SessionRail, rowLabel } from "./components/SessionRail.tsx";
import { rosterLabel } from "./roster.ts";
import { FollowToggle } from "./components/FollowToggle.tsx";
import {
  parseTraceOrder,
  TRACE_DETAIL_DEFAULT_HEIGHT,
  TRACE_ORDER_KEY,
  type TraceOrder,
} from "./trace.ts";

/**
 * Below this width the rail becomes an overlay drawer.
 *
 * Chosen to match the stylesheet's own breakpoint, and stated here because the BUTTON that opens the drawer is
 * rendered from JavaScript while the layout that needs it is CSS. The two are kept in step by `RAIL_DRAWER_MAX_WIDTH`
 * being the one number, and a test asserts the media query uses the same value — the class of drift this project
 * records for `FILES_SPLIT_MIN_WIDTH` in `panel.ts`.
 */
export const RAIL_DRAWER_MAX_WIDTH = 1024;

/**
 * A session about to be deleted, from either surface (issue #150).
 *
 * The two surfaces identify a session differently — the rail has a `RosterRow` (which may not be live), History has a
 * `HistoricalSession` — but deletion needs only the three facts the dialog displays and the one the request carries.
 * Normalizing here is what lets ONE dialog serve both without either surface knowing about the other's shape.
 */
export interface PendingDelete {
  /**
   * The transcripts to remove. One entry for a row's Delete; several for a bulk selection.
   *
   * A LIST from the start, so the single and the bulk paths share one confirmation and one request shape. Two
   * implementations would drift in wording on the one irreversible action — and the bulk case is the one where the
   * wording matters most, because it deletes things the reader may only have glanced at.
   */
  paths: readonly string[];
  /** What the dialog names. One label, or a count for a selection. */
  label: string;
  /** The directory for a single session; absent for a selection, which can span several. */
  cwd?: string | undefined;
}
import { TranscriptView } from "./components/Transcript.tsx";
import {
  ATTACHMENT_TYPES,
  addAttachment,
  attachmentBytes,
  canSend,
  imageSupport,
  refuseAttachment,
  removeAttachment,
  toPromptImages,
  type Attachment,
} from "./attachments.ts";
import { captureImage } from "./paste.ts";
import type { Entry } from "./mentions.ts";
import { ToolTrace } from "./components/ToolTrace.tsx";
import { Composer, type QueueBehavior } from "./components/Composer.tsx";
import { DialogDock, type DialogAnswer } from "./components/DialogDock.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { Settings } from "./components/Settings.tsx";
import { FilesPanel } from "./components/FilesPanel.tsx";
import { Panel } from "./components/Panel.tsx";
import { PanelToggle } from "./components/PanelToggle.tsx";
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
import { recentDirectories } from "./recent.ts";
import { initialPlacesState, reducePlaces } from "./places.ts";
import { InlineRename } from "./components/InlineRename.tsx";
import { ThinkingPicker } from "./components/ThinkingPicker.tsx";
import { SessionHeader } from "./components/SessionHeader.tsx";
import { HistoryView } from "./components/History.tsx";
import { displayName, formatContext, formatCost, formatTokens, headerLocation, nameLabel } from "./format.ts";
import { stateLabel, type UiState } from "./store.ts";
import {
  ROSTER_PREFS_KEY,
  parseRoster,
  rosterEntryFor,
  rosterRows,
  serializeRoster,
  sessionForPendingPrompt,
  type RosterRow,
} from "./roster.ts";

type Tab = "sessions" | "history";

export function App() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [connectionDetail, setConnectionDetail] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("sessions");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState<LiveSession | undefined>(undefined);
  /**
   * The session awaiting a delete confirmation (issue #150).
   *
   * One dialog for both surfaces: a rail row and a History row ask about the same thing, and two
   * implementations would drift in wording or focus handling on the one irreversible action.
   */
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Focus RETURNS to the trigger on close. Without this, closing a surface opened from the keyboard
  // drops focus to the document body, and the next Tab starts from the top of the page — so a
  // keyboard user pays for having looked at the version.
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);

  // Drafts are per session and in memory, so switching focus never loses typing. Never cleared
  // by Esc: that keystroke belongs to the agent.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  /**
   * Attached images, per session.
   *
   * In memory only, and for a stronger reason than drafts: base64 of a few screenshots is megabytes, so `localStorage`
   * would blow its ~5 MB quota and throw on the NEXT unrelated write — which is the failure mode a persisted draft would
   * cause long after the paste that caused it.
   *
   * Keyed by session because an attachment leaked across a switch would be sent to a different agent in a different
   * directory. Content leaking is worse than text leaking.
   */
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  /**
   * The next attachment id. A counter rather than `crypto.randomUUID()` because two pastes of one screenshot must be two
   * separate attachments with two React keys — identity by content would make the second unremovable.
   */
  const attachmentSeq = useRef(0);
  /** A refusal or acknowledgement, per session, shown in the composer's chrome row. */
  const [attachNotice, setAttachNotice] = useState<Record<string, string | undefined>>({});

  //
  // Incremented on every send. `TranscriptView` watches it to re-arm auto-follow (#86): sending a
  // prompt is an act, and the reader wants to watch the reply even if they had scrolled up to read
  // something first.
  const [followToken, setFollowToken] = useState(0);

  //
  // The reader's own setting for whether the transcript scrolls itself (issue #86). In memory, not
  // persisted: persisting UI state is #15, and inventing a second persistence mechanism here would
  // pre-empt the decision that issue is waiting on.
  const [autoFollow, setAutoFollow] = useState(true);

  //
  // Reading position per session, held HERE and not in the transcript pane (issues #80, #86).
  // `SessionView` carries `key={focused?.id}`, so it remounts on every session switch — a store
  // inside it would be destroyed at the moment it is needed. A ref, so remembering a scroll never
  // re-renders the app.
  const scrollMemory = useRef(new Map<string, SessionScroll>());
  //
  // Per session, and owned HERE rather than in `SessionView` (issue #108).
  //
  // `SessionView` carries `key={focused?.id}`, so it remounts on every session switch — a `useState`
  // inside it is destroyed and comes back at its default. That is exactly what the report describes:
  // collapse the trace, switch away, come back, and it is open again.
  //
  // Persisted, like the panel geometry (issue #108: "it should survive restarts of the application").
  // Read through an initialiser so a corrupt value cannot throw during the first render — the same rule
  // `parsePanelPrefs` follows, and for the same reason: `localStorage` outlives upgrades and is shared
  // with whatever else runs on this origin.
  const [showMarkersBySession, setShowMarkersBySession] = useState<Record<string, boolean>>(
    () => readTracePrefs().markers,
  );
  //
  // Which activity groups the reader has opened, keyed by `sessionId` and then by the group's own key.
  //
  // HERE, for the same reason as the trace maps above: `SessionView` carries `key={focused?.id}` and remounts
  // on every switch, so a disclosure opened inside it would snap shut the moment the reader looked at another
  // session. Not persisted — a group key names a block in one transcript, and remembering "open" across a
  // browser restart would either be stale or, worse, apply to an unrelated group after a session was rewritten.
  const [activityOpen, setActivityOpen] = useState<Record<string, Record<string, boolean>>>({});
  //
  // Which tool call is selected in the panel's Trace view, per session.
  //
  // HERE rather than in `SessionView`, for the reason #108 records: that component remounts on every switch, so a
  // selection held inside it would be lost exactly when the reader comes back to look at it. The trace is a panel
  // now, so the selection has to outlive both a session switch and the panel being closed and reopened.
  const [openToolBySession, setOpenToolBySession] = useState<Record<string, string | undefined>>({});
  //
  // The trace panel's order and detail height, PERSISTED.
  //
  // Both are the reader's choices about a surface they use repeatedly, so neither belongs in `SessionView` (which remounts
  // per session) nor in the component's own state (which dies with the panel). Read through initialisers so a corrupt
  // stored value cannot throw during the first render — the same rule `parsePanelPrefs` follows.
  const [traceOrder, setTraceOrder] = useState<TraceOrder>(() => {
    try {
      return parseTraceOrder(localStorage.getItem(TRACE_ORDER_KEY));
    } catch {
      return "oldest";
    }
  });
  const [traceDetailHeight, setTraceDetailHeight] = useState(TRACE_DETAIL_DEFAULT_HEIGHT);


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
  //
  // Is the session rail showing as a DRAWER?
  //
  // Below `RAIL_DRAWER_MAX_WIDTH` the columns cannot all fit, so the rail leaves the grid and becomes an overlay —
  // opened deliberately, closed by Escape, by the backdrop, or by choosing a session. Without this the rail was simply
  // `display: none` at those widths, and `.rail.open` was styled for a class nothing ever set: the session list became
  // unreachable, which is a worse failure than a cramped one.
  const [railOpen, setRailOpen] = useState(false);
  const railIsDrawer = viewportWidth < RAIL_DRAWER_MAX_WIDTH;
  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth);
      setPanel((current) => ({ ...current, width: clampPanelWidth(current.width, window.innerWidth) }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /*
   * Closing it on resize is not tidiness: a drawer left open while the window grows would cover a rail that is already
   * there, so the reader would see two lists. The state is meaningless once the breakpoint is crossed.
   */
  useEffect(() => {
    if (!railIsDrawer) setRailOpen(false);
  }, [railIsDrawer]);

  /*
   * Escape closes the drawer, and it is registered HERE rather than in the rail because the composer already owns
   * Escape for stopping a run. This handler is on the capture phase and stops the event only when the drawer is open,
   * so the two never both act on one keystroke.
   */
  useEffect(() => {
    if (!railOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setRailOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [railOpen]);

  // Persisted on change, not on every render: the maps only change when a toggle is pressed.
  useEffect(() => {
    writeTracePrefs({ collapsed: {}, markers: showMarkersBySession });
  }, [showMarkersBySession]);

  // Persisted on change, not on every render: both only change when the reader acts.
  useEffect(() => {
    try {
      localStorage.setItem(TRACE_ORDER_KEY, traceOrder);
    } catch {
      // Storage disabled or full. A preference that is not remembered is not an error.
    }
  }, [traceOrder]);

  const setPanelWidth = useCallback((width: number, userSized: boolean) => {
    setPanel((current) => ({ ...current, width, userSized }));
  }, []);

  /**
   * Show or hide the panel, and remember which.
   *
   * The width and mode are left alone on purpose: re-opening returns the panel to where the user left
   * it, rather than to a fresh default that would also undo a deliberate drag.
   */
  const togglePanelCollapsed = useCallback(() => {
    setPanel((current) => {
      const next = { ...current, collapsed: !current.collapsed };
      try {
        localStorage.setItem(PANEL_PREFS_KEY, serializePanelPrefs(next));
      } catch {
        // Storage disabled or full: the panel simply does not remember itself. Not worth failing a
        // render over, and the toggle still works for this session.
      }
      return next;
    });
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
  /**
   * The directory chooser's state (issue #76, ADR-0012).
   *
   * Held HERE rather than inside `OpenDirectorySheet` because the socket listener below is where every
   * orchestrator answer lands, and the sheet unmounts. State that lived in the sheet would be re-requested on
   * every open; state that lived here survives a reopen, so navigating back to a folder you were just in is free.
   */
  const [places, dispatchPlaces] = useReducer(reducePlaces, undefined, initialPlacesState);
  const filesRef = useRef(files);
  filesRef.current = files;

  const connectionRef = useRef<Connection | undefined>(undefined);

  /**
   * The stale-page banner (issue #184). Set when the one-shot reload was already spent on this
   * exact disagreement, so reloading again would loop — the banner carries a real Reload button
   * and names the fix that works (restart the older half; ⌘Q in an installed app).
   */
  const [updateNotice, setUpdateNotice] = useState<string | undefined>(undefined);

  // Which bundle THIS page was loaded from, computed once. `undefined` on a dev server, which
  // silences the comparison deliberately — see `ownEntry`.
  const pageEntry = useMemo(() => ownEntry(), []);
  // Storage that cannot throw (private mode, full quota): refusal degrades to per-tab memory.
  const updateMarks = useMemo(() => safeSessionStorage(), []);

  useEffect(() => {
    const connection = new Connection(socketUrl(), {
      onEvent: (event) => {
        /*
         * Stale-page detection runs BEFORE the store (issue #184).
         *
         * A snapshot reports which bundle the orchestrator is serving NOW; this page knows which
         * bundle it was loaded from. If they differ, the page in memory is the old release — the
         * PWA-update case, where clicking the dock icon focused a window that was never reloaded.
         * Reloading is safe here: sessions live in the orchestrator, and a reconnect re-fetches
         * every transcript, so nothing the page holds is lost. In dev (`import.meta.env.PROD`
         * false) the reload is NOT automatic — a dev server legitimately serves a different UI
         * than the orchestrator's disk — and the verdict becomes the banner instead.
         */
        if (event.kind === "snapshot") {
          const verdict = assessServedUi(pageEntry, event.install, updateMarks);
          if (verdict.action === "reload" && import.meta.env.PROD) {
            location.reload();
            return;
          }
          if (verdict.action === "banner") setUpdateNotice(verdict.message);
          // A matching protocol re-arms the skew one-shot for this tab's next update.
          noteProtocolAgreement(event.install, PROTOCOL_VERSION, updateMarks);
        }
        /*
         * A `hello` skew is the same class of event with the same cure, and it is NOT routed to
         * the dismissible error strip: "reload the UI" is advice a PWA window cannot act on, so
         * the app does it (once), and only the loop case becomes a banner.
         */
        if (event.kind === "error" && event.message.startsWith(SKEW_PREFIX)) {
          const verdict = assessProtocolSkew(event.message, updateMarks);
          if (verdict.action === "reload") {
            // Attempted once in dev too: a skew means the halves disagree about the WIRE, which
            // no amount of running old code can work around. The one-shot mark is what keeps the
            // dev reverse-skew (new files, old orchestrator) from looping into the banner.
            location.reload();
            return;
          }
          if (verdict.action === "banner") setUpdateNotice(verdict.message);
          return;
        }
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
              // Freshness, recorded here because the reducer must stay pure and this is the only
              // place the read and its answer meet (issue #189). `changedAt` is the newest mtime in
              // the answer, so a directory the agent wrote to is re-read without waiting out the
              // window — the case a reader actually notices.
              readAt: Date.now(),
              ...(newestMtime(event.entries) === undefined ? {} : { changedAt: newestMtime(event.entries)! }),
            });
            break;
          case "file":
            dispatchFiles({
              kind: "fileLoaded",
              sessionId: event.sessionId,
              path: event.path,
              bytes: event.bytes,
              content: event.content,
            });
            break;
          case "places":
            dispatchPlaces({ kind: "placesLoaded", places: event.places, home: event.home });
            break;
          case "placeListing":
            dispatchPlaces({
              kind: "listingLoaded",
              // Keyed by the path the CLIENT asked for, for the reason `files` is: the client holds the loading state
              // under the key it sent, so filing the answer under a different spelling would leave it loading forever.
              path: event.path,
              listing: event.listing,
            });
            break;
          case "placeError":
            /*
             * A failed ROOTS request has no path, and `reducePlaces` ignores `placesFailed` — the transport answers a
             * refusal with an `error` event, which the strip above renders. A failed LISTING is recorded against its
             * path, so the pane can state the reason and offer a retry instead of an empty folder.
             */
            if (event.path !== undefined) {
              dispatchPlaces({
                kind: "listingFailed",
                path: event.path,
                reason: event.reason,
                ...(event.code === undefined ? {} : { code: event.code }),
                message: event.message,
              });
            }
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
  /*
    A focused row that is NOT live (issue #89 deadlock).

    `focusedId` holds either a live handle or a roster path, and `focusedSession` searches only `live` — so clicking a
    stopped row used to resolve to nothing and the middle column fell through to "No session selected", with no control
    anywhere to start it again.
  */
  const stoppedRow = focusedStoppedRow(state);
  const stoppedHistory = stoppedRow === undefined
    ? undefined
    : state.history.find((entry) => entry.path === stoppedRow.entry.path);

  /**
   * Remember that a group was opened or closed, for the focused session.
   *
   * Structural rather than behavioural: the open state must outlive `SessionView`'s remount, and the group key
   * already identifies the transcript content, so no extra guard is needed here.
   */
  const toggleActivity = useCallback(
    (key: string, open: boolean) => {
      if (!focused) return;
      const sessionId = focused.id;
      setActivityOpen((current) => ({
        ...current,
        [sessionId]: { ...(current[sessionId] ?? {}), [key]: open },
      }));
    },
    [focused],
  );


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

  /**
   * Take pasted or dropped files, downscale them, and attach them — or say why not.
   *
   * ## Why this is async and sequential
   *
   * Each file is decoded and re-encoded, which is real work per image. Running them in parallel would hold several
   * full-size bitmaps at once (a 4000x3000 screenshot is ~48 MB of RGBA) and the browser would allocate all of them before
   * any were released. Sequential keeps the peak at one.
   *
   * ## Why the refusal is per-paste, not per-file
   *
   * The first refusal stops the batch and is REPORTED. Continuing would attach some of what was dropped and silently skip
   * the rest, and the reader would send a set they did not compose — the same all-or-nothing argument as
   * `acceptImages` in the orchestrator, applied to the browser end.
   */
  const attachFiles = useCallback(
    async (sessionId: string, files: readonly File[]) => {
      let current = attachmentsRef.current[sessionId] ?? [];
      for (const file of files) {
        // A type check before decoding, so a dropped PDF is refused without reading it.
        const captured = ATTACHMENT_TYPES.includes(file.type) ? await captureImage(file) : null;
        if (captured === null) {
          setAttachNotice((previous) => ({
            ...previous,
            [sessionId]: refuseAttachment("unsupported-type", { type: file.type || file.name }),
          }));
          setAttachments((previous) => ({ ...previous, [sessionId]: current }));
          return;
        }

        attachmentSeq.current += 1;
        const result = addAttachment(current, captured, `a${attachmentSeq.current}`);
        if (!result.ok) {
          setAttachNotice((previous) => ({
            ...previous,
            [sessionId]: refuseAttachment(result.reason, { bytes: attachmentBytes(captured.data) }),
          }));
          setAttachments((previous) => ({ ...previous, [sessionId]: current }));
          return;
        }
        current = result.attachments;
      }
      // Committed once at the end, so the rail never shows a half-applied batch.
      setAttachments((previous) => ({ ...previous, [sessionId]: current }));
      setAttachNotice((previous) => ({ ...previous, [sessionId]: undefined }));
    },
    [],
  );

  const removeAttached = useCallback((sessionId: string, id: string) => {
    setAttachments((previous) => ({
      ...previous,
      [sessionId]: removeAttachment(previous[sessionId] ?? [], id),
    }));
  }, []);

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

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
   * Fetch an image a turn NAMES by path, so the turn can preview the thing it is talking about.
   *
   * ## Why this is separate from `openFile`
   *
   * `openFile` also opens the file in the right panel — it changes what the reader is looking at. This does not: a
   * preview inside a turn must not move the panel, steal focus, or mark a file as "open", because it fires on its own
   * as messages scroll into view. Two intents, two functions; folding them together would make rendering a message a
   * navigation event.
   *
   * ## Why the cache check is here rather than in the effect
   *
   * The effect runs for every rendered turn on every transcript change, which during a run is once per streaming
   * record. The `unloaded` check means a path is requested exactly once per session, and the `files` reducer's existing
   * `fileLoading` / `fileLoaded` states do the rest — so there is no second cache to keep in step, and no counter to
   * hold "already asked".
   *
   * A refusal is not retried: `error` is a settled answer, unlike `unloaded`. Retrying would turn one missing file into
   * a request on every record for the life of the session.
   */
  const previewFile = useCallback(
    (sessionId: string, path: string) => {
      if (fileAt(filesRef.current, sessionId, path).status !== "unloaded") return;
      dispatchFiles({ kind: "fileLoading", sessionId, path });
      send({ kind: "readFile", sessionId, path });
    },
    [send],
  );

  /*
   * The focused session's id, named once.
   *
   * Used by several identity-sensitive callbacks below, and hoisted above them because they close over it.
   */
  const previewSessionId = focused?.id;

  /**
   * List a directory for the `@` picker, reusing the SAME cache the file tree uses.
   *
   * That reuse is the design: the tree and the picker ask the same question ("what is in this directory"), so a second
   * request path would be a second cache to keep in step, and a directory the reader had already expanded in the panel would
   * be re-fetched for a mention. `directoryAt` is the guard, so a listing already in hand costs one lookup.
   *
   * Hidden files are EXCLUDED here regardless of the tree's toggle: a picker offering `.env` and `.DS_Store` while someone
   * types a screenshot's name is noise, and dotfiles are rarely what a mid-sentence `@` is reaching for.
   */
  const listMentionDirectory = useCallback(
    (path: string) => {
      if (previewSessionId === undefined) return;
      if (directoryAt(filesRef.current, previewSessionId, path).status !== "unloaded") return;
      listDirectoryFor(previewSessionId, path, false);
    },
    [previewSessionId, listDirectoryFor],
  );

  /**
   * The entries of a directory for the `@` picker, or `undefined` when it is not loaded.
   *
   * Closing over `files` rather than `filesRef`, for the reason `previewsFor` documents: a reader with a stable identity
   * would never change, so the picker would never re-render when the listing arrived and would sit on "Reading…" forever.
   * `undefined` and `[]` are kept distinct — the picker says "Reading…" for one and "No match" for the other, and only one of
   * those is worth waiting for.
   */
  const mentionEntries = useCallback(
    (path: string): readonly Entry[] | undefined => {
      if (previewSessionId === undefined) return undefined;
      const state = directoryAt(files, previewSessionId, path);
      if (state.status !== "loaded") return undefined;
      return state.entries
        .filter((entry) => entry.kind === "file" || entry.kind === "directory")
        .map((entry) => ({ name: entry.name, kind: entry.kind as "file" | "directory" }));
    },
    [previewSessionId, files],
  );

  /**
   * The IDENTITY-STABLE preview request for the focused session.
   *
   * `SessionView` remounts on every session switch, but `TranscriptView` re-renders on every record — and the effect
   * that asks for previews lists this function as a dependency. A fresh closure per render would re-run that effect on
   * every streaming delta. The `unloaded` check inside `previewFile` makes a re-run cheap and correct, but re-running
   * it hundreds of times a second to prove that is work done to produce an answer already known, so the identity is
   * held steady here instead.
   */
  const previewFocused = useCallback(
    (path: string) => {
      if (previewSessionId === undefined) return;
      previewFile(previewSessionId, path);
    },
    [previewSessionId, previewFile],
  );

  /**
   * What is known about one named image, for the focused session.
   *
   * ## Why this one is deliberately NOT identity-stable
   *
   * Every other callback here is memoised to keep `Turn`'s comparison cheap. This one is the exception, and reading
   * through `files` rather than `filesRef` is the whole point: `Turn` is memoised on its props, and a reader with a
   * stable identity would be a prop that never changes — so the turn would be skipped when the image arrived and the
   * preview would stay invisible forever. The bug is invisible in a type check and invisible in a test that only
   * asserts the request was made.
   *
   * Closing over `files` makes the identity change exactly when the file cache does, which is exactly when a turn
   * holding a preview must reconsider. The cost is that every turn re-renders on any file response for the session —
   * and that is the correct cost, because the alternative is a preview that never appears.
   */
  const previewsFor = useCallback(
    (path: string): FileState =>
      previewSessionId === undefined ? { status: "unloaded" } : fileAt(files, previewSessionId, path),
    [previewSessionId, files],
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

  /*
   * Keep the file tree and the `@` picker in step with a directory the agent is writing to (issue #189).
   *
   * ## The defect
   *
   * A listing had no expiry: once a directory answered, that answer was authoritative for the life of
   * the page. So a file the agent created mid-session never appeared, in the tree OR in the composer's
   * `@` picker — both read this cache — and the only cure was restarting the app. The tree also never
   * re-asked, so a file created and then edited showed stale contents.
   *
   * ## Why a timer rather than an fs watch
   *
   * The orchestrator could `fs.watch` each session's cwd, but the cost is the part that decides it.
   * macOS FSEvents is **repo-global**: watching one directory reports every git checkout on the
   * machine, and a project's `.git/index` churns on every `git status`. Filtering that in JavaScript
   * is a firehose for a directory the reader may not even have open. A bounded re-read of directories
   * that are already loaded, only while the window is visible, is proportional to what is actually on
   * screen.
   *
   * ## What keeps it from being a flood
   *
   *   - `staleDirectories` returns only `loaded` directories past `TREE_REREAD_MS`, or whose mtimes say
   *     they already moved. `loading` is skipped so an answer in flight is not discarded.
   *   - The window being hidden stops the whole loop; the reader cannot see an update they are not
   *     looking at.
   *   - The interval is deliberately shorter than the window, so a directory read at t=0 is re-read at
   *     t≈5s rather than at t≈7.5s. A longer interval would make the window the sum of both.
   *   - The reducer returns the SAME state object when nothing is stale, so a tick that finds nothing
   *     to do causes no re-render.
   */
  useEffect(() => {
    if (!focusedId) return;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      const stale = staleDirectories(filesRef.current, focusedId, Date.now());
      for (const path of stale) listDirectoryFor(focusedId, path, showsHidden(filesRef.current, focusedId));
    };
    const timer = setInterval(tick, TREE_REREAD_MS / 2);
    // A window that was hidden for a while must not stay stale until the next tick after it is shown.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [focusedId, listDirectoryFor]);
  /**
   * The first prompt behind a rail row, for its label when nobody named it.
   *
   * Two sources, deliberately, because they cover different rows:
   *
   *   - a LIVE session's prompt comes from its transcript — a session started seconds ago has its question in memory
   *     and no file worth re-reading yet, and the rail must not show `s4` for a question the reader can already see;
   *   - a row with no process falls back to the history page's `firstMessage`, which is the persisted first line.
   *
   * Identity-stable via `useCallback` on `state.transcripts` and `state.history` only, so it changes when either
   * source does and not on every streaming delta.
   */
  const rowPrompt = useCallback(
    (row: RosterRow): string | undefined => {
      // A live session wins: its transcript is the current conversation, and its first message is what the reader
      // wrote most recently.
      if (row.session !== undefined) {
        const live = firstPromptFor(state, row.session.id);
        if (live !== undefined) return live;
      }
      return state.history.find((entry) => entry.path === row.entry.path)?.firstMessage || undefined;
    },
    [state],
  );

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

  /*
   * The roster, persisted (issue #89).
   *
   * Read ONCE on mount, then written whenever it changes. `localStorage` is the right home — `roster.ts`
   * explains why this is a view preference rather than installation configuration — and it is read through
   * `parseRoster` rather than trusted, for the reason `panel.ts` gives: it outlives upgrades and is shared with
   * whatever else runs on this origin.
   */
  useEffect(() => {
    dispatch({ kind: "loadRoster", entries: parseRoster(localStorage.getItem(ROSTER_PREFS_KEY)) });
  }, []);

  /*
   * Everything this process is running belongs in the roster.
   *
   * Adding to the ONE list is correct and cannot duplicate: `addToRoster` matches by file and merges in place.
   * (The bug that produced every session twice came from a SECOND list derived from `live`, not from this.)
   *
   * A session with no `sessionFile` yet is skipped — Pi reports it after `get_state`, and remembering a handle
   * would point at a different session after the next restart.
   */
  useEffect(() => {
    for (const session of state.live) {
      const entry = rosterEntryFor(session);
      if (entry !== undefined) dispatch({ kind: "remember", entry });
    }
  }, [state.live]);

  // Persist whatever the rail is showing. One writer, so storage cannot drift from what is rendered.
  useEffect(() => {
    try {
      localStorage.setItem(ROSTER_PREFS_KEY, serializeRoster(state.roster));
    } catch {
      // A full or disabled `localStorage` must not break the rail: the roster is a convenience, and an
      // unwritable store degrades to "not remembered", which is the behaviour before this feature existed.
    }
  }, [state.roster]);

  /*
   * RESUME-ON-SEND (issue #89).
   *
   * A parked prompt waits for the session it belongs to. Resuming spawns a process that answers with a NEW
   * handle, so the message is parked against the durable path and sent when a live session with that file
   * appears — then focus moves to it, because the reader is now talking to that session.
   *
   * The prompt is consumed exactly once: `clearPendingPrompt` after the send, so a second `session` event for
   * the same file cannot send it twice.
   */
  useEffect(() => {
    const pending = state.pendingPrompt;
    if (pending === undefined) return;
    const session = sessionForPendingPrompt(pending, state.live);
    if (session === undefined) return;
    dispatch({ kind: "clearPendingPrompt" });
    dispatch({ kind: "focusRow", key: session.id });
    send(
      session.state === "streaming" && pending.behavior !== undefined
        ? { kind: "prompt", sessionId: session.id, message: pending.message, behavior: pending.behavior }
        : { kind: "prompt", sessionId: session.id, message: pending.message },
    );
    setFollowToken((n) => n + 1);
  }, [state.pendingPrompt, state.live, send]);

  /**
   * Rename the focused session (issues #78, #79).
   *
   * One function for the header, the rail row and the Inspector, so the three cannot disagree about what a
   * rename does. Only a LIVE session can be renamed: Pi performs it over RPC (`set_session_name`), so a row whose
   * process is gone has no one to ask — the control is not offered there rather than offered and refused.
   */
  const renameFocused = useCallback(
    (name: string) => {
      if (!focused) return;
      send({ kind: "rename", sessionId: focused.id, name });
    },
    [focused, send],
  );

  const onStartSession = useCallback(() => {
    // Ask for focus BEFORE the control goes out: the orchestrator answers `start` with the new `session`
    // event synchronously, so the intent has to be in the store when that event lands (issue #144).
    dispatch({ kind: "expectNewSession" });
    send({ kind: "start" });
  }, [send]);

  /**
   * Ask for the chooser's places, or for one directory inside them (issue #76, ADR-0012).
   *
   * `path === undefined` asks for the roots. The loading marker is set only for a directory, because the roots have
   * no row to mark: the pane renders "Reading your places…" from `roots === undefined`, which is already the state
   * it is in.
   */
  const onListPlaces = useCallback(
    (path?: string) => {
      /*
       * A request for the ROOTS is the sheet opening, so the listings it cached last time are dropped first.
       *
       * Without this, a folder created while the sheet was closed is missing from a listing the reader descends into —
       * the same staleness #189 fixed for the file tree, which had no expiry at all. One extra directory read per
       * descent is the price, and it is the read the reader asked for.
       */
      if (path === undefined) dispatchPlaces({ kind: "reload" });
      else dispatchPlaces({ kind: "listingLoading", path });
      send({ kind: "listPlaces", ...(path === undefined ? {} : { path }) });
    },
    [send],
  );

  const onOpenDirectory = useCallback(
    (cwd: string) => {
      dispatch({ kind: "expectNewSession" });
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
        <h1 className="wordmark">
          {/*
            One artefact, two uses: this is the same file the favicon links to, so the tab and the topbar
            cannot show different marks. `alt=""` because the word beside it already says "Pi Central" —
            an alt here would make a screen reader hear the product name twice.
          */}
          <img className="wordmark-mark" src={logoIcon} alt="" aria-hidden="true" />
          Pi Central
        </h1>
        {/*
          Only rendered when the rail is a drawer. A control that does nothing at every other width would be a permanent
          question ("what is hidden?") on a layout where nothing is.
        */}
        {railIsDrawer && (
          <button
            type="button"
            className="rail-toggle"
            aria-expanded={railOpen}
            aria-controls="session-rail"
            onClick={() => setRailOpen((open) => !open)}
          >
            Sessions
          </button>
        )}
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
          {/*
            Next to Settings because both are chrome, and before it because the panel is the thing a
            user reaches for mid-session. Its label states the action — see `PanelToggle`.
          */}
          <PanelToggle collapsed={panel.collapsed} onToggle={togglePanelCollapsed} />
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

      {/*
        The stale-page banner sits above the error strip (issue #184): it names a condition about
        the WINDOW, not about a session, and its Reload button is the one recovery action a
        standalone PWA window does not otherwise have.
      */}
      {updateNotice !== undefined && (
        <div className="direct-banner" role="alert">
          <strong>Update available</strong>
          <span>{updateNotice}</span>
          <button type="button" className="btn" onClick={() => location.reload()}>
            Reload now
          </button>
        </div>
      )}

      {state.errors.length > 0 && (
        <ErrorStrip
          message={state.errors[0]!}
          onDismiss={() => dispatch({ kind: "dismissError" })}
        />
      )}

      {railOpen && railIsDrawer && (
        /*
          The backdrop is the drawer's close affordance for a pointer, and it is a real button so it is reachable by
          keyboard too. `aria-label` because an unlabelled button riding over the whole workspace announces as
          "button" and nothing else.
        */
        <button
          type="button"
          className="rail-backdrop"
          aria-label="Close the session list"
          onClick={() => setRailOpen(false)}
        />
      )}

      <div
        className={panel.collapsed ? "panes is-collapsed" : "panes"}
        style={{ "--panel-width": `${panel.width}px` } as React.CSSProperties}
      >
        <SessionRail
          /*
           * ONE list of rows: the PERSISTED roster, with activity joined in (issue #89).
           *
           * The roster comes from `localStorage`, so it survives a restart, an update and a crash; `live` only
           * fills each row's activity. A row whose session is not running renders as `stopped` and stays where
           * the reader left it — that is the whole point of the issue.
           */
          rows={rosterRows(state.roster, state.live)}
          /*
            The prompt, for an unnamed session's label (issue #149 follow-up).

            Two sources, because they cover different rows: a LIVE session's prompt is in its transcript (a session
            started seconds ago has no file worth re-reading), and a row with no process falls back to the history
            page's `firstMessage`, which is the persisted first line. Handles are the last resort — see
            `titleFromPrompt` for why they are not the default.
          */
          firstPromptFor={rowPrompt}
          focusedId={state.focusedId}
          openAsDrawer={railOpen}
          onCloseDrawer={() => setRailOpen(false)}
          onFocusRow={(row) => {
            // EVERY row is focusable, including one with no live session (issue #89). That is what makes the
            // composer usable for it, and the composer is how resume-on-send starts the session again.
            // Focus is local: a view change between rows, not a restart (C2).
            dispatch({ kind: "focusRow", key: rowKeyOf(row) });
            setTab("sessions");
            // Choosing a session closes the overlay: leaving it open would cover the conversation just selected.
            setRailOpen(false);
          }}
          onForgetRow={(row) => dispatch({ kind: "forget", path: row.entry.path })}
          retryAvailable={supportsRetry(state.install?.protocol)}
          onRetryRow={(row) => {
            // Only a live session has a handle to retry with; a row that is not running has no process to
            // restart, so it resumes through the composer instead (resume-on-send, #89).
            if (row.session === undefined) return;
            send({ kind: "retry", sessionId: row.session.id });
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
              /*
                Bulk delete, gated the same way. The confirmation names a COUNT rather than a label, because a selection
                can span directories and sessions — and "delete 7 sessions?" is the honest question, where naming one of
                them would imply the others are incidental.
              */
              onDeleteMany={
                supportsDelete(state.install?.protocol)
                  ? (sessions: HistoricalSession[]) =>
                      setPendingDelete({
                        paths: sessions.map((session) => session.path),
                        label: `${sessions.length} selected sessions`,
                      })
                  : undefined
              }
              onResume={(session: HistoricalSession) => {
                /*
                 * Same as starting: the reader asked for THIS session, so it must become the active one even when
                 * another is already focused (issue #144) — and even when THIS one is already running.
                 *
                 * Two dispatches, because two cases:
                 *
                 *   - `focusRow` by FILE focuses it immediately when a live session already holds that conversation.
                 *     That is the reported bug: resuming an already-live session re-broadcasts it, `arrived` is false,
                 *     so the boolean intent was never spent and the tab switched to Sessions showing whatever had been
                 *     focused before. The reader could not tell they were somewhere else.
                 *   - `expectNewSession` with the SAME file covers the spawn still being in flight: the intent is now
                 *     matched by file rather than by "did something new appear", so the arriving session is the one
                 *     that gets focus.
                 */
                dispatch({ kind: "focusRow", key: session.path });
                dispatch({ kind: "expectNewSession", file: session.path });
                send({ kind: "resume", path: session.path });
                setTab("sessions");
              }}
            />
          </main>
        ) : (
          <main className="column">
            {/*
              The dead end, closed (issue #89 deadlock).

              `SessionView` renders "No session selected" for an undefined session, which is right for a fresh window
              and wrong for a row the reader just clicked. A focused STOPPED row gets a view of its own, with the one
              control that recovers it.
            */}
            {focused === undefined && stoppedRow !== undefined ? (
              <StoppedSession
                row={stoppedRow}
                history={stoppedHistory}
                home={home}
                onResume={() => {
                  dispatch({ kind: "expectNewSession" });
                  // By PATH: a stopped session has no handle, and the path is its durable identity (ADR-0004).
                  send({ kind: "resume", path: stoppedRow.entry.path });
                }}
                onForget={() => dispatch({ kind: "forget", path: stoppedRow.entry.path })}
                {...(supportsDelete(state.install?.protocol)
                  ? {
                      onDelete: () =>
                        setPendingDelete({
                          paths: [stoppedRow.entry.path],
                          label: rosterLabel(stoppedRow.entry, stoppedHistory?.firstMessage),
                          ...(stoppedRow.entry.cwd === undefined ? {} : { cwd: stoppedRow.entry.cwd }),
                        }),
                    }
                  : {})}
              />
            ) : (
            <SessionView
              key={focused?.id}
              session={focused}
              preview={focused ? previewFocused : noPreview}
              previews={focused ? previewsFor : noPreviews}
              attachments={focused ? attachments[focused.id] ?? noAttachments : noAttachments}
              onAttach={(files) => {
                if (focused) void attachFiles(focused.id, files);
              }}
              onRemoveAttachment={(id) => {
                if (focused) removeAttached(focused.id, id);
              }}
              attachNotice={focused ? attachNotice[focused.id] : undefined}
              listMentionDirectory={focused ? listMentionDirectory : noListDirectory}
              mentionEntries={focused ? mentionEntries : noMentionEntries}
              showMarkers={focused ? showMarkersBySession[focused.id] !== false : true}
              activityOpen={focused ? activityOpen[focused.id] ?? {} : {}}
              onToggleActivity={toggleActivity}
              onInspectTool={(toolCallId) => {
                if (focused === undefined) return;
                setOpenToolBySession((current) => ({ ...current, [focused.id]: toolCallId }));
                // Opening the panel's Trace tab IS the action: an action that selected a call in a view nobody
                // could see would look like a no-op, which is the mistake the old marker made in reverse.
                setPanel((current) => ({ ...current, collapsed: false, mode: "trace" }));
              }}
              onToggleMarkers={() =>
                focused &&
                setShowMarkersBySession((current) => ({
                  ...current,
                  [focused.id]: current[focused.id] === false,
                }))
              }
              transcript={transcript}
              home={home}
              historyError={state.transcriptErrors[focused?.id ?? ""]}
              followToken={followToken}
              autoFollow={autoFollow}
              onToggleAutoFollow={() => setAutoFollow((was) => !was)}
              scrollMemory={scrollMemory}
              models={focused ? state.models[focused.id] : undefined}
              modelError={focused ? state.modelErrors[focused.id] : undefined}
              onRename={renameFocused}
              onNewInDirectory={onOpenDirectory}
              /*
                The control bar for the focused session, on its header row.

                Stop, Resume, Retry, Forget and Delete, on the row above the transcript — where the session's name and
                directory already are, and where it is always visible. Not the side panel (collapsed by default, so
                unreachable) and not the rail row (two cramped attempts). Each action addresses the session by its FILE
                where a path is needed: a stopped session has no process, so its handle means nothing durable.
              */
              controls={{
                onStop: () => setConfirmStop(focusedSession(state) ?? undefined),
                onResume: () => {
                  const target = focusedSession(state);
                  if (target?.sessionFile === undefined) return;
                  dispatch({ kind: "focusRow", key: target.sessionFile });
                  dispatch({ kind: "expectNewSession", file: target.sessionFile });
                  send({ kind: "resume", path: target.sessionFile });
                },
                onRetry: () => {
                  const target = focusedSession(state);
                  if (target === undefined) return;
                  send({ kind: "retry", sessionId: target.id });
                },
                retryAvailable: supportsRetry(state.install?.protocol),
                onForget: () => {
                  const target = focusedSession(state);
                  if (target?.sessionFile !== undefined) dispatch({ kind: "forget", path: target.sessionFile });
                },
                ...(supportsDelete(state.install?.protocol)
                  ? {
                      onDelete: () => {
                        const target = focusedSession(state);
                        if (target?.sessionFile === undefined) return;
                        setPendingDelete({
                          paths: [target.sessionFile],
                          label: displayName(target),
                          cwd: target.cwd,
                        });
                      },
                    }
                  : {}),
              }}
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
                const sessionId = focused.id;
                const images = toPromptImages(attachmentsRef.current[sessionId] ?? []);
                // Only a streaming prompt carries a behavior; the store's `composerMode` is what
                // decides that, and the App forwards the choice rather than re-deciding it.
                const sent = send({
                  kind: "prompt",
                  sessionId,
                  message,
                  ...(focused.state === "streaming" ? { behavior } : {}),
                  // Omitted rather than sent empty, matching the orchestrator's own rule: an absent field
                  // is a message that was never about images.
                  ...(images.length > 0 ? { images } : {}),
                });
                /*
                 * Cleared only after the control is sent.
                 *
                 * The order matters: clearing first would leave nothing to attach if `send` returned false (the socket
                 * was closed), and the reader's screenshots would be gone with the message. `send` reports whether the
                 * frame left, so this mirrors what the wire received rather than what the UI hoped.
                 *
                 * NO "n images sent" NOTICE, and that is a correction rather than an omission. The chips vanishing is the
                 * whole confirmation: they were the thing that said "these are attached", so their absence says "these
                 * are gone from the composer". The message then appears in the transcript with the images in it, one
                 * line below. A notice restating that was a third confirmation for one fact, in the one strip that is
                 * permanent screen space.
                 *
                 * A REFUSAL still uses that strip, because a refusal is the one thing the reader cannot see anywhere
                 * else: nothing appeared in the composer, and nothing appeared in the transcript.
                 */
                if (sent && images.length > 0) {
                  setAttachments((previous) => ({ ...previous, [sessionId]: [] }));
                }
                // After the control, not inside building it: the transcript re-arms following so the
                // reply scrolls into view whatever the reader had scrolled to before (#86).
                setFollowToken((n) => n + 1);
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
            )}
          </main>
        )}

        {/*
          Not rendered while collapsed (issue #75), rather than rendered at zero width. A zero-width
          panel still mounts `Inspector`/`FilesPanel`, still runs their container queries against
          0px, and still fetches nothing useful — and two of those have already caused a defect here.
          Its geometry and mode live in `panel`, so re-opening restores them.
        */}
        {!panel.collapsed && (
        <Panel
          mode={panel.mode}
          onMode={setPanelMode}
          width={panel.width}
          onWidth={setPanelWidth}
          viewportWidth={viewportWidth}
          onCommit={persistPanel}
        >
          {panel.mode === "trace" ? (
            focused ? (
              <ToolTrace
                tools={transcript.tools}
                selectedId={openToolBySession[focused.id]}
                onSelect={(toolCallId) =>
                  setOpenToolBySession((current) => ({ ...current, [focused.id]: toolCallId }))
                }
                showMarkers={showMarkersBySession[focused.id] !== false}
                onToggleMarkers={() =>
                  setShowMarkersBySession((current) => ({
                    ...current,
                    [focused.id]: current[focused.id] === false,
                  }))
                }
                variant="panel"
                order={traceOrder}
                onOrder={setTraceOrder}
                detailHeight={traceDetailHeight}
                onDetailHeight={setTraceDetailHeight}
                onResetDetailHeight={() => setTraceDetailHeight(TRACE_DETAIL_DEFAULT_HEIGHT)}
              />
            ) : (
              // No session, no trace. Said rather than showing an empty list, which would claim nothing ran.
              <p className="panel-empty">Select a session to see what it ran.</p>
            )
          ) : panel.mode === "session" ? (
            <Inspector
              session={tab === "sessions" ? focused : undefined}
              home={home}
              onStop={() => focused && setConfirmStop(focused)}
              onRename={renameFocused}
              /*
                The session's controls live HERE, not on the rail row (asked for from use: "maybe we introduce these as
                session control actions in the session companion next to the transcript?"). The row gave them 288px and
                a tiny `⋯`; this panel has room for labels that say what they do.

                Each one acts on the FOCUSED session, by its file where a path is needed — a stopped session has no
                process, so its handle addresses nothing durable (ADR-0004).
              */
              onResume={() => {
                if (!focused?.sessionFile) return;
                dispatch({ kind: "focusRow", key: focused.sessionFile });
                dispatch({ kind: "expectNewSession", file: focused.sessionFile });
                send({ kind: "resume", path: focused.sessionFile });
              }}
              onRetry={() => focused && send({ kind: "retry", sessionId: focused.id })}
              retryAvailable={supportsRetry(state.install?.protocol)}
              onForget={() => {
                if (focused?.sessionFile) dispatch({ kind: "forget", path: focused.sessionFile });
              }}
              {...(supportsDelete(state.install?.protocol)
                ? {
                    onDelete: () => {
                      if (!focused?.sessionFile) return;
                      setPendingDelete({
                        paths: [focused.sessionFile],
                        label: displayName(focused),
                        cwd: focused.cwd,
                      });
                    },
                  }
                : {})}
            />
          ) : focused ? (
            <FilesPanel
              sessionId={focused.id}
              files={files}
              cwd={focused.cwd}
              onExpand={expandDirectory}
              onCollapse={(path) => dispatchFiles({ kind: "setExpanded", sessionId: focused.id, path, expanded: false })}
              onToggleHidden={toggleHidden}
              wrapped={showsWrapped(files, focused.id)}
              onToggleWrap={() => dispatchFiles({ kind: "toggleWrap", sessionId: focused.id })}
              onOpenFile={openFile}
              onCloseFile={() => dispatchFiles({ kind: "closeFile", sessionId: focused.id })}
            />
          ) : (
            // No session to browse. Said rather than showing an empty tree, which would claim the
            // directory is empty — the distinction the file state module exists to protect.
            <p className="panel-empty">Select a session to browse its working directory.</p>
          )}
        </Panel>
        )}
      </div>

      {settingsOpen && (
        <Settings
          install={state.install}
          ready={state.ready}
          onClose={() => {
            setSettingsOpen(false);
            settingsTriggerRef.current?.focus();
          }}
        />
      )}

      {sheetOpen && (
        <OpenDirectorySheet
          installationRoot={state.installationRoot}
          home={state.home}
          /* Derived from history, not stored (issue #149). `state.history` is the newest page, which is
             exactly the right input: "recent" cannot be older than the page it is drawn from. */
          recent={recentDirectories(state.history)}
          /* Withheld, never empty, when the orchestrator predates the chooser: an empty pane would claim this machine
             has no folders. See the `places` prop's comment. */
          {...(supportsPlaces(state.install?.protocol) ? { places, onListPlaces } : {})}
          onClose={() => setSheetOpen(false)}
          onOpen={onOpenDirectory}
        />
      )}

      {/*
        ONE destructive dialog for both surfaces (issue #150). It is rendered at the shell rather than inside History
        or the rail so the two cannot disagree about wording or focus on the only irreversible action.
      */}
      {pendingDelete !== undefined && (
        <ConfirmDelete
          label={pendingDelete.label}
          {...(pendingDelete.cwd === undefined ? {} : { cwd: pendingDelete.cwd })}
          count={pendingDelete.paths.length}
          onCancel={() => setPendingDelete(undefined)}
          onConfirm={() => {
            // One control per path. The orchestrator deletes each and re-broadcasts once at the end, so the
            // confirmation is a single act even though the wire carries N messages.
            for (const path of pendingDelete.paths) send({ kind: "deleteSession", path });
            setPendingDelete(undefined);
          }}
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

/**
 * A preview request when there is no focused session.
 *
 * A named constant rather than an inline `() => {}` because it must keep one identity across renders: the transcript
 * holds it in an effect's dependency list, and a fresh arrow every render would re-run that effect on every record —
 * the exact cost the `unloaded` cache check exists to avoid, reintroduced at the call site.
 */
const noPreview = () => {};

/**
 * The same, for the preview STATE reader.
 *
 * Returning `{ status: "unloaded" }` rather than `undefined` keeps `ReferencePreview`'s contract honest: unloaded means
 * "nothing to draw yet", which is precisely true when there is no session to ask.
 */
const noPreviews = () => ({ status: "unloaded" }) as const;

/**
 * An empty attachment list with a stable identity.
 *
 * Like `noPreview`: the composer's `canSend` and the rail both read this, and a fresh `[]` per render would make every
 * comparison of it false. A frozen constant is the cheapest way to say "the same emptiness every time".
 */
const noAttachments: readonly Attachment[] = Object.freeze([]);

/** Stable no-ops for an embedding with no session: see `noPreview`. */
const noListDirectory = () => {};

/**
 * "I know nothing about this directory", for an embedding with no filesystem.
 *
 * `undefined` rather than `[]`, because the picker renders `undefined` as "Reading…" and `[]` as "No match". Saying "No
 * match" about a tree that cannot be read would be a false claim about the session.
 */
const noMentionEntries = () => undefined;

/**
 * The render/focus key for a roster row.
 *
 * A live session uses its handle; a session that is not running has only its file. Both are stable and a row can
 * never be both, so the two namespaces cannot collide. Mirrors `SessionRail`'s own `rowKey`, which is why it is a
 * one-liner used in two places rather than duplicated logic.
 */
function rowKeyOf(row: RosterRow): string {
  return row.session?.id ?? row.entry.path;
}

function SessionView({
  session,
  preview,
  previews,
  attachments,
  onAttach,
  onRemoveAttachment,
  attachNotice,
  listMentionDirectory,
  mentionEntries,
  transcript,
  home,
  historyError,
  models,
  modelError,
  onAnswer,
  onRename,
  onNewInDirectory,
  controls,
  onRequestModels,
  onSelectModel,
  thinking,
  onRequestThinkingLevels,
  onSelectThinkingLevel,
  onSend,
  onClearQueueAndStop,
  followToken,
  autoFollow,
  showMarkers,
  activityOpen,
  onToggleActivity,
  onInspectTool,
  onToggleMarkers,
  onToggleAutoFollow,
  scrollMemory,
  restored,
  onRestored,
  state,
  draft,
  onDraftChange,
}: {
  session: LiveSession | undefined;
  /** Ask the orchestrator for an image a turn names. See `previewFile` in `App`. */
  preview: (path: string) => void;
  /** What is known about each named image, so a turn can preview it. */
  previews: (path: string) => FileState;
  /** Images attached to the prompt being written for this session. */
  attachments: readonly Attachment[];
  onAttach: (files: readonly File[]) => void;
  onRemoveAttachment: (id: string) => void;
  /** A refused paste, or an acknowledgement. Rendered in the composer's chrome row. */
  attachNotice: string | undefined;
  /** List a directory for the `@` picker. */
  listMentionDirectory: (path: string) => void;
  /** The entries of a directory for the `@` picker, or `undefined` when not loaded. */
  mentionEntries: (path: string) => readonly Entry[] | undefined;
  transcript: ReturnType<typeof transcriptFor>;
  home: string | undefined;
  historyError: string | undefined;
  models: ModelOption[] | undefined;
  modelError: string | undefined;
  onAnswer: (dialogId: string, answer: DialogAnswer) => void;
  /** Rename this session (issues #78, #79). */
  onRename: (name: string) => void;
  /** Start a NEW session in this session's directory (issue #149). */
  onNewInDirectory?: ((cwd: string) => void) | undefined;
  /** The session's control bar — Stop, Resume, Retry, Forget, Delete. Built by the shell. */
  controls?: SessionControlCaps | undefined;
  onRequestModels: () => void;
  onSelectModel: (provider: string, modelId: string) => void;
  thinking: { levels: string[] | undefined; error: string | undefined };
  onRequestThinkingLevels: () => void;
  onSelectThinkingLevel: (level: string) => void;
  onSend: (message: string, behavior: QueueBehavior) => void;
  onClearQueueAndStop: () => void;
  followToken: number;
  /** Whether the transcript scrolls itself to new output (issue #86). */
  autoFollow: boolean;
  /**
   * The trace's collapse state and marker toggle, PER SESSION (issue #108).
   *
   * Passed in rather than held here: this component remounts on every session switch, so local state
   * would reset — which is the reported bug.
   */
  showMarkers: boolean;
  /** Which activity groups this session has open, keyed by group key (see the state in `App`). */
  activityOpen: Record<string, boolean>;
  onToggleActivity: (key: string, open: boolean) => void;
  /** Open this call in the panel's Trace view. */
  onInspectTool: (toolCallId: string) => void;
  onToggleMarkers: () => void;
  onToggleAutoFollow: () => void;
  scrollMemory: React.MutableRefObject<Map<string, SessionScroll>>;
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

  const busy = session.state === "streaming";

  /*
   * Whether the paste affordance is offered, from the model Pi reported for this session.
   *
   * Computed from `models` rather than stored: the list is fetched when the picker opens, so an absent list means the
   * answer is `unknown` and the affordance stays — see `imageSupport`. Deriving it here means it follows a model change
   * with no second piece of state to keep in step.
   */
  const canAttach = imageSupport(
    models?.find((model) => model.id === session.model)?.input ??
      models?.find((model) => model.name === session.model)?.input,
  );

  return (
    <>
      <DialogDock dialogs={session.dialogs} onAnswer={onAnswer} />

      <TranscriptView
        initialScroll={scrollMemory.current.get(session.id)}
        onScrollMemory={(memory) => scrollMemory.current.set(session.id, memory)}
        followToken={followToken}
        autoFollow={autoFollow}
        transcript={transcript}
        busy={busy}
        sessionId={session.id}
        preview={preview}
        previews={previews}
        sessionLabel={displayName(session)}
        expectedCount={session.messageCount}
        showMarkers={showMarkers}
        activityOpen={activityOpen}
        onToggleActivity={onToggleActivity}
        onToggleAutoFollow={onToggleAutoFollow}
        historyError={historyError}
        onOpenTool={(toolCallId) => onInspectTool(toolCallId)}
        /*
          The session header is handed to the transcript rather than rendered above it.

          As a full-width band it read as chrome belonging to the WINDOW, not to the conversation — a review called
          it "not clear that it belongs to the transcript". The transcript owns it now: on a wide window it floats at
          the top RIGHT of the reading area as a companion, and when there is no room for that it flips to a compact
          row above the scroller. The placement is the transcript's decision because the transcript knows how much
          room it has (`container-type: inline-size`).
        */
        header={
          <SessionHeader
            session={session}
            home={home}
            models={models}
            modelError={modelError}
            onRequestModels={onRequestModels}
            onSelectModel={onSelectModel}
            thinking={thinking}
            onRequestThinkingLevels={onRequestThinkingLevels}
            onSelectThinkingLevel={onSelectThinkingLevel}
            onRename={onRename}
            onNewInDirectory={onNewInDirectory}
            controls={controls}
            busy={busy}
            warnings={session.warnings}
          />
        }
        footer={
          pendingDialogCount({ ...initialState(), live: [session] }) > 0 ? undefined : (
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
              attachments={attachments}
              onAttach={onAttach}
              onRemoveAttachment={onRemoveAttachment}
              canAttach={canAttach}
              notice={attachNotice}
              listDirectory={listMentionDirectory}
              directoryEntries={mentionEntries}
              follow={
                onToggleAutoFollow === undefined ? undefined : (
                  <FollowToggle following={autoFollow} onToggle={onToggleAutoFollow} />
                )
              }
            />
          )
        }
      />

      {/*
        The trace DRAWER is gone (see `ToolTrace`'s header): it was a permanently-present strip between the
        conversation and the composer, and it is now a panel mode with room to read a call properly. The transcript
        keeps the ledger of steps, and `Inspect` on a step opens the panel's Trace view at that call.
      */}

      {/*
        The composer is handed to the transcript as its footer, not rendered as a sibling band.
        The dialog dock still REPLACES it while the agent waits: answering is the only thing that can move the
        session forward, so offering a prompt beside it would invite typing into a run that cannot accept it.
      */}
    </>
  );
}

/**
 * The strip carries the REASON, not the transcript of stderr.
 *
 * Reported from a window: killing a session showed a red box whose first line was the reason and whose
 * remaining eight lines were pi's startup chatter — LiteLLM model notices and an nvim-tmux hint. The reason was
 * correct and invisible under the noise, and `role="alert"` read all of it aloud.
 *
 * So the strip shows the first line, which is the one the orchestrator writes as the cause, and says how much
 * more there is. The full text stays on the session (`error`) and is rendered in the Session panel, where a
 * reader looking for detail already goes.
 */
export function ErrorStrip({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const [reason, ...detail] = message.split("\n");
  return (
    <div className="error-card" role="alert">
      <p>
        {reason}
        {detail.length > 0 && (
          <span className="error-more">
            {" "}
            (+{detail.length} more line{detail.length === 1 ? "" : "s"} — see the Session panel)
          </span>
        )}
      </p>
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
