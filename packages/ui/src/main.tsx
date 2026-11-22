/**
 * UI entry point.
 *
 * The CSP lives here as a meta tag as well as on the server, because ADR-0006 depends on it
 * being present in every build: `connect-src 'self'` is what makes the WebSocket same-origin
 * requirement real, and a UI served without it would silently lose that guarantee.
 *
 * `unsafe-eval` is absent deliberately. React and Vite's production build do not need it, and
 * a CSP that permits it provides almost no protection against injected script.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { READING_PREFS_KEY, defaultReadingPrefs, parseReadingPrefs, readingStyle } from "./reading.ts";
import "./styles.css";

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
  let prefs = defaultReadingPrefs();
  try {
    prefs = parseReadingPrefs(localStorage.getItem(READING_PREFS_KEY));
  } catch {
    // Storage disabled or an opaque origin: the defaults still apply, the setting just cannot be remembered.
  }
  for (const [property, value] of Object.entries(readingStyle(prefs))) {
    document.documentElement.style.setProperty(property, value);
  }
}

applyReadingPrefs();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

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
