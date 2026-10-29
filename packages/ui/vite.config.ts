import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
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
/**
 * The orchestrator the dev server proxies `/ws` to (issue #114).
 *
 * ## Validated, because the failure was late and silent
 *
 * Any string used to be accepted. `ws://127.0.0.1` (no port) or a typo produced no complaint at startup
 * and then refused *per connection* — so the browser reported `ECONNREFUSED` on the socket, which points
 * at the orchestrator, while the actual mistake was in this variable.
 *
 * Failing here instead puts the error where the mistake is, once, before anything is served.
 */
function proxyTarget(): string {
  const raw = process.env["PI_CENTRAL_WS"];
  if (raw === undefined || raw === "") return "ws://127.0.0.1:8787";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `PI_CENTRAL_WS is not a URL: ${JSON.stringify(raw)}\n` +
        `  Expected something like:  PI_CENTRAL_WS=ws://127.0.0.1:8787`,
    );
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`PI_CENTRAL_WS must be ws:// or wss://, got ${url.protocol}//`);
  }
  if (url.port === "") {
    // The one that actually happened. A proxy target with no port cannot be reached, and the error the
    // browser shows names the socket rather than the variable.
    throw new Error(
      `PI_CENTRAL_WS has no port: ${JSON.stringify(raw)}\n` +
        `  The orchestrator prints it on startup as PI_CENTRAL_URL=ws://127.0.0.1:<port>`,
    );
  }
  return raw;
}

const target = proxyTarget();

/**
 * The build's identity, injected as literals (issue #114).
 *
 * A page cannot ask git what it was built from, and it should not try: a stamp that is *queried* could
 * answer with something newer than the code it is stamped onto. Compiled in, an old page is exactly the
 * page with an old stamp.
 *
 * `dev` for the commit rather than a guess: a local `npm run ui:build` outside a git checkout has no
 * commit, and saying so is more useful than an empty string.
 */
function buildIdentity(): { commit: string; builtAt: string } {
  let commit = process.env["PI_CENTRAL_COMMIT"] ?? "";
  if (commit === "") {
    try {
      commit = execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" }).trim();
    } catch {
      commit = "dev";
    }
  }
  return { commit: commit || "dev", builtAt: new Date().toISOString() };
}

const identity = buildIdentity();

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_PI_CENTRAL_COMMIT": JSON.stringify(identity.commit),
    "import.meta.env.VITE_PI_CENTRAL_BUILT_AT": JSON.stringify(identity.builtAt),
  },
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
    /**
     * `127.0.0.1`, explicitly (issue #114).
     *
     * Vite 7 binds `localhost` by default, which on macOS resolves to **`::1` first** — so
     * `http://localhost:5173` works and `http://127.0.0.1:5173` is **refused**, while the browser's
     * error names the WebSocket and sends you looking at the orchestrator. Binding the address the docs
     * and the error messages use is the fix; the alternative was telling people to type `localhost`.
     */
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": {
        target,
        ws: true,
        changeOrigin: false,
        /**
         * Handle the socket's own errors instead of letting Vite print a stack trace for each one
         * (issue #114, follow-up).
         *
         * `read ECONNRESET` from the ws proxy is **routine**: it fires when the orchestrator restarts, a
         * session ends, or the tab reloads. Vite logs it through its generic error path, so a normal event
         * arrives as
         *
         *     [vite] ws proxy error:
         *     Error: read ECONNRESET
         *         at TCP.onStreamRead (node:internal/stream_base_commons:221:20)
         *
         * — a stack trace, which reads as a fault. Logging noise as failure trains you to ignore the
         * prefix, which is exactly how `EADDRINUSE`-shaped messages stop being read. So the routine case is
         * reported once, in one line, with no stack; anything else still gets Vite's own logging.
         */
        configure: (proxy) => {
          /** One line per socket, so a reconnect loop cannot flood the terminal. */
          const reported = new WeakSet<object>();

          proxy.on("error", (error, _request, socket) => {
            const code = (error as { code?: string }).code;
            if (code === "ECONNRESET" || code === "EPIPE") {
              // Per-socket dedupe: the same closed socket emits `error` more than once on some platforms.
              if (socket !== undefined && !reported.has(socket)) {
                reported.add(socket);
                console.log(`[vite] ws proxy: connection closed (${code}) — normal on reload or restart`);
              }
              return;
            }
            // Not routine. Let it through as an error, because a proxy that fails for any other reason is
            // worth a stack trace.
            console.error(`[vite] ws proxy error: ${String((error as Error).message)}`);
          });
        },
      },
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
