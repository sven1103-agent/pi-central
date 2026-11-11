/**
 * Reading Pi's stats, and not asking it more often than the answer can change.
 *
 * ## The defect these cover
 *
 * Stats were fetched only when a run SETTLED, so a session given a complex task showed `ctx —`, no
 * rail bar and no cost until it finished — the numbers the reader uses to decide whether to compact
 * were absent for exactly as long as a run is expensive. The fix is a refresh per turn (`state.ts`,
 * tested there); this file covers the two halves that a per-turn cadence newly makes load-bearing:
 *
 *   1. the payload is untrusted and `null` means "unmeasured", never `0` — a fabricated zero would
 *      draw an empty meter over a session that may be nearly full;
 *   2. refreshes overlap once they are frequent, so a slow Pi must not accumulate one 20s-timeout
 *      promise per turn, and the last number on screen must still be the newest answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LiveSession } from "@pi-central/protocol";
import { RefreshCoalescer, applyStats, readStats } from "../src/stats.ts";

const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  id: "s1",
  name: "test",
  cwd: "/tmp",
  state: "streaming",
  mode: "sandboxed",
  isolation: "test",
  command: "safehouse -- pi --mode rpc",
  scratch: false,
  messageCount: 0,
  pending: 0,
  contextPercent: null,
  tokensTotal: null,
  cost: null,
  dialogs: [],
  warnings: [],
  startedAt: 0,
  ...over,
});

// --- The payload is untrusted, and absent is not zero ---------------------------------------------

test("a full stats answer is read as reported", () => {
  // The shape from Pi's docs (`rpc-commands.md`), which is what the meter and the panel display.
  const stats = readStats({
    tokens: { input: 50_000, output: 10_000, cacheRead: 40_000, cacheWrite: 5_000, total: 105_000 },
    cost: 0.45,
    contextUsage: { tokens: 60_000, contextWindow: 200_000, percent: 30 },
  });
  assert.deepEqual(stats, { contextPercent: 30, tokensTotal: 105_000, cost: 0.45 });
});

test("an absent contextUsage is unreported, never a 0% meter", () => {
  // Pi omits `contextUsage` when no model or context window is available. Rendering 0 would state that
  // the whole window is free — the fabricated zero `ContextMeter.tsx` exists to refuse.
  const stats = readStats({ tokens: { total: 12 }, cost: 0.01 });
  assert.equal(stats.contextPercent, null);
  assert.equal(stats.tokensTotal, 12, "the other numbers are still real");
});

test("a null percent right after compaction stays null, and does not become 0", () => {
  // Pi sets `contextUsage.percent` to `null` between a compaction and the next assistant response,
  // because the count genuinely is unknown then. This is the case a `?? 0` would silently break.
  assert.equal(readStats({ contextUsage: { contextWindow: 200_000, percent: null } }).contextPercent, null);
});

test("a non-numeric or non-finite value is null rather than NaN on screen", () => {
  // Everything from the child process is untrusted, and `formatContext(NaN)` and a NaN-wide bar are both
  // worse than an em dash.
  assert.deepEqual(readStats({ contextUsage: { percent: "30" }, tokens: { total: "12" }, cost: "0.4" }), {
    contextPercent: null,
    tokensTotal: null,
    cost: null,
  });
  assert.equal(readStats({ contextUsage: { percent: Number.POSITIVE_INFINITY } }).contextPercent, null);
  assert.equal(readStats({ cost: Number.NaN }).cost, null);
});

test("garbage does not throw, because stats must never fail a session", () => {
  for (const value of [undefined, null, 42, "nope", [], { tokens: null }, { contextUsage: "x" }]) {
    assert.deepEqual(readStats(value), { contextPercent: null, tokensTotal: null, cost: null });
  }
});

test("a genuine 0% IS reported, because zero is a real measurement after the first turn", () => {
  // The distinction the whole `null` handling rests on: `null` is unmeasured, `0` is measured and empty.
  // Collapsing them in either direction makes one of the two lie.
  assert.equal(readStats({ contextUsage: { percent: 0 } }).contextPercent, 0);
});

test("applying a reading replaces all three values, including back to null", () => {
  // A compaction can make the percentage unreported again, so the apply must not preserve the old value.
  const live = session({ contextPercent: 84, tokensTotal: 105_000, cost: 0.45 });
  applyStats(live, { contextPercent: null, tokensTotal: 12, cost: 0 });
  assert.equal(live.contextPercent, null);
  assert.equal(live.tokensTotal, 12);
  assert.equal(live.cost, 0);
});

// --- Coalescing: one question in flight, and the newest answer wins ------------------------------

test("a refresh that arrives during one in flight does NOT start a second concurrent one", async () => {
  // Without this, a per-turn cadence means a slow Pi accumulates one 20s-deadline promise per turn.
  const coalescer = new RefreshCoalescer();
  let running = 0;
  let peak = 0;
  const refresh = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
  };

  await Promise.all([
    coalescer.run("s1", refresh),
    coalescer.run("s1", refresh),
    coalescer.run("s1", refresh),
  ]);
  assert.equal(peak, 1, "never more than one ask in flight for a session");
});

test("the ask that arrived during the flight still gets a fresh answer", async () => {
  // Dropping it instead would leave the meter showing the answer as of BEFORE the turn that finished
  // while it was in flight — the stale number the per-turn refresh exists to remove.
  const coalescer = new RefreshCoalescer();
  const answers: number[] = [];
  let generation = 0;
  const refresh = async () => {
    const mine = ++generation;
    await new Promise((resolve) => setTimeout(resolve, 10));
    answers.push(mine);
  };

  // Two asks: the first starts, the second must cause ONE more run afterwards.
  await coalescer.run("s1", refresh);
  const both = Promise.all([coalescer.run("s1", refresh), coalescer.run("s1", refresh)]);
  await both;
  // 1st call: one run (generation 1). 2nd+3rd: one run in flight (generation 2) plus ONE merged follow-up (3).
  assert.deepEqual(answers, [1, 2, 3]);
});

test("sessions are independent: one session's slow refresh does not defer another's", async () => {
  const coalescer = new RefreshCoalescer();
  const order: string[] = [];
  const slow = () =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push("slow");
        resolve();
      }, 30),
    );
  const fast = async () => {
    order.push("fast");
  };

  const first = coalescer.run("s1", slow);
  await coalescer.run("s2", fast);
  assert.deepEqual(order, ["fast"], "the second session answered while the first was still out");
  await first;
});

test("a throwing refresh releases the key, so the next record is not silently dropped", async () => {
  // `#refreshStats` catches its own send failure, but a bug in the apply must not wedge the session's
  // refresh forever: the map would still say "in flight" and every later turn would be skipped.
  const coalescer = new RefreshCoalescer();
  let calls = 0;
  await assert.rejects(() =>
    coalescer.run("s1", async () => {
      calls += 1;
      throw new Error("boom");
    }),
  );
  assert.equal(coalescer.busy("s1"), false, "the key must not stay claimed");
  await coalescer.run("s1", async () => {
    calls += 1;
  });
  assert.equal(calls, 2);
});
