/**
 * The follow-scroll harness stays runnable (ADR-0016).
 *
 * ## Why a test for a review tool
 *
 * This harness exists because two earlier preview pages were broken in ways nobody could see: one had CSS
 * selectors that matched nothing, and one was a static render of a runtime state, so its fades could never
 * appear. Both shipped, and both were reported from use. A review tool that silently stops working is worse
 * than no review tool, because it produces confident silence.
 *
 * So the things that broke are asserted here, cheaply and without starting a server:
 *
 *   1. the config's root is where the entry's relative imports still resolve;
 *   2. the entry exists and imports the REAL component, not a copy;
 *   3. nothing in the harness overrides the transcript's own rules, or the preview stops being a preview;
 *   4. the launcher points at a config that exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const UI = new URL("..", import.meta.url);
const harness = (file) => new URL(`harness/${file}`, UI);
const source = (url) => readFileSync(url, "utf8");

test("the harness serves from packages/ui, so the entry's relative imports resolve", () => {
  /*
   * The bug this catches, measured: with the harness DIRECTORY as root, `main.tsx`'s import of
   * `../src/components/Transcript.tsx` leaves the server's root, and Vite answers it with the SPA fallback — a
   * 583-byte index.html that arrives with HTTP 200 and looks like a module until you read it. The page then
   * renders nothing, with no error anywhere.
   */
  const config = source(harness("vite.config.ts"));
  const root = /root:\s*fileURLToPath\(new URL\("([^"]+)"/.exec(config)?.[1];
  assert.equal(root, "..", "root must be packages/ui, one level above the harness directory");
});

test("the entry mounts the REAL component rather than a stand-in", () => {
  // A harness whose component drifts from the product is a preview of the harness.
  const main = source(harness("main.tsx"));
  assert.match(main, /from "\.\.\/src\/components\/Transcript\.tsx"/, "it imports the real TranscriptView");
  assert.match(main, /from "\.\.\/src\/transcript\.ts"/, "…and the real reducer");
  // A CSS import is a bare `import "…"`, not a `from` clause — the first version of this assertion required
  // `from` and failed on a line that was perfectly correct.
  assert.match(main, /import "\.\.\/src\/styles\.css"/, "…and the real stylesheet");
  assert.ok(
    !/from "\.\/Transcript/.test(main),
    "no local copy of the component: that is how a harness starts agreeing with itself and nothing else",
  );
});

test("the harness stylesheet does NOT override the transcript's own rules", () => {
  /*
   * The whole value of the harness is that it shows the component as shipped. A `.transcript` or `.prose` rule
   * here — even one that only changed a margin — would make it a preview of something else, and the reader would
   * have no way to know which rules they were looking at.
   */
  const css = source(harness("harness.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const selector of [".transcript", ".prose", ".turn", ".transcript-lane", ".composer"]) {
    assert.ok(
      !new RegExp(`(^|[},\\s])${selector.replace(".", "\\.")}\\s*\\{`).test(css),
      `harness.css must not style ${selector}: the component's own rules must be the ones on screen`,
    );
  }
});

test("a launcher exists, and the config it points at is a real file", () => {
  // The launcher is the only documented way in; without this, renaming the config leaves a dead instruction.
  // From packages/ui/test/ the repository root is three levels up, not two: `../..` lands in packages/.
  const launcher = new URL("../../../scripts/serve-follow-harness.mjs", import.meta.url);
  assert.ok(existsSync(launcher), "scripts/serve-follow-harness.mjs must exist");
  const text = source(launcher);
  const config = /--config",\s*"([^"]+)"/.exec(text)?.[1];
  assert.ok(config, "the launcher names the config it serves");
  assert.ok(existsSync(new URL(config, UI)), `the launcher points at ${config}, which must exist`);
});
