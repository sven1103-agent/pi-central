import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonlDecoder, encodeLine } from "../src/framing.ts";

const enc = (s: string) => Buffer.from(s, "utf8");

test("splits on LF and parses each record", () => {
  const d = new JsonlDecoder();
  const out = d.push(enc('{"type":"a"}\n{"type":"b"}\n'));
  assert.deepEqual(out.map((r) => r.type), ["a", "b"]);
});

test("a record straddling a chunk boundary is reassembled", () => {
  const d = new JsonlDecoder();
  assert.deepEqual(d.push(enc('{"type":"he')), []);
  assert.deepEqual(d.push(enc("llo\"}\n")).map((r) => r.type), ["hello"]);
});

test("a newline arriving alone in a chunk still terminates the record", () => {
  const d = new JsonlDecoder();
  assert.deepEqual(d.push(enc('{"type":"x"}')), []);
  assert.deepEqual(d.push(enc("\n")).map((r) => r.type), ["x"]);
});

test("U+2028 and U+2029 inside a JSON string do NOT split the record (C7)", () => {
  // This is the whole reason `readline` is banned. Both are legal inside a JSON string.
  const d = new JsonlDecoder();
  const line = `${JSON.stringify({ type: "message", text: "a\u2028b\u2029c" })}\n`;
  const out = d.push(enc(line));
  assert.equal(out.length, 1, "must be exactly one record, not three");
  assert.equal(out[0]!.text, "a\u2028b\u2029c");
});

test("a CR before LF is tolerated", () => {
  const d = new JsonlDecoder();
  assert.deepEqual(d.push(enc('{"type":"crlf"}\r\n')).map((r) => r.type), ["crlf"]);
});

test("malformed JSON is skipped, not fatal, and the following record survives", () => {
  const d = new JsonlDecoder();
  const out = d.push(enc('{not json}\n{"type":"good"}\n'));
  assert.deepEqual(out.map((r) => r.type), ["good"]);
});

test("records without a `type` are dropped", () => {
  const d = new JsonlDecoder();
  assert.deepEqual(d.push(enc('{"noType":1}\n[]\n42\nnull\n{"type":"ok"}\n')).map((r) => r.type), ["ok"]);
});

test("blank lines are ignored", () => {
  const d = new JsonlDecoder();
  assert.deepEqual(d.push(enc('\n\n{"type":"a"}\n\n')).map((r) => r.type), ["a"]);
});

test("flush() yields a trailing record with no newline", () => {
  const d = new JsonlDecoder();
  assert.deepEqual(d.push(enc('{"type":"last"}')), []);
  assert.deepEqual(d.flush().map((r) => r.type), ["last"]);
});

test("encodeLine is a single LF-terminated line with no interior newline", () => {
  const line = encodeLine({ type: "prompt", message: "multi\nline" });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.split("\n").length, 2); // the real newline is escaped inside the JSON
  assert.deepEqual(JSON.parse(line).message, "multi\nline");
});
