/**
 * The queued prompts: the bound, the summary and the Escape ladder.
 *
 * ## The invariant these exist to hold
 *
 * The composer's dock used to render one row per queued message, so its height was a function of N — and because the
 * transcript's scroller is a flex sibling above it, every queued message re-shrank the conversation. A reader pinned to
 * the tail was moved up the page again for each message they queued. Reported as *"it changes the canvas of the
 * transcript… it pushes the steering line to the top"*.
 *
 * So the rail is bounded by the number of KINDS, never by the number of messages. The bound is arithmetic, which is why
 * it lives here rather than inside a component this repository's tests cannot execute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { escalation, queueRail, queueSummary, railText, type Queued } from "../src/queue.ts";

function queued(steering: string[], followUp: string[], total = steering.length + followUp.length): Queued {
  return { steering, followUp, total, textsKnown: steering.length + followUp.length >= total };
}

const many = (n: number, label: string) => Array.from({ length: n }, (_, i) => `${label} ${i + 1}`);

test("the rail never exceeds two rows, whatever is queued", () => {
  /*
   * The whole fix, asserted directly. Every split, every count from 0 to 50 — because "it only grows a little" was how
   * the old dock behaved, and a bound that holds for small numbers is not a bound.
   */
  for (let total = 0; total <= 50; total += 1) {
    for (let steering = 0; steering <= total; steering += 1) {
      const followUp = total - steering;
      const rail = queueRail(queued(many(steering, "s"), many(followUp, "f")));
      assert.ok(
        rail.rows.length <= 2,
        `${steering} steering + ${followUp} follow-up produced ${rail.rows.length} rows`,
      );
    }
  }
});

test("the rail shows one representative per group, and counts the rest", () => {
  const rail = queueRail(queued(["first", "second", "third"], ["later", "and later"]));
  assert.equal(rail.rows.length, 2);
  assert.deepEqual(
    rail.rows.map((row) => [row.kind, row.when, row.text, row.more]),
    [
      ["steer", "now", "first", 2],
      ["followUp", "then", "later", 1],
    ],
    "steering first, because it happens first",
  );
  assert.equal(rail.total, 5);
});

test("steering is listed before follow-up, because it happens before it", () => {
  // The order IS the meaning, so it must not depend on the order the groups happen to be passed in.
  const rail = queueRail(queued(["s"], ["f"]));
  assert.deepEqual(rail.rows.map((row) => row.when), ["now", "then"]);
});

test("an empty rail is empty, not a row saying nothing", () => {
  const rail = queueRail(queued([], []));
  assert.deepEqual(rail.rows, []);
  assert.equal(rail.total, 0);
  assert.equal(rail.unknownCount, 0);
});

test("texts that never arrived are COUNTED and never invented", () => {
  /*
   * After a reconnect the count is known and the texts are not, because records are not replayed. A placeholder row
   * would be a fabricated claim about what the reader asked for, in the one list whose job is to say what they asked for.
   */
  const rail = queueRail(queued([], [], 3));
  assert.deepEqual(rail.rows, [], "no rows, because there is no text to show");
  assert.equal(rail.unknownCount, 3, "…but the count is reported");
  assert.equal(rail.total, 3);
});

test("a PARTIALLY known queue shows what it knows and names the rest", () => {
  /*
   * The old `textsKnown` flag was all-or-nothing: it reported `false` unless every text was accounted for, and the caller
   * then hid all of them — throwing away the known text. One known message out of three rendered nothing at all.
   */
  const rail = queueRail({ steering: ["known one"], followUp: [], total: 3, textsKnown: false });
  assert.equal(rail.rows.length, 1, "the known message is still shown");
  assert.equal(rail.rows[0]?.text, "known one");
  assert.equal(rail.unknownCount, 2, "…and the remainder is named rather than silently dropped");
});

test("a long message is clipped to one line, and says so", () => {
  const rail = queueRail(queued([`word ${"and more ".repeat(40)}`], []));
  const text = rail.rows[0]?.text ?? "";
  assert.ok(text.length <= 73, `clipped to the cap, got ${text.length}`);
  assert.ok(text.endsWith("\u2026"), "…with the elision marked");
});

test("a multi-line message is flattened for the rail, because a rail row is one line", () => {
  const rail = queueRail(queued(["first line\n\nsecond line"], []));
  assert.equal(rail.rows[0]?.text, "first line second line");
});

test("an empty message is named, not rendered as a gap", () => {
  // A queued message with no text is still a queued message, and a blank row reads as a rendering fault.
  for (const empty of ["", "   ", "\n\n"]) {
    assert.equal(railText(empty), "(empty message)", JSON.stringify(empty));
  }
  const rail = queueRail(queued(["", "  "], []));
  assert.equal(rail.rows[0]?.text, "(empty message)");
});

test("the summary states the arithmetic in words", () => {
  // The confusion being fixed is that readers cannot tell the kinds apart, so the sheet opens by saying how many of each.
  assert.equal(queueSummary(queued(["a"], ["b", "c"])), "1 steers this run; 2 run after it finishes.");
  assert.equal(queueSummary(queued(["a"], [])), "1 steers this run.");
  assert.equal(queueSummary(queued([], ["b"])), "1 runs after it finishes.");
});

test("the summary adds the unknown remainder rather than replacing what is known", () => {
  // What is known is still true and still worth stating.
  const summary = queueSummary({ steering: ["a"], followUp: [], total: 3, textsKnown: false });
  assert.match(summary, /1 steers this run/, "the known part is stated");
  assert.match(summary, /2 more were queued before this page loaded/, "…and the remainder is added");
});

test("an entirely unknown queue says so, and says nothing false", () => {
  const summary = queueSummary(queued([], [], 2));
  assert.match(summary, /2 queued messages/, "the count, which IS known");
  assert.match(summary, /before this page loaded/, "…and why there are no texts");
  assert.ok(!/steers|run after it finishes/.test(summary), "nothing is claimed about kinds nobody can see");
});

test("the Escape ladder is one decision, in the documented order", () => {
  /*
   * `DESIGN.md` §4.3. Step 2 — "a popover is open → close it" — had no subscriber at all before this, so a sheet could
   * only be dismissed with the mouse. It lives here because two components act on Escape (the sheet's host and the
   * composer) and a ladder implemented twice is a ladder that drifts.
   */
  assert.equal(escalation({ sheetOpen: true, streaming: true }), "close-sheet", "the sheet wins over the run");
  assert.equal(escalation({ sheetOpen: true, streaming: false }), "close-sheet");
  assert.equal(escalation({ sheetOpen: false, streaming: true }), "clear-and-stop");
  assert.equal(escalation({ sheetOpen: false, streaming: false }), "noop", "the draft is never touched");
});
