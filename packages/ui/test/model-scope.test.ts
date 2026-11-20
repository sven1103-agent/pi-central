/**
 * The models a reader actually uses (issue #265).
 *
 * ## What this file is for
 *
 * The picker offers 406 models measured across the two providers that answered, and the four a reader uses are buried
 * in that list. The list they name is a preference, so it is stored — and a stored preference is the second instance of
 * a pattern `chooser-prefs.ts` established: **validated on read**, because `localStorage` outlives upgrades and is
 * shared with anything else on the origin, and **degrading to the default rather than to a broken state**.
 *
 * The default here is not "an empty list". It is "no list at all, so the picker shows the catalogue" — which is why
 * `models: []` and "nothing stored" must be indistinguishable, and why a corrupt value has to mean the second.
 *
 * ## The one rule this file pins hardest
 *
 * A scoped entry naming a model Pi no longer reports is KEPT and MARKED, never pruned. Pruning is tempting because it
 * makes the stored list tidy; it is wrong because "Pi did not report this model" and "the reader does not use this
 * model" are different facts, and a provider that is briefly unreachable would otherwise erase a choice that nothing
 * recomputes. There is no second copy of this list anywhere to recover it from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_SCOPE_KEY,
  emptyScope,
  filterCatalogue,
  isScoped,
  loadModelScope,
  parseModelScope,
  refKey,
  scopeEntries,
  scopeIsSet,
  scopeView,
  serializeModelScope,
  toggleScope,
  toRef,
} from "../src/model-scope.ts";

const model = (provider: string, id: string, extra: Record<string, unknown> = {}) => ({
  provider,
  id,
  name: id.toUpperCase(),
  ...extra,
});

test("nothing stored means no list, not an empty one", () => {
  assert.deepEqual(parseModelScope(null), emptyScope());
  assert.deepEqual(parseModelScope(""), emptyScope());
  assert.equal(scopeIsSet(loadModelScope(() => null)), false, "the picker must fall back to the catalogue");
});

test("a stored list round-trips, in the reader's order", () => {
  const scope = { models: [{ provider: "openai", id: "gpt-5" }, { provider: "anthropic", id: "claude-x" }] };
  assert.deepEqual(parseModelScope(serializeModelScope(scope)), scope);
});

test("a list survives a reload, because it is stored and not held in a component", () => {
  // The requirement is "survives a reload and an app restart, per machine rather than per session". `localStorage` is
  // the mechanism; this pins the contract a store has to honour, with a string store standing in for it — the same
  // shape `App` uses (`safeLocalStorage`, one key, one writer).
  const store = new Map<string, string>();
  const read = (key: string) => store.get(key) ?? null;
  store.set(
    MODEL_SCOPE_KEY,
    serializeModelScope({ models: [{ provider: "openai", id: "gpt-5" }, { provider: "openai", id: "gpt-5-mini" }] }),
  );
  assert.deepEqual(
    loadModelScope(read).models.map((ref) => ref.id),
    ["gpt-5", "gpt-5-mini"],
    "a new page reads the same list, in the same order",
  );
});

test("an unparseable or structurally wrong value degrades to no list", () => {
  // A half-written value from a crash mid-write, a value written by something else on the origin, and the shapes that
  // JSON allows but this preference does not. Every one must land on "no list" so the picker shows the catalogue —
  // never on an empty control, which would look like an app with no models at all.
  for (const raw of ['{"models":', "null", "[1,2]", '"gpt-5"', '{"models":"gpt-5"}', '{"models":{}}', "42"]) {
    const parsed = parseModelScope(raw);
    assert.deepEqual(parsed, emptyScope(), `${raw} must degrade to no list`);
    assert.equal(scopeIsSet(parsed), false, `${raw} must not claim a list is set`);
  }
});

test("entries are validated one by one, and a provider with a slash is refused", () => {
  // `provider/id` is both the select's value and what `set_model` takes, and the change handler splits on the FIRST
  // slash. A provider containing one would cut the id in the wrong place and select a different model than the one
  // shown. Model IDS contain slashes legitimately, which is why the restriction is only on the provider.
  assert.deepEqual(toRef({ provider: "openrouter", id: "deepseek-ai/DeepSeek-V3" }), {
    provider: "openrouter",
    id: "deepseek-ai/DeepSeek-V3",
  });
  assert.equal(toRef({ provider: "open/router", id: "m" }), undefined);
  assert.equal(toRef({ provider: "", id: "m" }), undefined);
  assert.equal(toRef({ provider: "p", id: "" }), undefined);
  assert.equal(toRef({ provider: 7, id: "m" }), undefined);
  assert.equal(toRef({ id: "m" }), undefined);

  const parsed = parseModelScope(
    '{"models":[{"provider":"","id":"x"},{"provider":"p","id":"ok"},{"provider":"p","id":"ok"},null,{"id":"y"}]}',
  );
  assert.deepEqual(parsed.models, [{ provider: "p", id: "ok" }], "the invalid entries go, the duplicate collapses");
});

test("scoping is keyed on provider AND id, because two providers can offer one id", () => {
  const scope = { models: [{ provider: "proxy", id: "gpt-5" }] };
  assert.equal(isScoped(scope, "proxy", "gpt-5"), true);
  assert.equal(isScoped(scope, "openai", "gpt-5"), false, "the upstream is a different model, at a different price");
  assert.equal(refKey({ provider: "proxy", id: "gpt-5" }), "proxy/gpt-5");
});

test("toggling adds at the end and removes from the middle, without touching the rest", () => {
  const a = { provider: "openai", id: "a" };
  const b = { provider: "openai", id: "b" };
  const c = { provider: "openai", id: "c" };
  const three = { models: [a, b, c] };
  assert.deepEqual(toggleScope(three, a).models, [b, c], "the reader's order survives a removal");
  assert.deepEqual(toggleScope({ models: [a, c] }, b).models, [a, c, b], "and an addition goes to the end");
  // Toggling twice is the identity, so a double click or a re-render cannot accumulate duplicates.
  assert.deepEqual(toggleScope(toggleScope(emptyScope(), b), b), emptyScope());
});

test("the catalogue resolves the list, and a model Pi no longer reports is MARKED, not dropped", () => {
  // The falsification: revert to pruning on read and this assertion fails, because the entry is gone rather than
  // reported as unavailable. A transient provider outage must not erase a choice nothing else remembers.
  const scope = {
    models: [
      { provider: "openai", id: "gpt-5" },
      { provider: "openai", id: "retired" },
      { provider: "anthropic", id: "claude-x" },
    ],
  };
  const catalogue = [model("anthropic", "claude-x"), model("openai", "gpt-5"), model("openai", "gpt-5-mini")];

  const entries = scopeEntries(scope, catalogue);
  assert.deepEqual(
    entries.map((entry) => (entry.model === undefined ? `${entry.ref.provider}/${entry.ref.id} (unavailable)` : entry.ref.id)),
    ["gpt-5", "openai/retired (unavailable)", "claude-x"],
    "the reader's order is kept, and the retired entry sits where they put it",
  );

  const view = scopeView(scope, catalogue);
  assert.deepEqual(view.models.map((entry) => entry.id), ["gpt-5", "claude-x"]);
  assert.deepEqual(view.unavailable, [{ provider: "openai", id: "retired" }]);
  assert.equal(scope.models.length, 3, "resolving is a view; the stored list is untouched");
});

test("an empty catalogue does not become an empty list", () => {
  // "Pi reports no models" is a definitive answer about Pi, not about the reader's list — the distinction
  // `supervisor.ts:877-882` draws between "there are none" and "the question failed", one level up.
  const scope = { models: [{ provider: "openai", id: "gpt-5" }] };
  const view = scopeView(scope, []);
  assert.deepEqual(view.models, []);
  assert.deepEqual(view.unavailable, scope.models, "the entry is kept and reported as unavailable, not deleted");
  assert.equal(scopeIsSet(parseModelScope(serializeModelScope(scope))), true, "and the stored list still exists");
});

test("the filter matches id, name and provider, and an empty query is not a filter", () => {
  const catalogue = [
    model("openrouter", "deepseek-ai/DeepSeek-V4.1-Flash"),
    model("anthropic", "claude-sonnet-4-5", { name: "Claude Sonnet 4.5" }),
    model("openai", "gpt-5"),
  ];
  assert.equal(filterCatalogue(catalogue, "").length, 3, "an empty field must list everything");
  assert.equal(filterCatalogue(catalogue, "   ").length, 3, "and so must whitespace");
  assert.deepEqual(filterCatalogue(catalogue, "SONNET").map((m) => m.id), ["claude-sonnet-4-5"], "case-insensitive");
  assert.deepEqual(filterCatalogue(catalogue, "anthropic").map((m) => m.id), ["claude-sonnet-4-5"], "by provider");
  assert.deepEqual(
    filterCatalogue(catalogue, "deepseek").map((m) => m.id),
    ["deepseek-ai/DeepSeek-V4.1-Flash"],
    "a substring in the middle of an id, which is where the useful token is",
  );
  assert.deepEqual(filterCatalogue(catalogue, "nothing-like-this"), []);
});

test("the storage key is its own, so a list cannot collide with another preference", () => {
  assert.equal(MODEL_SCOPE_KEY, "pi-central.model-scope");
});
