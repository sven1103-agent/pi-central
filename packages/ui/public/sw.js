/**
 * The service worker (issue #119).
 *
 * ## What this is for, precisely
 *
 * A standalone window and a dock icon. **Not offline** — every screen is fed by the socket, so an
 * installed Pi Central with the orchestrator down shows `disconnected` and nothing else. A worker that
 * "worked offline" would install, open, and be useless while implying otherwise, so it deliberately does
 * not try.
 *
 * ## The one rule that matters: `index.html` is NEVER cached
 *
 * `index.html` names the current fingerprint set, which is exactly what `static-ui.ts` says in its
 * `Cache-Control`:
 *
 *     // `index.html` names the current fingerprint set, so caching it is exactly the mistake that
 *     // serves a stale app after a rebuild.
 *
 * A worker that cached it would make a stale build **permanent and invisible** — no reload button, no URL
 * to compare, and a worker the browser updates on its own schedule. So this file applies the SERVER's
 * rule: hashed assets are immutable and cached forever, and the document is fetched from the network every
 * time (issue #120 guards this).
 *
 * ## Why there is no precache list
 *
 * The build emits 266 chunks and 8.8 MB, dominated by Shiki grammars (`elisp` 772 kB, `cpp` 492 kB) that a
 * session may never open. Precaching them would make the first visit pay for grammars it does not use. So
 * everything is runtime-cached on FIRST REQUEST: the entry chunk and CSS on load, a grammar the first time
 * that language appears. Nothing is fetched eagerly.
 *
 * ## `skipWaiting` is deliberately NOT used
 *
 * "Activate immediately" and "never interrupt a running session" pull in opposite directions, and this app
 * holds live sessions. A worker that took over mid-stream would reload the UI under the reader. The new
 * worker waits, and takes over on the next launch — which is the right trade for a tool that is open for
 * hours at a time.
 */
const CACHE = "pi-central-v1";

// A request for the app document, or for a directory that resolves to one.
function isDocument(request, url) {
  return request.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith("/index.html");
}

self.addEventListener("install", (event) => {
  // Nothing to precache — see the note above. `skipWaiting` is absent on purpose.
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  // Drop caches from previous versions of this worker, so a schema change cannot leave stale bytes around
  // forever. Scoped to this prefix so another app on the same origin is untouched.
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name.startsWith("pi-central-") && name !== CACHE).map((name) => caches.delete(name))),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Same-origin only. The app has no business proxying anything else, and doing so would be a hole.
  if (url.origin !== self.location.origin) return;

  // The socket is not a fetch, but a dev-server proxy or an `http` fallback could arrive here. Leave it.
  if (url.pathname.startsWith("/ws")) return;

  if (isDocument(request, url)) {
    // NETWORK, always. No `cache.put`, no fallback to a cached document — a cached `index.html` is how a
    // rebuild stops being visible. If the orchestrator is down the request fails, which is the honest
    // outcome for an app that cannot work without it.
    return;
  }

  // Hashed assets: cache-first, because their name cannot change under new content.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached !== undefined) return cached;
      return fetch(request).then((response) => {
        // Only a real, complete same-origin response is worth keeping. `opaque` responses have no usable
        // status, and a 404 or a 500 must not become permanent.
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
