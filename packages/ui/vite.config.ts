import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * Pi Central UI build.
 *
 * The dev server proxies `/ws` to the orchestrator so the UI talks to the same origin it is
 * served from. That matters for ADR-0006's CSP: `connect-src 'self'` is only meaningful if
 * the socket really is same-origin, and a hardcoded `ws://127.0.0.1:<port>` would force that
 * directive open.
 *
 * The orchestrator prints `PI_CENTRAL_URL=ws://…` on startup; point this at it with
 * `PI_CENTRAL_WS=ws://127.0.0.1:<port>`.
 */
const target = process.env.PI_CENTRAL_WS ?? "ws://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // `@pi-central/protocol` is a workspace package resolved to its TypeScript source, so a
    // protocol change breaks the UI build rather than being masked by a stale build artifact.
    alias: {
      "@pi-central/protocol": fileURLToPath(
        new URL("../protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": { target, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    // Shiki's grammars are large and loaded on demand, so a single big chunk is expected
    // rather than a problem to be warned about.
    chunkSizeWarningLimit: 2000,
  },
});
