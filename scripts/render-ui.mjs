#!/usr/bin/env node
/**
 * Render a UI screen to a self-contained HTML file, so a change can be LOOKED at.
 *
 * ## Why this exists
 *
 * Every slice in Increment 4 is `verified/manual`, and the manual check has repeatedly been the step that
 * was skipped — `docs/RELEASING.md` records that on 0.7.0 ("passing tests and nobody having seen it"), and
 * #192 shipped a bar whose width nobody had seen at real size because Chromium SEGVs in this environment.
 *
 * `render-session-html.mjs` solved that for the transcript. This is the same trick for the rest of the
 * shell: SSR the REAL components through the same Vite server the component tests use, wrap them in the
 * real stylesheet, and write one file that opens in any browser. No automation, no sandbox escape, and no
 * headless browser — which is the part that cannot run here (C1).
 *
 * ## What it is not
 *
 * Not a screenshot tool and not a substitute for using the app. It renders what the components PRODUCE
 * from a given state; it cannot show a hover, a transition, a focus ring in motion, or a drag. It answers
 * "does this look right / is this readable / does the bar have room", which is what the manual checks have
 * actually been about.
 *
 * ## Usage
 *
 *   node scripts/render-ui.mjs                       # every scene, to /tmp/pi-central-ui.html
 *   node scripts/render-ui.mjs rail                  # one scene
 *   node scripts/render-ui.mjs --out /tmp/x.html     # choose the file
 *   node scripts/render-ui.mjs --list                # scene names
 *
 * The scenes below are the states the fleet work keeps needing: a rail of ten sessions at mixed context
 * pressure, and a header at the threshold. Add a scene when a change needs judging visually.
 */
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UI_ROOT = join(ROOT, "packages", "ui");

// jsdom before any component loads: DOMPurify binds to `window` at module-init time.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.invalid/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

const server = await createServer({
  root: UI_ROOT,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
  // The dep-scan pre-bundles `index.html`; there is no document here and its failure output is noise.
  optimizeDeps: { noDiscovery: true, include: [] },
});

/** A live session with only the fields the rail and header read. */
function live(over = {}) {
  return {
    id: "s1",
    name: "session",
    cwd: "/Users/x/git/project",
    state: "streaming",
    mode: "sandboxed",
    isolation: "Safehouse",
    command: "",
    scratch: false,
    messageCount: 4,
    pending: 0,
    contextPercent: null,
    tokensTotal: null,
    cost: null,
    dialogs: [],
    warnings: [],
    startedAt: 0,
    ...over,
  };
}

const rowOf = (session) => ({
  entry: { path: session.sessionFile ?? `live:${session.id}`, cwd: session.cwd, name: session.name },
  session,
});

const { SessionRail } = await server.ssrLoadModule("/src/components/SessionRail.tsx");
const { SessionHeader } = await server.ssrLoadModule("/src/components/SessionHeader.tsx");

const railProps = {
  focusedId: undefined,
  onFocusRow() {},
  onForgetRow() {},
  onRetryRow() {},
  retryAvailable: true,
  onStartSession() {},
  onOpenDirectory() {},
  home: "/Users/x",
  historyTotal: 0,
  openAsDrawer: false,
  onCloseDrawer() {},
};

/**
 * The scenes.
 *
 * `rail-ten` is the one the increment is named after — ten sessions, mixed states and context pressure —
 * because "a fleet of ten is no harder to run than one" is a claim about reading ten rows at once, and
 * that is exactly what a render can show and a unit test cannot.
 */
const SCENES = {
  "rail-ten": () => {
    const names = [
      ["api-gateway", "awaiting-approval", 34, 1],
      ["docs-site", "failed", 12, 0],
      ["indexer", "streaming", 96, 0],
      ["transcript-rework", "streaming", 84, 2],
      ["schema-migration", "idle", 79, 0],
      ["billing-tests", "idle", 61, 0],
      ["css-tokens", "idle", 8, 0],
      ["old-spike", "stopped", null, 0],
      ["release-notes", "stopped", null, 0],
      ["scratch-s7", "idle", 42, 0],
    ];
    const rows = names.map(([name, state, contextPercent, pending], i) =>
      rowOf(
        live({
          id: `s${i + 1}`,
          name,
          state,
          contextPercent,
          pending,
          scratch: name.startsWith("scratch"),
          cwd: `/Users/x/git/${name.replace(/^scratch-/, "workspaces/")}`,
          ...(state === "awaiting-approval"
            ? { dialogs: [{ id: "d1", method: "confirm", message: "Run `rm -rf dist`?", receivedAt: 0 }] }
            : {}),
          ...(state === "failed" ? { error: "pi exited (code=1, signal=-)" } : {}),
        }),
      ),
    );
    return renderToString(createElement(SessionRail, { ...railProps, rows }));
  },

  "rail-empty": () => renderToString(createElement(SessionRail, { ...railProps, rows: [] })),

  "header-threshold": () =>
    renderToString(
      createElement(SessionHeader, {
        session: live({ name: "transcript-rework", contextPercent: 84, cost: 1.2345, model: "opus", provider: "anthropic" }),
        home: "/Users/x",
        models: [],
        modelError: undefined,
        onRequestModels() {},
        onSelectModel() {},
        thinking: { levels: ["low", "medium", "high"], error: undefined },
        onRequestThinkingLevels() {},
        onSelectThinkingLevel() {},
        onRename() {},
      }),
    ),

  "header-unknown": () =>
    renderToString(
      createElement(SessionHeader, {
        session: live({ name: "fresh", contextPercent: null, cost: null }),
        home: "/Users/x",
        models: [],
        modelError: undefined,
        onRequestModels() {},
        onSelectModel() {},
        thinking: { levels: ["low", "medium", "high"], error: undefined },
        onRequestThinkingLevels() {},
        onSelectThinkingLevel() {},
        onRename() {},
      }),
    ),
};

// --- CLI ---------------------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const name of Object.keys(SCENES)) console.log(name);
  await server.close();
  process.exit(0);
}

const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : "/tmp/pi-central-ui.html";
const wanted = args.filter((arg, index) => !arg.startsWith("--") && index !== outIndex + 1);
const chosen = wanted.length > 0 ? wanted : Object.keys(SCENES);
for (const name of chosen) {
  if (SCENES[name] === undefined) {
    console.error(`no such scene: ${name}\n  try: --list`);
    await server.close();
    process.exit(1);
  }
}

/** The real stylesheet, so what is looked at is what ships. */
const css = readFileSync(join(UI_ROOT, "src", "styles.css"), "utf8");

/**
 * Each scene in its own frame at the width it will actually be seen.
 *
 * The rail is a 288px column (`grid-template-columns: 288px …` in the shell), so rendering it at 288 rather
 * than full width is the difference between judging the real thing and judging a layout the app never
 * produces. The header sits in a wide row, so it gets the window.
 */
const FRAMES = {
  "rail-ten": 288,
  "rail-empty": 288,
  "header-threshold": 900,
  "header-unknown": 900,
};

const sections = chosen
  .map((name) => {
    const width = FRAMES[name] ?? 900;
    return `<section>
  <h2>${name} <small>${width}px</small></h2>
  <div class="frame" style="--frame-width:${width}px">${SCENES[name]()}</div>
</section>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Pi Central — UI render</title>
<style>
${css}
/* The harness, not the app: a neutral page around each frame at its real width. */
body { margin: 0; padding: 24px; background: var(--bg); color: var(--text); font-family: var(--sans); }
h2 { font-size: var(--fs-sm); color: var(--dim); font-weight: 600; margin: 28px 0 8px; }
h2 small { font-weight: 400; opacity: .7; }
.frame { width: var(--frame-width); max-width: 100%; background: var(--panel); border: 1px solid var(--line); overflow: hidden; }
</style></head>
<body>
${sections}
</body></html>
`;

writeFileSync(out, html, "utf8");
console.log(`${out}  (${chosen.length} scene${chosen.length === 1 ? "" : "s"}: ${chosen.join(", ")})`);
console.log(`open ${out}`);
await server.close();
