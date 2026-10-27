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
import { readdirSync, readFileSync } from "node:fs";

/**
 * Comments removed before any rule is matched.
 *
 * Not tidiness — this is the FIFTH time in this repository that a text-scanning assertion has been
 * satisfied by its own documentation: a release-workflow check matched its own docs, a scroll guard
 * matched `key={focused?.id}` in a comment, a CSS guard matched `scroll-behavior: smooth` inside the
 * comment explaining its removal, a component guard matched `auto-follow on` in its docstring, and
 * the `color-scheme` assertion below matched the comment that documents it — so removing the
 * declaration left the test green.
 *
 * Comments are not code. Strip them before matching, always.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

const css = stripComments(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"));

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

test("every control declares its own appearance, so it cannot inherit the platform's", () => {
  // The audit, and it is an audit because the failure was an OMISSION (issue #100). Per-class
  // assertions cannot catch "nobody wrote this declaration", and that is exactly what happened:
  // `.toggle-chip` declared neither a background nor a font, so the auto-follow toggle rendered as
  // the platform's LIGHT button face with near-white text on it.
  //
  // Only classes used ALONE are held to this. A class that always composes with another (`btn
  // btn-danger`) legitimately takes part of its appearance from its partner; a class used by itself
  // has nobody else to take it from.
  const components = readdirSync(new URL("../src/components", import.meta.url))
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => readFileSync(new URL(`../src/components/${name}`, import.meta.url), "utf8"));

  const alone = new Set();
  for (const source of components) {
    for (const [, value] of source.matchAll(/<button[^>]*className="([^"{}]+)"/gs)) {
      const classes = value.trim().split(/\s+/);
      if (classes.length === 1) alone.add(classes[0]);
    }
  }
  assert.ok(alone.size > 0, "the scan must find at least one single-class button");

  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);

  for (const cls of alone) {
    const body = rules.find(([selector]) => selector === `.${cls}`)?.[1];
    assert.ok(body, `.${cls} is used alone on a <button> and must have a base rule of its own`);
    assert.match(body, /(?<!-)background(-color)?\s*:/, `.${cls} must declare a background, or it inherits the platform's`);
    assert.match(body, /(?<!-)font(-family|-size)?\s*:/, `.${cls} must declare a font, or it inherits the platform's`);
  }
});

test("the page tells the platform it is dark", () => {
  // `color-scheme` decides everything the theme does not draw: default button faces, scrollbars, form
  // controls. Without it they render LIGHT on a dark page — which is how a chip with no background of
  // its own became invisible.
  const root = /^:root\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1];
  assert.ok(root, ":root must exist");
  assert.match(root, /color-scheme:\s*dark/, "the platform must be told, or its chrome is light");
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
