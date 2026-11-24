/**
 * UI entry point.
 *
 * The CSP lives here as a meta tag as well as on the server, because ADR-0006 depends on it
 * being present in every build: `connect-src 'self'` is what makes the WebSocket same-origin
 * requirement real, and a UI served without it would silently lose that guarantee.
 *
 * `unsafe-eval` is absent deliberately. React and Vite's production build do not need it, and
 * a CSP that permits it provides almost no protection against injected script.
 *
 * ## Why the preference store and the connection are built HERE (issue #285)
 *
 * A preference has to be applied before the first paint, and the only way to know the reader's preferences is to
 * ask the orchestrator for them. So the order is: open the socket, wait for the handshake, ask for the map, then
 * render. Doing it inside `App` would mean rendering once with defaults and then swapping — a visible jump in the
 * rail's width and the transcript's measure at every launch, for values that had not changed.
 *
 * Handlers cannot be passed at construction for that reason: `App` does not exist yet. So the ones given here at
 * first are QUEUES, and `App` takes over as soon as it mounts (its `onHandlers` effect) and drains them through the
 * same event path a live one uses. Nothing is dropped in the window, and no event gets a second, different route —
 * which is how a stale-page check ends up missing from one of them (issue #213).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { PREFS_LOAD_TIMEOUT_MS, PrefsStore } from "./prefs-store.ts";
import { Connection, socketUrl, type ConnectionStatus } from "./connection.ts";
import { READING_PREFS_KEY, defaultReadingPrefs, parseReadingPrefs, readingStyle } from "./reading.ts";
import type { Event as WireEvent } from "@pi-central/protocol";
import "./styles.css";

/**
 * The socket, and the preference store behind it, created before anything renders.
 *
 * The handlers below QUEUE rather than drop: an event that arrives during the handshake is still a fact, and `App`
 * replays these on mount through the same handler it uses live. Dropping them would have been simpler and wrong — the
 * error a version skew produces, and the first snapshot, both arrive inside this window.
 */
const earlier: WireEvent[] = [];
const earlierStatus: { status: ConnectionStatus; detail?: string }[] = [];
let accept: ((event: WireEvent) => void) | undefined;
let acceptStatus: ((status: ConnectionStatus, detail?: string) => void) | undefined;

/**
 * The messages about preferences, collected before there is anywhere to show them.
 *
 * A queue rather than a callback for two reasons: the error strip is `App`'s, and `App` does not exist yet at the
 * moment a store with nowhere to write discovers that; and the store reports at most ONCE per page (criterion 5), so
 * a queue of one is the whole traffic.
 */
const problems: string[] = [];

/**
 * Where a preference problem goes once there is somewhere to show it.
 *
 * The store reports at most once, but it can report LATE — a `setPrefs` that fails after the page has been open for
 * an hour is the ordinary case, not the load-time one. Without this handoff that message would go into an array
 * nobody reads again, which is the silent loss criterion 5 exists to prevent.
 */
let hearProblem: ((message: string) => void) | undefined;

const prefs = new PrefsStore({
  // Read at call time rather than captured: the version arrives with `hello`, which is after this object is built.
  protocol: () => connection.protocol,
  send: (control) => connection.send(control),
  onProblem: (message) => {
    if (hearProblem === undefined) problems.push(message);
    else hearProblem(message);
  },
});

const connection = new Connection(socketUrl(), {
  onEvent: (event) => {
    /*
     * The preference store gets its answers FIRST, and they never reach `App`.
     *
     * This has to happen here rather than in `App`'s handler, for the same reason the store is built here: the answer
     * to the page's first `getPrefs` arrives while the store is still awaiting it, which is before `App` has been
     * given the handlers. Routing it through the queue would resolve nothing and then hand a preference event to the
     * reducer as though it were a fact about a session.
     *
     * Both kinds are answers to a question this page asked — a read, or a write whose result decides whether the
     * reader is told their settings were not saved.
     */
    if (event.kind === "prefs" || event.kind === "prefsError") {
      prefs.accept(event);
      return;
    }
    if (accept === undefined) earlier.push(event);
    else accept(event);
  },
  onStatus: (status, detail) => {
    if (acceptStatus === undefined) earlierStatus.push({ status, ...(detail === undefined ? {} : { detail }) });
    else acceptStatus(status, detail);
  },
});
connection.connect();

/**
 * Apply the reader's transcript settings BEFORE the first paint.
 *
 * ## The bug this fixes
 *
 * They were applied only inside `ReadingPanel`, which React mounts when the Settings dialog is open and the
 * Display section is selected. So the document got the preferences only while the reader was looking at the
 * dialog that set them. Everywhere else — including a plain reload — `:root` kept whatever the stylesheet
 * declared, and a setting the reader had changed silently reverted.
 *
 * That was survivable while the only preferences were size and measure, because their defaults happen to equal
 * the stylesheet's declarations and the reversion looked like a design choice. It is not survivable for the tail
 * anchor (ADR-0017), where the two values are visibly different: a reader who chose "flush with the foot" would
 * get the held-above-the-foot default on every reload until they opened Settings again.
 *
 * Done here rather than in `App` so it precedes the first paint: applying it after mount would show the tail at
 * the stylesheet's position and then move it, which is the jump this whole ADR exists to remove.
 *
 * `ReadingPanel` still writes on every change; this is the read side, and the two share `readingStyle` so they
 * cannot describe a preference differently.
 */
function applyReadingPrefs(): void {
  const value = parseReadingPrefs(prefs.get(READING_PREFS_KEY));
  for (const [property, setting] of Object.entries(readingStyle(value))) {
    document.documentElement.style.setProperty(property, setting);
  }
}

/**
 * The interval between a preference change and the write that persists it.
 *
 * Long enough to collapse a burst — a measure slider, a rail fold followed by a width drag, a roster rebuilt by a
 * snapshot — and short enough that the reader would have to be quick to quit inside it. A browser that closes
 * first loses the last change and nothing else: every earlier flush already wrote.
 */
const FLUSH_DELAY_MS = 500;

/**
 * The one place a page decides when a preference is written.
 *
 * Both destinations were previously written at the point of the gesture; there is now one timer, so a preference
 * added later inherits the batching rather than needing its own.
 */
setInterval(() => void prefs.flush(), FLUSH_DELAY_MS);

/**
 * Start the page.
 *
 * Two awaits, and each is bounded: the handshake (`PREFS_LOAD_TIMEOUT_MS`), and the preference read behind it (the
 * same bound, inside the store). A window whose orchestrator never answers must still show an interface — it will
 * show `disconnected`, which is the truth — rather than stay blank because a preference could not be read.
 */
async function start(): Promise<void> {
  await connection.handshake(PREFS_LOAD_TIMEOUT_MS);
  const initialisation = await prefs.initialise();

  /*
   * A read that failed is said out loud, and an EMPTY map is not a failure.
   *
   * The distinction is the one C14 draws about a transcript: "you have never chosen anything" and "I could not look"
   * are opposite facts, and rendering the second as the first invites the next write to overwrite whatever is
   * actually in the file. `unsupported` is not an error either — it is a statement about which Pi Central is
   * running, and the store has already fallen back to the behaviour that shipped.
   */
  if (initialisation.failure !== undefined && initialisation.failure.reason !== "unsupported") {
    problems.push(
      "Pi Central could not read your saved preferences, so this window is showing defaults and will not " +
        "overwrite them: " +
        initialisation.failure.message,
    );
  }

  applyReadingPrefs();

  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root");

  createRoot(root).render(
    <StrictMode>
      <App
        prefs={prefs}
        prefsPersistence={initialisation.persistence}
        connection={connection}
        pendingEvents={earlier}
        pendingStatuses={earlierStatus}
        pendingProblems={problems}
        onHandlers={(handlers) => {
          accept = handlers.onEvent;
          acceptStatus = handlers.onStatus;
        }}
        onPreferenceProblem={(listener) => {
          hearProblem = listener;
        }}
      />
    </StrictMode>,
  );
}

void start();

/**
 * Register the service worker (issue #119), and ONLY in a production build.
 *
 * Two reasons for the `PROD` guard, and the second is the one that would bite:
 *
 *   1. In dev, Vite serves modules with cache-busting query strings and HMR channels; a worker in front of
 *      that produces confusing stale-module behaviour that has nothing to do with the app.
 *   2. `npm run server -- --no-ui` plus `npm run ui:dev` is the documented editing loop. A worker caching
 *      the dev server's responses is exactly the "my edit did not appear" class of bug this whole issue
 *      exists to remove.
 *
 * Failure is non-fatal on purpose: a service worker is a convenience, and a browser that refuses to
 * register one (private mode, an insecure context, an unsupported engine) must still get a working app.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Stated rather than swallowed silently: the app works without it, and the only thing lost is the
      // installable window. Nothing here is worth a visible error to the reader.
    });
  });
}
