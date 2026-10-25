/**
 * Formatting tests.
 *
 * These exist because the rail is scanned rather than read: a formatting bug is not a crash,
 * it is a value that quietly misleads. `$0.0000` for an unknown cost reads as "this turn was
 * free" rather than "the provider did not report it", which is a different fact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayName,
  formatAge,
  formatContext,
  formatCost,
  formatElapsed,
  formatThinking,
  formatTokens,
  shortenPath,
  whereLine,
} from "../src/format.ts";
import type { LiveSession } from "@pi-central/protocol";

function session(over: Partial<LiveSession> = {}): LiveSession {
  return {
    id: "s7",
    name: "s7",
    cwd: "/Users/x/git/project",
    state: "idle",
    mode: "sandboxed",
    isolation: "",
    command: "",
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
  };
}

test("an unknown cost is an em dash, never $0.0000", () => {
  // The distinction between "free" and "not reported" must survive.
  assert.equal(formatCost(null), "—");
  assert.notEqual(formatCost(null), "$0.0000");
});

test("a sub-cent cost keeps four decimals", () => {
  // A single turn often costs less than a cent; $0.00 would hide every one of them.
  assert.equal(formatCost(0.0142), "$0.0142");
  assert.equal(formatCost(0.0001), "$0.0001");
});

test("larger costs use two decimals", () => {
  assert.equal(formatCost(1.4231), "$1.42");
});

test("a genuine zero is shown as $0.00, because zero is a fact", () => {
  assert.equal(formatCost(0), "$0.00");
});

test("NaN and Infinity are treated as unknown", () => {
  assert.equal(formatCost(Number.NaN), "—");
  assert.equal(formatCost(Number.POSITIVE_INFINITY), "—");
});

test("tokens abbreviate at 1000 and a million", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(41234), "41.2k");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(null), "—");
});

test("context pressure is stated in words at 80% and above", () => {
  // Colour alone must never carry this: the number is joined by a word.
  assert.equal(formatContext(62), "ctx 62%");
  assert.equal(formatContext(80), "ctx 80% full");
  assert.equal(formatContext(99), "ctx 99% full");
  assert.equal(formatContext(null), "ctx —");
});

test("thinking level is truncated to three characters", () => {
  assert.equal(formatThinking("medium"), "med");
  assert.equal(formatThinking("high"), "high");
  assert.equal(formatThinking("off"), "off");
  assert.equal(formatThinking(undefined), "—");
});

test("elapsed time is minutes:seconds, then hours", () => {
  const start = 1_000_000;
  assert.equal(formatElapsed(start, start + 34_000), "0:34");
  assert.equal(formatElapsed(start, start + 62_000), "1:02");
  assert.equal(formatElapsed(start, start + 3_723_000), "1:02:03");
});

test("elapsed time never goes negative if the clock is skewed", () => {
  assert.equal(formatElapsed(2_000_000, 1_000_000), "0:00");
});

test("age is coarse: the exact second is never the question", () => {
  const now = 1_000_000_000;
  assert.equal(formatAge(now - 5_000, now), "just now");
  assert.equal(formatAge(now - 120_000, now), "2m ago");
  assert.equal(formatAge(now - 7_200_000, now), "2h ago");
  assert.equal(formatAge(now - 172_800_000, now), "2d ago");
});

test("paths truncate in the middle, keeping the project name", () => {
  // Trailing truncation loses what identifies the directory.
  const long = "/Users/sven1103/git/idea-factory/pi-central/packages/orchestrator";
  const short = shortenPath(long, 34);
  assert.ok(short.length <= 34, short);
  assert.ok(short.includes("…"), short);
  assert.ok(short.startsWith("/Users/sven1103"), `should keep the head: ${short}`);
  assert.ok(short.endsWith("orchestrator"), `should keep the tail: ${short}`);
});

test("paths abbreviate $HOME, which is noise in every row", () => {
  assert.equal(shortenPath("/Users/x/git/p", 40, "/Users/x"), "~/git/p");
});

test("a short path is returned unchanged", () => {
  assert.equal(shortenPath("/tmp/a", 34), "/tmp/a");
});

test("a scratch session gets a label, not a bare id", () => {
  // `s7` tells the reader nothing.
  assert.equal(displayName(session({ scratch: true, name: "s7" })), "Scratch session");
});

test("a named session keeps its name, scratch or not", () => {
  assert.equal(displayName(session({ scratch: true, name: "My question" })), "My question");
  assert.equal(displayName(session({ name: "api-gateway" })), "api-gateway");
});

test("a non-scratch session with a bare-id name keeps it rather than inventing a title", () => {
  assert.equal(displayName(session({ scratch: false, name: "s7" })), "s7");
});

test("scratch sessions hide their internal workspace path", () => {
  // The path is an implementation detail (US-3); it lives in the inspector instead.
  const line = whereLine(session({ scratch: true, cwd: "/Users/x/.local/share/pi-central/workspaces/s7" }));
  assert.equal(line, "scratch · s7");
});

test("a project session shows its shortened path", () => {
  assert.equal(whereLine(session({ cwd: "/Users/x/git/api", scratch: false }), "/Users/x"), "~/git/api");
});
