import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideTarget,
  parseVerb,
  PROBE_CHECKS,
  VERB_NAMES,
} from "../src/sidecar-control.ts";

/**
 * The sidecar's two boundary decisions (ADR-0015 §2, §7, §8). Pure: no browser, no socket.
 *
 * **What would make each test pass with the defect present** is named above the assertion it protects.
 * These are the checks an adversarial client tries first, so a test that only exercises the happy path
 * would be evidence of nothing.
 */

const registered = new Set(["http://localhost:4173"]);

test("a registered loopback origin is allowed", () => {
  const decision = decideTarget("http://localhost:4173/", registered);
  assert.equal(decision.kind, "allowed");
  if (decision.kind === "allowed") assert.equal(decision.origin, "http://localhost:4173");
});

test("file:, chrome:, data: and javascript: are refused before the origin is even consulted", () => {
  // A prefix-based implementation would allow these; a scheme check refuses them. `file:` reads the disk
  // as the user and `javascript:` executes in an origin the design calls inert.
  for (const url of ["file:///etc/passwd", "chrome://settings", "data:text/html,<b>x", "javascript:alert(1)"]) {
    const decision = decideTarget(url, registered);
    assert.equal(decision.kind, "refused", `${url} must be refused`);
    if (decision.kind === "refused") assert.equal(decision.reason, "scheme-not-allowed", url);
  }
});

test("a non-loopback host is refused even on the right port, by the LOOPBACK check", () => {
  // Asserting only `refused` was not enough: with the loopback check removed, the origin comparison below
  // still refuses these (example.com:4173 is not a registered origin), so the test passed with the guard
  // gone. The reason is the assertion that has teeth.
  for (const url of ["http://example.com:4173/", "http://192.168.1.9:4173/", "http://[2001:db8::1]:4173/"]) {
    const decision = decideTarget(url, registered);
    assert.equal(decision.kind, "refused", `${url} must be refused`);
    if (decision.kind === "refused") assert.equal(decision.reason, "not-loopback", url);
  }
});

test("a registered origin cannot vouch for a longer loopback URL that merely starts with it", () => {
  // The one case where the ORIGIN comparison is the only thing deciding, and therefore the only case that
  // distinguishes `parsed.origin` from a string prefix. Everything else is caught by the loopback check
  // first, which is why breaking the comparison to a prefix left every other test green.
  //
  // Userinfo keeps the host loopback (`localhost`) while making the text start with the allowed origin:
  // "http://localhost:4173@localhost:9999/" is a URL for host localhost port 9999.
  const raw = "http://localhost:4173@localhost:9999/";
  assert.equal(new URL(raw).origin, "http://localhost:9999", "precondition: a different origin");
  assert.ok(raw.startsWith("http://localhost:4173"), "precondition: the text starts with the allowed one");

  const decision = decideTarget(raw, registered);
  assert.equal(decision.kind, "refused");
  if (decision.kind === "refused") assert.equal(decision.reason, "origin-not-registered");
});

test("a loopback host on an unregistered port is refused by the ORIGIN check", () => {
  // The defect this catches: allowing every loopback origin, which would let the renderer reach the
  // orchestrator's control socket -- measured to be on loopback too (Phase 0), and unauthenticated.
  const decision = decideTarget("http://localhost:8931/mcp", registered);
  assert.equal(decision.kind, "refused");
  if (decision.kind === "refused") assert.equal(decision.reason, "origin-not-registered");
});

test("a host whose TEXT starts with a registered origin is refused, and by the ORIGIN check", () => {
  // The exact defect a string-prefix check has. The first version of this test used
  // "http://localhost:4173.evil.com/", which is not a valid URL at all (`4173.evil.com` cannot be a port),
  // so the refusal arrived from the malformed-URL branch and the test passed with a prefix check in place —
  // unguarded, and discovered only by breaking the implementation deliberately.
  //
  // A userinfo segment is valid URL syntax and DOES start with the allowed string:
  const raw = "http://localhost:4173@evil.com/";
  assert.ok(new URL(raw).origin === "http://evil.com", "precondition: the origin is evil.com");
  assert.ok(raw.startsWith("http://localhost:4173"), "precondition: the text starts with the allowed origin");

  const decision = decideTarget(raw, registered);
  assert.equal(decision.kind, "refused");
  if (decision.kind === "refused") {
    // Not merely refused — refused for the right reason. A prefix check would let it through to the origin
    // comparison and also refuse it, so the reason is what distinguishes the two implementations.
    assert.equal(decision.reason, "not-loopback", "evil.com is a host, not a loopback origin");
  }
});

test("a malformed URL is a refusal, not a crash", () => {
  const decision = decideTarget("not a url", registered);
  assert.equal(decision.kind, "refused");
  if (decision.kind === "refused") assert.equal(decision.reason, "bad-argument");
});

test("the verb set is closed and an unknown name is refused with the list", () => {
  // Includes the shapes an MCP client sends for a CDP escape: a method name, a script, an expression.
  for (const name of ["evaluate", "Runtime.evaluate", "run_code", "cdp", "screenshot"]) {
    const parsed = parseVerb(name, {});
    assert.equal(parsed.kind, "refused", `${name} must be refused`);
    if (parsed.kind === "refused") {
      assert.equal(parsed.reason, "unknown-verb");
      assert.match(parsed.message, /capture, probe, act, info/, "the refusal must name what exists");
    }
  }
});

test("no verb accepts a field through which a CDP method or a script could be smuggled", () => {
  // The one that decides whether C is C or B wearing a hat. Each of these is a real field name on some
  // browser-automation API; all of them must be rejected as unknown arguments.
  const smuggled = ["method", "script", "expression", "code", "cdp", "evaluate", "fn", "body"];
  for (const field of smuggled) {
    const parsed = parseVerb("capture", { url: "http://localhost:4173/", [field]: "1+1" });
    assert.equal(parsed.kind, "refused", `capture must reject ${field}`);
    if (parsed.kind === "refused") {
      assert.equal(parsed.reason, "bad-argument");
      assert.match(parsed.message, new RegExp(field), "the refusal must name the offending key");
    }
  }
});

test("probe takes a choice of checks, never an assertion to run", () => {
  const ok = parseVerb("probe", { url: "http://localhost:4173/", checks: ["overflow"] });
  assert.equal(ok.kind, "ok");
  if (ok.kind === "ok" && ok.verb.kind === "probe") assert.deepEqual(ok.verb.checks, ["overflow"]);

  // A check name that is not in the battery is refused, so the agent cannot invent one.
  for (const bad of [["custom"], ["overflow; process.exit(1)"], "overflow", [1]]) {
    const parsed = parseVerb("probe", { url: "http://localhost:4173/", checks: bad });
    assert.equal(parsed.kind, "refused", `checks ${JSON.stringify(bad)} must be refused`);
  }
});

test("probe defaults to the full fixed battery", () => {
  const parsed = parseVerb("probe", { url: "http://localhost:4173/" });
  assert.equal(parsed.kind, "ok");
  if (parsed.kind === "ok" && parsed.verb.kind === "probe") {
    assert.deepEqual(parsed.verb.checks, PROBE_CHECKS);
    assert.deepEqual(parsed.verb.viewport, { width: 1280, height: 800 });
  }
});

test("a viewport that is not a positive rectangle is refused", () => {
  for (const viewport of [{ width: 0, height: 800 }, { width: 800 }, { width: -1, height: 10 }, "big"]) {
    const parsed = parseVerb("probe", { url: "http://localhost:4173/", viewport });
    assert.equal(parsed.kind, "refused", JSON.stringify(viewport));
  }
});

test("capture returns a clip only when asked, and refuses a degenerate one", () => {
  const plain = parseVerb("capture", { url: "http://localhost:4173/" });
  assert.equal(plain.kind, "ok");
  if (plain.kind === "ok" && plain.verb.kind === "capture") {
    assert.equal(plain.verb.clip, undefined);
    assert.equal(plain.verb.fullPage, false);
  }

  const clipped = parseVerb("capture", {
    url: "http://localhost:4173/",
    clip: { x: 10, y: 20, width: 100, height: 50 },
  });
  assert.equal(clipped.kind, "ok");

  for (const clip of [{ width: 0, height: 10 }, { width: 10 }, "100x50"]) {
    const parsed = parseVerb("capture", { url: "http://localhost:4173/", clip });
    assert.equal(parsed.kind, "refused", JSON.stringify(clip));
  }
});

test("every verb name in the union is accepted", () => {
  // Ties the closed set to the parser: adding a name to VERB_NAMES without a case fails here.
  const args: Record<string, Record<string, unknown>> = {
    capture: { url: "http://localhost:4173/" },
    probe: { url: "http://localhost:4173/" },
    info: {},
    act: { url: "http://localhost:4173/", clickSelector: "#save" },
  };
  for (const name of VERB_NAMES) {
    assert.equal(parseVerb(name, args[name] ?? {}).kind, "ok", `${name} must parse`);
  }
  assert.deepEqual(VERB_NAMES.length, 4, "a fifth verb is an ADR amendment, not a code change");
});
