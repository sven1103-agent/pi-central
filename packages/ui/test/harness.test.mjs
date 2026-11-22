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
 *   4. the launcher points at a config that exists;
 *   5. a busy port relocates, and the launcher reports where it landed rather than predicting it.
 *
 * The fifth is here because the harness failed in exactly that way on its first real use: it picked port 5199,
 * which a running Pi Central already held, refused to start under `strictPort`, and printed a URL that nothing
 * was listening on. Six servers from earlier attempts were also still running — `pkill` and `ps` are both
 * unavailable under this project's sandbox, so they were invisible until `lsof` found them. A review tool that
 * leaks processes and advertises dead URLs is worse than no review tool, because it produces confident silence.
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

test("the harness relocates when its port is busy, and the launcher reports where it landed", () => {
  /*
   * The report: "port 5199 is in use by the production PI Central instance".
   *
   * Three faults were behind one error message:
   *
   *   1. the port was picked from nothing — the app already claims 8787 (orchestrator) and 5173 (UI dev server),
   *      and 5199 was arbitrary enough to hit a running instance;
   *   2. `strictPort: true` turned a collision into a refused start, which is right for the APP (a dev server on a
   *      surprise port breaks its proxy) and wrong for a harness opened by a person;
   *   3. the launcher PRINTED its predicted URL before Vite ran, so it advertised a dead address even when it did
   *      start. A launcher that names a URL must be quoting one that exists.
   */
  const config = source(harness("vite.config.ts"));
  assert.match(
    config,
    /strictPort:\s*false/,
    "a busy port must relocate rather than refuse: this is a harness a person opens, not a proxied dev server",
  );
  const port = /port:\s*(\d+)/.exec(config)?.[1];
  assert.ok(port, "the config names a preferred port");
  assert.ok(
    port !== "8787" && port !== "5173",
    `the harness must not claim the orchestrator (8787) or UI dev server (5173) port; got ${port}`,
  );

  const launcher = source(new URL("../../../scripts/serve-follow-harness.mjs", import.meta.url));
  assert.match(
    launcher,
    /\/Local:\\s\*\(http:/,
    "the launcher PARSES the URL Vite reports; a hardcoded one advertises a port that may have relocated",
  );
  assert.ok(
    !/open\s+http:\/\/127\.0\.0\.1:\d+/.test(launcher),
    "no predicted URL anywhere in the launcher",
  );
  // And it must clean up after itself: six servers outlived their shells before this was added.
  assert.match(launcher, /child\.kill\(/, "the child is taken down explicitly");
  assert.match(launcher, /process\.on\("exit", stop\)/, "…including on a normal exit");
});
test("the harness streams long enough to SCROLL, which is the behaviour it exists to show", () => {
  /*
   * Reported: "we cant observe scrolling, because the test is too short".
   *
   * Correct, and it is the same class of fault as the invisible fades: the harness was rendering something that
   * could not exhibit the property under review. A 1292-character answer is five seconds of streaming, and with a
   * 35vh tail anchor the first screenfuls fill without the tail ever moving off the fold — so the scroll, which
   * is the entire subject, never happened.
   *
   * The threshold is not a frame count but a multiple of a screen: the answer must overflow several, because one
   * screen of overflow is used up by the tail anchor before the newest line moves.
   */
  const main = source(harness("main.tsx"));
  const target = Number(/TARGET_CHARS = (\d+)/.exec(main)?.[1]);
  assert.ok(Number.isFinite(target), "the answer has a declared target length");
  assert.ok(
    target >= 6000,
    `the answer must be several screens tall or following never has to move; target is ${target} characters`,
  );

  /*
   * And it must be built from DIFFERING sections rather than one repeated paragraph. A wall of identical lines
   * would make the bursty mode unrealistically uniform — the clamp exists for bursts of varying height, which is
   * what real prose, lists, fences and tables produce.
   */
  const sections = main.slice(main.indexOf("const SECTIONS"), main.indexOf("const TARGET_CHARS"));
  assert.ok(
    /```/.test(sections),
    "at least one fenced block, so the arrival heights differ rather than every delta being the same size",
  );
  assert.ok(/\| --- \|/.test(sections), "and a table, for the same reason");
  assert.ok(/^- \*\*/m.test(sections) || /^\s+"\d\. \*\*/m.test(sections), "and a list");

  // A speed control, because length and pace pull against each other: 42 seconds at 1x is too long to judge a
  // settle, and the ladder must have no slow end for the same reason.
  assert.match(main, /const SPEEDS = \[/, "the pace is adjustable");
  const speeds = /const SPEEDS = \[([^\]]+)\]/.exec(main)?.[1] ?? "";
  const values = speeds.split(",").map((v) => Number(v.trim()));
  assert.ok(
    values.every((v) => v >= 1),
    `no speed below 1x: half speed on a ${target}-character answer is over a minute, which nobody sits through`,
  );
});
test("the harness offers only arrival rates the product actually produces", () => {
  /*
   * THE CORRECTION THAT ENDED SIX ROUNDS OF DEAD-END TUNING.
   *
   * The harness had four modes: slow, steady, "bursty" (340 chars in ONE frame) and "huge" (2000 chars in one
   * frame). The last two were inventions of the harness. `transport.ts` broadcasts each `record` as it arrives with
   * NO batching, so the arrival rate is Pi\u2019s own token rate — roughly 20-100 tokens/sec, which at about four
   * characters per token is 80-400 chars/sec. Nothing in the product emits a paragraph in one commit.
   *
   * So the scroll curve was tuned, for six rounds, against an arrival pattern that does not exist. Reported
   * plainly: "we have no bursty or huge mode in Pi Central. So we are chasing sth we dont offer."
   *
   * This test holds the lesson: every mode is a RATE, and no mode delivers text in discrete bursts.
   */
  const main = source(harness("main.tsx"));

  const modes = /type Mode = ([^;]+);/.exec(main)?.[1] ?? "";
  assert.ok(modes.length > 0, "the modes are declared");
  for (const invented of ["bursty", "huge"]) {
    assert.ok(
      !modes.includes(invented),
      `"${invented}" was an invented arrival pattern, not a product behaviour — do not reintroduce it`,
    );
  }

  /*
   * And no mode may deliver a BLOCK of text in one frame.
   *
   * A `frame % N === 0` guard is legitimate for a trickle — the slow mode delivers one character every fourth
   * frame, which is a genuine token rate. What is not legitimate is a guard that delivers HUNDREDS of characters
   * at once, because that is the invented burst shape: text appearing in a jump rather than a stream.
   */
  const delta = /function deltaSize\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(main)?.[1] ?? "";
  assert.ok(delta.length > 0, "deltaSize is present");

  // Every literal handed to `scaled(...)` must be a token-sized amount, not a block.
  const amounts = [...delta.matchAll(/scaled\((\d+)\)/g)].map((match) => Number(match[1]));
  assert.ok(amounts.length > 0, "the modes declare their rates");
  for (const amount of amounts) {
    assert.ok(
      amount <= 32,
      `a mode delivers ${amount} characters per frame, which is a block rather than a token stream;` +
        " the product sends text_delta per token, so no mode may exceed ~32 chars (a fast model at 60Hz)",
    );
  }
});
