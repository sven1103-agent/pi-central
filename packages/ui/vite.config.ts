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
    // Shiki emits one chunk per grammar, and a few of them are very large (`elisp` is 790 kB;
    // `cpp` is 501 kB). They are all loaded on demand, so a big individual chunk is expected
    // rather than a problem — but the limit is raised deliberately rather than to silence a
    // message, and the numbers behind that decision are in `docs/BUNDLE.md`.
    //
    // Sourcemaps are on by default, and grammars carry large ones: `dist/` is ~8.7 MB of JS with
    // them and ~8.2 MB without. They are kept because a production stack trace from a supervised
    // session is worth more than the disk.
    chunkSizeWarningLimit: 2000,
  },
});
