/**
 * The wire surface changes only with a version bump.
 *
 * ## The defect this exists to prevent
 *
 * Issue #8 added five wire kinds (`listFiles`, `readFile`, `files`, `file`, `fileError`) and left
 * `PROTOCOL_VERSION` at `1`. The handshake therefore **lied**: the new UI and the previous
 * orchestrator both announced v1, `hello` agreed, and the failure surfaced only when the user
 * expanded a directory — as
 *
 *     bad control: unknown kind 'listFiles'
 *
 * which names the symptom produced by a version skew that the version check was supposed to catch.
 * Adding a kind is exactly what the handshake is for, and it is precisely the case where nobody
 * thinks to bump the number.
 *
 * ## Why the check is not "did we remember to bump"
 *
 * A test cannot know intent, so it pins the surface instead: **if the set of kinds changes, this
 * fails**, and the fix is to bump `PROTOCOL_VERSION` and record the new surface. The version and the
 * surface are asserted against each other in BOTH directions, so neither can move alone —
 * bumping without adding a kind fails too, which is what stops a version number from drifting up
 * for no reason.
 *
 * ## What this does NOT cover, stated rather than implied
 *
 * The fingerprint is the set of **kinds**. A field added, removed, or made required on an EXISTING
 * kind is not detected here. That is a real gap and it is tolerable for a narrow reason: an unknown
 * field is ignored by the receiver, so an old orchestrator tolerates a new optional field. A newly
 * REQUIRED field is genuinely breaking and a reviewer has to catch it. Widening this to a hash of
 * the union bodies would catch it, at the cost of failing on comments and formatting, which trains
 * people to regenerate the fixture without reading it — worse than the gap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../src/envelopes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const envelopes = readFileSync(resolve(here, "..", "src", "envelopes.ts"), "utf8");
const recorded = JSON.parse(readFileSync(resolve(here, "wire-surface.json"), "utf8")) as {
  version: number;
  control: string[];
  event: string[];
};

/**
 * The body of one exported union, from its declaration to the next top-level `export`.
 *
 * Bounded by the NEXT EXPORT rather than by a line number, so it survives edits above it. That
 * matters here concretely: `FileEntry` sits between `Event` and `PROTOCOL_VERSION` and declares
 * `kind: "file" | "directory" | …`, so a slice that ran too far would read a directory entry's type
 * as if it were an event kind.
 */
function unionBody(name: string): string {
  const start = envelopes.indexOf(`export type ${name} =`);
  assert.ok(start >= 0, `no \`export type ${name}\` in envelopes.ts — did it get renamed?`);
  const end = envelopes.indexOf("\nexport ", start + 1);
  return envelopes.slice(start, end < 0 ? envelopes.length : end);
}

/**
 * Every `kind: "…"` literal at the TOP of a union arm, sorted. Sorted because ORDER is not the
 * contract.
 *
 * Anchored to a line that begins an arm (`| {` or `{`), because a union's arms may declare **nested**
 * discriminated payloads — `file` carries `content: { kind: "text" } | { kind: "image" }` (issue #106)
 * — and a bare scan would read those inner tags as top-level event kinds. Found exactly that way: the
 * fingerprint reported two new kinds called `text` and `image`, which are payload discriminants rather
 * than wire kinds.
 */
function kindsOf(name: string): string[] {
  const body = unionBody(name);
  // Split on ARM BOUNDARIES (a leading `|` at the union's own indentation), then take the FIRST
  // `kind:` in each arm. That is robust to arms written inline (`| { kind: "list" }`) and to arms
  // written across lines, and it cannot pick up a NESTED discriminant — `file` carries
  // `content: { kind: "text" } | { kind: "image" }` (issue #106), whose tags are payload shapes, not
  // wire kinds.
  //
  // Two earlier attempts failed and both were caught: a bare scan reported `text`/`image` as new
  // kinds, and a line-anchored pattern found ZERO arms because most are inline. So there is an
  // assertion below that the arms found account for every `kind:` literal outside nested braces.
  const arms = body
    .split(/^\s{2}\|/m)
    .slice(1)
    .map((chunk) => /kind:\s*"([^"]+)"/.exec(chunk)?.[1])
    .filter((kind): kind is string => kind !== undefined);

  assert.ok(
    arms.length > 0 && arms.length === new Set(arms).size,
    `the union parser found ${arms.length} arms (${new Set(arms).size} distinct) — it may be misreading the union`,
  );
  return arms.sort();
}

/** The message a developer needs, including the fixture to paste. */
function drift(name: "control" | "event", actual: string[]): string {
  return (
    `the ${name} wire surface changed.\n\n` +
    `  recorded: ${JSON.stringify(recorded[name])}\n` +
    `  actual:   ${JSON.stringify(actual)}\n\n` +
    `If this is deliberate, the change is a protocol change: bump PROTOCOL_VERSION in\n` +
    `src/envelopes.ts and record the new surface in test/wire-surface.json, so an old peer\n` +
    `is REFUSED at the handshake instead of failing later on an unknown kind.`
  );
}

test("every wire kind is recorded, so a new one cannot skip the version bump", () => {
  const control = kindsOf("Control");
  const event = kindsOf("Event");
  assert.deepEqual(control, recorded.control, drift("control", control));
  assert.deepEqual(event, recorded.event, drift("event", event));
});

test("the recorded surface and PROTOCOL_VERSION move together, in either direction", () => {
  // Asserted both ways. If only the kinds were checked, a version could be bumped for no reason and
  // nothing would notice; if only the version were checked, a kind could be added silently — which
  // is the bug this file was written for.
  assert.equal(
    PROTOCOL_VERSION,
    recorded.version,
    `PROTOCOL_VERSION is ${PROTOCOL_VERSION} but the recorded surface is version ${recorded.version}. ` +
      `A version number that changes without the surface (or the reverse) means the handshake and the wire disagree.`,
  );
});

test("the two unions are actually found, so a rename cannot make this vacuous", () => {
  // `unionBody` asserts on a MISSING union, but an empty or renamed-but-still-present union would
  // otherwise yield an empty kind list that compares equal to nothing meaningful. Pinned here because
  // a guard test that silently stops guarding is worse than no guard — it reads as protection.
  assert.ok(recorded.control.length > 10, "the control union should not be nearly empty");
  assert.ok(recorded.event.length > 10, "the event union should not be nearly empty");
  assert.ok(kindsOf("Control").includes("listFiles"), "issue #8's kinds must be in the surface");
  assert.ok(kindsOf("Event").includes("fileError"), "issue #8's kinds must be in the surface");
});
