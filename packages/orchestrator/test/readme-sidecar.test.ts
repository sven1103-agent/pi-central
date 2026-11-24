import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERB_NAMES } from "../src/sidecar-control.ts";

/**
 * The README's session-browser section, held to the code it describes.
 *
 * `/README.md` is the page that decides whether anyone reads the rest, and the section was written as prose
 * that described the feature accurately and interested nobody. It now opens with what the reader gets, shows
 * a diagram, lists the four verbs and states why Playwright's MCP server was not reused.
 *
 * The risk that creates is the ordinary one for prose: a `VERB_NAMES` rename or a fifth verb would leave the
 * README claiming a surface that no longer exists, and nothing would notice. So the claim is asserted against
 * the constant that dispatches the verbs, not against a copy of it.
 *
 * Falsification: remove the `act` row from the table and the first test fails with `act` named. Delete
 * `assets/ui-sidecar.svg` and the second fails. Both are the shape of drift this exists to catch.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

test("every verb the sidecar dispatches has a row in the README's tool table", () => {
  // Scoped to the TABLE, not to the file. The first version of this test asked whether the README mentioned
  // `act` anywhere, and passed with the act row deleted, because the prose below the table names it too — a
  // guard that could not fail for the reason it claimed. The table is what a reader scans for the surface.
  const table = readme.slice(
    readme.indexOf("| Tool | What it answers |"),
    readme.indexOf("```", readme.indexOf("| Tool | What it answers |") + 1),
  );
  assert.ok(table.includes(VERB_NAMES[0]), "precondition: the tool table was found");
  for (const verb of VERB_NAMES) {
    assert.ok(
      table.includes("| **`" + verb + "`** |"),
      "the tool table must have a row for `" + verb + "`, not merely mention it in prose",
    );
  }
});

test("the README's session-browser diagram exists and is a themed, described SVG", () => {
  // The diagram is load-bearing, not decoration: it is the only place the sibling-sandbox shape and the one
  // wire between the two frames are shown rather than described. An <img> pointing at a missing file renders
  // as a broken icon, and an SVG without a <desc> is invisible to a reader who cannot see it.
  const reference = /!\[[\s\S]*?\]\((assets\/ui-sidecar\.svg)\)/.exec(readme);
  assert.ok(reference !== null, "the session-browser section must embed assets/ui-sidecar.svg");
  const path = join(ROOT, "assets", "ui-sidecar.svg");
  assert.ok(existsSync(path), "the embedded diagram must exist");
  const svg = readFileSync(path, "utf8");
  assert.match(svg, /role="img"/, "the diagram must declare itself an image");
  assert.match(svg, /<desc id=/, "and carry a description, which is its alt text for a screen reader");
  assert.match(svg, /prefers-color-scheme/, "and follow the reader's theme, like the architecture diagram");
});

test("the README states why Playwright's MCP server was not reused", () => {
  // The question arrives in the same form every time. The section answers it with the measurement that
  // decided it, so a reader does not have to open an ADR to find out that the answer is not "we did not
  // know about it".
  const section = readme.slice(
    readme.indexOf("Why not just run Playwright's MCP server?"),
    readme.indexOf("### What it is not"),
  );
  assert.ok(section.length > 200, "the section must exist and have substance");
  for (const evidence of ["browser_evaluate", "tools/call", "no auth header"]) {
    assert.ok(
      section.toLowerCase().includes(evidence.toLowerCase()),
      "the answer must cite " + JSON.stringify(evidence) + ", which is what makes it a measurement",
    );
  }
});
