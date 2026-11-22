import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, toolDefinitions } from "../src/sidecar.ts";
import { PROBE_CHECKS, VERB_NAMES } from "../src/sidecar-control.ts";

/**
 * The sidecar's transport layer (ADR-0015). Pure: `handleRequest` is given a page thunk, so a test can
 * assert what the transport does WITHOUT a browser — which is the point of splitting it from the driver.
 *
 * The significant assertions are the negatives: `info` must not launch, and a refused target must not
 * launch either. A transport that starts a 200 MB process to answer "what do you serve?" or to refuse a
 * URL is a transport that can be made to spend resources by asking it for nothing.
 */

/**
 * The first TEXT block of a result.
 *
 * Narrowing rather than casting: `capture` now returns an IMAGE block followed by text, and a test that
 * assumed text would silently read undefined from a perfectly good result. Making the union explicit is what
 * forces each test to say which block it means.
 */
function firstText(result: { content: { type: string }[] }): string {
  const block = result.content.find((entry) => entry.type === "text") as { text?: string } | undefined;
  return block?.text ?? "";
}

const config = { executable: "/nonexistent/chrome", profileDir: "/nonexistent/profile", origin: "http://localhost:4173" };

/** A page thunk that records whether it was called, and fails loudly if the transport reaches for it. */
function pageGate(): { page: () => Promise<never>; called: () => boolean } {
  let called = false;
  return {
    page: async () => {
      called = true;
      throw new Error("the transport reached for a browser when it should not have");
    },
    called: () => called,
  };
}

test("the tool list is exactly the closed verb set", () => {
  const names = toolDefinitions().map((tool) => tool.name).sort();
  assert.deepEqual(names, [...VERB_NAMES].sort(), "a tool without a verb is a verb by another name");
});

test("the probe schema advertises a closed enum of checks, not free text", () => {
  // A free-text field would let a model propose an assertion; the enum is what makes "the agent chooses
  // WHICH checks, never authors one" true of the schema as well as of the parser.
  const probe = toolDefinitions().find((tool) => tool.name === "probe");
  assert.ok(probe !== undefined);
  const properties = probe.inputSchema["properties"] as Record<string, { items?: { enum?: string[] } }>;
  assert.deepEqual(properties["checks"]?.items?.enum, [...PROBE_CHECKS]);
});

test("info answers without launching a browser", () => {
  const gate = pageGate();
  return handleRequest(config, gate.page, "info", {}).then((result) => {
    assert.equal(gate.called(), false, "info must not spend a browser process to report a constant");
    const body = JSON.parse(firstText(result)) as { origin?: string; verbs?: string[] };
    assert.equal(body.origin, config.origin);
    assert.deepEqual(body.verbs, [...VERB_NAMES]);
  });
});

test("a refused target answers without launching a browser", async () => {
  for (const url of ["file:///etc/passwd", "http://localhost:9999/", "https://example.com/"]) {
    const gate = pageGate();
    const result = await handleRequest(config, gate.page, "capture", { url });
    assert.equal(gate.called(), false, `${url} must be refused before any browser work`);
    const body = JSON.parse(firstText(result)) as { kind?: string };
    assert.equal(body.kind, "refused", url);
  }
});

test("an unknown verb is refused and does not launch", async () => {
  const gate = pageGate();
  const result = await handleRequest(config, gate.page, "browser_evaluate", { expression: "1+1" });
  assert.equal(gate.called(), false);
  const body = JSON.parse(firstText(result)) as { kind?: string; reason?: string };
  assert.equal(body.kind, "refused");
  assert.equal(body.reason, "unknown-verb");
});

test("a verb carrying a smuggled CDP field is refused before the browser", async () => {
  const gate = pageGate();
  const result = await handleRequest(config, gate.page, "capture", {
    url: config.origin,
    method: "Runtime.evaluate",
  });
  assert.equal(gate.called(), false);
  const body = JSON.parse(firstText(result)) as { kind?: string; message?: string };
  assert.equal(body.kind, "refused");
  assert.match(body.message ?? "", /method/);
});

test("a refused call is not an MCP error", async () => {
  // `isError` is for the sidecar failing, not for the caller asking for something the policy forbids.
  // Marking a refusal as an error teaches a model to retry it; a structured refusal is an ANSWER.
  const gate = pageGate();
  const result = await handleRequest(config, gate.page, "capture", { url: "http://example.com/" });
  assert.notEqual(result.isError, true);
});

test("capture returns an IMAGE content block, not base64 inside a text block", async () => {
  // The difference is the whole user-visible feature. Pi forwards an `image` block as an image, so the picture
  // appears in the transcript. The same bytes wrapped in a text block arrive as a wall of base64: thousands of
  // tokens spent on a string nobody can look at. A test asserting `content[0].type` is the only thing that
  // holds this, because both shapes "work" from the model's point of view.
  const config = { executable: "/nonexistent/chrome", profileDir: "/nonexistent/profile", origin: "http://localhost:4173" };
  const fakePage = {
    setViewport: async () => {},
    navigate: async () => {},
    capture: async () => ({ data: "aGVsbG8=" }),
  };
  const result = await handleRequest(config, (async () => fakePage) as never, "capture", {
    url: "http://localhost:4173/",
  });
  assert.equal(result.content[0]?.type, "image", "the first block must be an image");
  const image = result.content[0] as unknown as { data?: string; mimeType?: string };
  assert.equal(image.data, "aGVsbG8=", "the bytes pass through unchanged");
  assert.equal(image.mimeType, "image/png");
  // And a text block accompanies it, so the transcript says WHAT was captured.
  assert.equal(result.content[1]?.type, "text");
});
