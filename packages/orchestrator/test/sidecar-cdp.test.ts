import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The CDP driver (ADR-0015 §4), asserted on its SOURCE TEXT rather than on a run.
 *
 * Why static: the browser half needs a browser and CI has none — that half is the spike harness
 * (spikes/ui-sidecar/harness/cdp-shot.mjs) from a plain terminal, the `verified/manual` row of ADR-0015
 * §Verification. What can be asserted everywhere is the property that makes the driver safe:
 * **no caller input is ever interpolated into a CDP expression, and no public method accepts a script.**
 *
 * Worth having because it is the one defect that would silently turn shape C into shape B. The MCP server
 * was rejected for exposing `browser_evaluate`; a driver that concatenated an expression, or took a
 * `script` parameter, would be the same capability with a smaller vocabulary — and no behavioural test
 * would notice, because the happy path is identical.
 */

const SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "sidecar-cdp.ts"), "utf8");
const BACKTICK = String.fromCharCode(96);

/** Strip comments so an assertion cannot fire on the prose explaining it (C20's trap). */
/** A capture group that cannot be undefined, with the assertion that makes it true. */
function group(match: RegExpMatchArray | RegExpExecArray, index = 1): string {
  const value = match[index];
  assert.ok(value !== undefined, "the match must have capture group " + index);
  return value;
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n");
}

test("the fixed batteries are template constants", () => {
  const code = codeOnly(SOURCE);
  for (const name of ["VIEWPORT_EXPRESSION", "OVERFLOW_EXPRESSION", "CONTRAST_EXPRESSION", "OVERLAP_EXPRESSION", "LOCATE_FUNCTION"]) {
    assert.ok(code.includes("const " + name + " = " + BACKTICK), name + " must be a template constant");
  }
});

test("no template constant interpolates a caller value", () => {
  const code = codeOnly(SOURCE);
  const callerNames = ["selector", "url", "checks", "clip", "viewport", "expression", "method", "script"];
  for (const body of [...code.matchAll(/const [A-Z][A-Z_]+ = `/g)].map((m) => m.index ?? 0)) {
    const rest = code.slice(body);
    const declaration = rest.slice(0, rest.indexOf(BACKTICK + ";"));
    for (const name of callerNames) {
      assert.ok(!declaration.includes("${" + name + "}"), "a battery must not interpolate " + name);
    }
  }
});

test("every expression value is a constant or a literal, never a concatenation", () => {
  const code = codeOnly(SOURCE);
  const values = [...code.matchAll(/^\s*expression:\s*([^\n]+)/gm)]
    .map((m) => group(m).trim().replace(/,$/, ""))
    .filter((value) => !value.startsWith("string"));
  assert.ok(values.length >= 1, "the driver must issue at least one evaluation (precondition)");
  for (const value of values) {
    assert.ok(!value.includes(" + "), "an expression must never be concatenated: " + value);
  }
});

test("the only caller value that reaches a page arrives as an argument", () => {
  const code = codeOnly(SOURCE);
  assert.match(code, /arguments:\s*\[\{\s*value:\s*selector\s*\}\]/);
  assert.match(code, /functionDeclaration:\s*LOCATE_FUNCTION/);
  assert.ok(code.includes("const LOCATE_FUNCTION = " + BACKTICK + "function (selector)"));
});

test("the driver exposes no public method that takes a CDP method name", () => {
  const code = codeOnly(SOURCE);
  const allowed = ["open", "setViewport", "navigate", "capture", "probe", "click", "close"];
  const exposed = [...code.matchAll(/^\s{2}(?:static\s+)?(?:async\s+)?([a-zA-Z]+)\(/gm)].map((m) => group(m));
  for (const name of exposed) assert.ok(allowed.includes(name), "unexpected public method " + name);
  const calls = [...code.matchAll(/this\.#call\(\s*([^,\n)]+)/g)].map((m) => group(m).trim());
  assert.ok(calls.length >= 5, "the driver must issue CDP calls (precondition)");
  for (const value of calls) {
    assert.match(value, /^"[A-Za-z.]+"$/, "#call must take a literal method, found " + value);
  }
});

test("no public method accepts a script, expression, code, or method parameter", () => {
  const code = codeOnly(SOURCE);
  // The guard the module docblock claims and that nothing enforced. Adding `script?: string` to `probe`
  // compiled, passed every other check here, and is browser_evaluate by another name — found by adding
  // exactly that parameter and watching the whole suite stay green.
  const forbidden = ["script", "expression", "code", "method", "cdp", "evaluate"];
  const signatures = [...code.matchAll(/^\s{2}(?:static\s+)?(?:async\s+)?[a-zA-Z]+\(([^)]*)\)/gm)].map((m) => group(m));
  assert.ok(signatures.length >= 6, "the driver must declare its public methods (precondition)");
  for (const signature of signatures) {
    for (const name of forbidden) {
      assert.ok(
        !new RegExp("(^|[,\\s])" + name + "\\s*\\??:").test(signature),
        "no public method may take a " + name + " parameter; found: " + signature.trim(),
      );
    }
  }
  // And the evaluator is only ever handed a constant, at every call site.
  const evalCalls = [...code.matchAll(/this\.#evaluate\(\s*([^)]*)\)/g)].map((m) => group(m).trim());
  assert.ok(evalCalls.length >= 4, "the batteries must be evaluated (precondition)");
  for (const value of evalCalls) {
    assert.match(value, /^[A-Z][A-Z_]+$/, "the evaluator must receive a constant, found: " + value);
  }
});

test("the driver never handles a filesystem path", () => {
  const code = codeOnly(SOURCE);
  for (const forbidden of ["writeFileSync", "createWriteStream", "node:fs", "node:path"]) {
    assert.ok(!code.includes(forbidden), "the driver must not handle paths, found " + forbidden);
  }
});
