/**
 * The version-skew complaint (issue #8).
 *
 * ## Why this small function earns a test
 *
 * It is the only thing standing between a user and a misleading error. Issue #8 added five wire kinds
 * without bumping `PROTOCOL_VERSION`, so both halves announced v1, `hello` agreed, and the mismatch
 * arrived later as
 *
 *     bad control: unknown kind 'listFiles'
 *
 * — an unknown kind, reported by a connection that had just declared itself compatible. The whole
 * point of the handshake is to say *"these two are different versions"* instead, so the wording is
 * the deliverable and is pinned here.
 *
 * The assertions are deliberately about what the message must CONTAIN rather than its exact prose:
 * both version numbers (so the reader knows which way the skew runs) and the restart (because in a
 * dev checkout the orchestrator is a long-lived process holding the old module, so a browser reload
 * alone cannot fix it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@pi-central/protocol";
import { versionSkew } from "../src/connection.ts";

test("matching versions produce no complaint at all", () => {
  // The common case must stay silent. A check that reported agreement would be worse than none:
  // it would put a protocol notice in front of every user on every connect.
  assert.equal(versionSkew(PROTOCOL_VERSION), undefined);
});

test("an OLDER orchestrator is named as the older one, with both versions", () => {
  // The exact case the user hit: a new UI against an orchestrator built before the change.
  const message = versionSkew(PROTOCOL_VERSION - 1);
  assert.ok(message, "a skew must be reported");
  assert.match(message, new RegExp(`orchestrator speaks v${PROTOCOL_VERSION - 1}`));
  assert.match(message, new RegExp(`this UI speaks v${PROTOCOL_VERSION}`));
  // The recovery has to include a restart, not just a reload: the running orchestrator holds the
  // old module in memory, so reloading the browser cannot change what it accepts.
  assert.match(message, /restart the orchestrator/i);
});

test("a NEWER orchestrator is named as the newer one, so the direction is never guessed", () => {
  // The mirror case, which is what a checkout left on an old branch produces. The direction matters:
  // "reload the UI" is the wrong advice when it is the orchestrator that is ahead.
  const message = versionSkew(PROTOCOL_VERSION + 1);
  assert.ok(message);
  assert.match(message, new RegExp(`orchestrator speaks v${PROTOCOL_VERSION + 1}`));
  assert.match(message, new RegExp(`this UI speaks v${PROTOCOL_VERSION}`));
});

test("the complaint names the VERSION, never a symptom like an unknown kind", () => {
  // The regression this guards. The previous failure mode mentioned a message kind — a consequence
  // of the skew — which sent the reader looking for a missing handler instead of at the versions.
  const message = versionSkew(PROTOCOL_VERSION - 1) ?? "";
  assert.ok(!/unknown kind/i.test(message), `must not report a symptom, got: ${message}`);
  assert.ok(!/bad control/i.test(message), `must not report a symptom, got: ${message}`);
  assert.match(message, /protocol mismatch/i);
});
