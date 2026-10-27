/**
 * Contrast, computed from the stylesheet rather than asserted by hand.
 *
 * ## Why a measurement and not a number
 *
 * `styles.css` documents a bar for its own text levels — *"two levels, both >= 6:1 on `--bg`"* — and
 * nothing checked it. A hand-written expected ratio would rot the moment a token changed, and would
 * also be a second place holding the same fact.
 *
 * So this parses the tokens and computes WCAG contrast, which makes the claim in that comment
 * falsifiable and turns "this looks a bit dim" into a number.
 *
 * ## The bug that produced it
 *
 * The `auto-follow off` chip was unreadable (#98). `--dim` is 6.15:1 on `--bg`, which is where the
 * bar was measured — but the chip sits on `--panel`, where the same colour is **5.62:1**, and on
 * `--panel-2` under a hover it is **5.17:1**. The ACTIVE state was 11.25:1. So the dimmest text on
 * the bar belonged to the control you need to read in order to operate it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** Every `--name: #rrggbb` in `:root`. */
function tokens() {
  const block = /^:root\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1];
  assert.ok(block, ":root must exist");
  const found = {};
  for (const [, name, hex] of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    found[name] = hex;
  }
  return found;
}

const T = tokens();

/** WCAG relative luminance. */
function luminance(hex) {
  const channels = hex.replace("#", "").match(/../g).map((pair) => parseInt(pair, 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

test("the documented bar for this project's text levels actually holds", () => {
  // `styles.css`: "text — two levels, both >= 6:1 on --bg". A claim in a comment that nothing
  // checked, so it is checked here.
  assert.ok(T["bg"] && T["dim"] && T["text"], "the tokens must be readable");
  assert.ok(contrast(T["dim"], T["bg"]) >= 6, `--dim on --bg is ${contrast(T["dim"], T["bg"]).toFixed(2)}:1`);
  assert.ok(contrast(T["text"], T["bg"]) >= 6, `--text on --bg is ${contrast(T["text"], T["bg"]).toFixed(2)}:1`);
});

test("a control's label is readable where the control actually sits", () => {
  // The general rule the #98 bug broke: measuring a colour on `--bg` says nothing about it on
  // `--panel`, and the chip lives on `--panel`. AA for normal text is 4.5:1, but a CONTROL is
  // something the reader must be able to read in order to operate it, so the project's own 6:1 is
  // the floor here rather than the AA minimum.
  const chip = /\.toggle-chip\s*\{([^}]*)\}/.exec(css);
  assert.ok(chip, ".toggle-chip must have a rule");
  const colour = /color:\s*var\(--([a-z0-9-]+)\)/.exec(chip[1]);
  assert.ok(colour, "the chip must take its colour from a token");

  for (const host of ["panel", "panel-2"]) {
    const ratio = contrast(T[colour[1]], T[host]);
    assert.ok(
      ratio >= 6,
      `the chip label (--${colour[1]}) on --${host} is ${ratio.toFixed(2)}:1, below the 6:1 floor a control must meet`,
    );
  }
});

test("the token that failed is recorded, so the reason does not have to be rediscovered", () => {
  // `--dim` is the obvious choice and the wrong one *here*: it is exactly the kind of value that
  // looks correct on `--bg` and fails one surface over. Pinned as a fact about the palette, so a
  // future "simplification" back to `--dim` fails with the number rather than with a comment.
  assert.ok(
    contrast(T["dim"], T["panel"]) < 6,
    "--dim on --panel is now >= 6:1, which would mean the palette changed and this reasoning should be revisited",
  );
  const chip = /\.toggle-chip\s*\{([^}]*)\}/.exec(css);
  assert.ok(!/color:\s*var\(--dim\)/.test(chip[1]), "the chip must not go back to --dim");
});
