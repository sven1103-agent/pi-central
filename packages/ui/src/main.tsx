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
