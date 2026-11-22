/**
 * A review harness for ADR-0016's follow scroll — NOT part of the app.
 *
 * ## Why this exists
 *
 * The follow scroll is a runtime behaviour, and a static render cannot show it: the preview pages built for
 * the anchor and the stream are server-rendered strings, so the component's scroll handler never ran and the
 * fades never appeared. That was reported from use — "I cannot see any fade" — and it is the reason this
 * harness runs the real component in a real browser instead of rendering HTML and hoping.
 *
 * ## What it runs
 *
 * The actual `TranscriptView`, with the actual stylesheet, driven by simulated streaming: the same reducer
 * path the socket feeds (`applyRecord` over `text_delta` records), one delta per animation frame, into a real
 * scroll container that a real browser lays out. No orchestrator, no socket, no sandbox (C1) — the component
 * takes its transcript as a prop, so nothing else is needed.
 *
 *   node scripts/serve-follow-harness.mjs
 *   open http://127.0.0.1:5199/
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  /*
   * ROOT IS `packages/ui`, NOT THE HARNESS DIRECTORY, and that is forced by the entry's imports.
   *
   * `main.tsx` imports `../src/components/Transcript.tsx`. With the harness directory as root, that path leaves
   * the server's root — Vite answers every such request with the SPA fallback, which is the 583-byte index.html
   * that looks exactly like a working module until you read it. Served from `packages/ui`, the same relative
   * import stays inside the root and resolves.
   *
   * The cost is that the harness is reachable at `/harness/`, so the open URL has that suffix.
   */
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react()],
  // The harness talks to nothing: no socket, no proxy, no orchestrator. `connect-src 'self'` is unused.
  /*
   * A DELIBERATELY UNCOMMON PORT, AND A RELOCATION POLICY.
   *
   * 5199 collided with a running Pi Central on this machine — reported as "port 5199 is in use by the production
   * PI Central instance" — and `strictPort: true` turned that into a refused start. Two separate mistakes:
   *
   *   - the port was picked from nothing. The application's own ports are 8787 (the orchestrator) and 5173 (the UI
   *     dev server), so neither may be used, and 5199 was arbitrary enough to hit something else on a busy machine.
   *   - `strictPort` is right for the APP (a dev server on a surprise port breaks the proxy) and wrong for a
   *     harness, where the whole job is to be opened by a person who then reads the URL. So it relocates instead,
   *     and the launcher reports where it landed rather than predicting it.
   *
   * 4317 is in the IANA dynamic range and matched no listener on this machine when this was written.
   */
  server: { host: "127.0.0.1", port: 4317, strictPort: false },
  resolve: {
    /*
     * The workspace package resolves to its TypeScript SOURCE, exactly as `packages/ui/vite.config.ts` does, so
     * the harness sees the same protocol module the app does. `../` is relative to `harness/` — the first version
     * had it relative to the config's importer and pointed inside packages/ui, which Vite reported as a missing
     * ENOENT on a path that never existed.
     */
    alias: {
      "@pi-central/protocol": fileURLToPath(new URL("../../protocol/src/index.ts", import.meta.url)),
    },
  },
});
