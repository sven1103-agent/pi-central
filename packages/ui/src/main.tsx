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
import "./styles.css";

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
