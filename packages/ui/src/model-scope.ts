/**
 * The models a reader actually uses, and the list the picker opens on (issue #265).
 *
 * ## The complaint, measured
 *
 * The picker offers everything Pi can reach — 426 options across three providers in the report, and 406 across the two
 * providers that answered when the count was reproduced while this landed. A native `<select>` with that many options
 * does not scroll usefully: typing a letter jumps to the first match in one `<optgroup>`, and a provider configured
 * once and abandoned takes up exactly as much room as the one used hourly.
 *
 * So the reader names a shortlist, and the picker shows it. The catalogue stays reachable — scoping NARROWS a list, it
 * never becomes a filter that hides models the app is still willing to offer.
 *
 * ## Why this is STORED, and what that costs
 *
 * The precedent is `chooser-prefs.ts` (issue #76), and this is its second instance rather than a new pattern: a UI
 * preference lives in `localStorage`, is **validated on read** because storage outlives upgrades, and a stale value
 * **degrades to the default rather than producing a broken state**.
 *
 * The distinction `chooser-prefs.ts` draws applies here unchanged. "Which models I use" is not derivable from anything
 * the orchestrator reports — no session header knows it, and Pi's own provider configuration does not either. It is a
 * record of a choice the reader made, so it must be stored and must never be recomputed from the catalogue. By
 * contrast `recentDirectories` is derivable and is therefore a projection that must never be stored.
 *
 * ## Keyed on `provider/id`, never on the display name
 *
 * `set_model` requires BOTH (`PROTOCOL.md:309-311`), and two providers can offer the same model id — a proxy and the
 * upstream, in different currencies. Scoping on the name would make the two indistinguishable and would let one
 * provider's retirement erase the other's entry.
 *
 * ## What this deliberately does NOT do
 *
 * It does not write Pi's `enabledModels` or any provider configuration, and it changes nothing about what Pi can
 * reach. A scoped list that also DISABLED models would be a credential-and-routing change wearing a UI's clothes. The
 * falsification this file exists to satisfy is "a reader with 406 models can find the four they use", not "the app
 * restricts them to four".
 */
import type { ModelOption } from "@pi-central/protocol";
import type { PrefsReader } from "./chooser-prefs.ts";

/** One model, by the pair that identifies it everywhere else in the protocol. */
export interface ModelRef {
  provider: string;
  id: string;
}

/**
 * The stored preference: the reader's list, in the order they added it.
 *
 * Order is kept rather than sorted. The reader's own ordering is a fact about how often they reach for each model, and
 * re-sorting it — alphabetically, or by provider — would throw that away and move a frequently used model down the
 * list on every upgrade.
 *
 * `models: []` and "nothing stored" are the SAME state on purpose: no scope set, so the picker behaves exactly as it
 * did before this feature existed. Two representations of "empty" would eventually disagree about which list to show.
 */
export interface ModelScope {
  models: ModelRef[];
}

export const MODEL_SCOPE_KEY = "pi-central.model-scope";

export function emptyScope(): ModelScope {
  return { models: [] };
}

/**
 * Whether the reader has a list at all.
 *
 * The picker branches on THIS rather than on `models.length === 0`, so "no scope" and "an empty scope" cannot end up
 * with two different renderings: with no scope the catalogue is shown whole, which is the pre-existing behaviour.
 */
export function scopeIsSet(scope: ModelScope): boolean {
  return scope.models.length > 0;
}

/** The identity of a model, as the protocol spells it for `set_model` and as a `<select>` value. */
export function refKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

/**
 * A usable reference, or `undefined`.
 *
 * Both halves must be non-empty strings, and the PROVIDER must contain no `/`: the picker's `<select>` value is
 * `provider/id` and the change handler splits on the FIRST `/`, so a provider carrying one would have its id cut in the
 * wrong place and would select a different model than the one shown. Model ids DO contain slashes
 * (`openrouter/deepseek-ai/DeepSeek-V3`), which is why the split is on the first one and why the restriction is on the
 * provider alone.
 */
export function toRef(raw: unknown): ModelRef | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const provider = record["provider"];
  const id = record["id"];
  if (typeof provider !== "string" || typeof id !== "string") return undefined;
  if (provider === "" || id === "" || provider.includes("/")) return undefined;
  return { provider, id };
}

/**
 * Read a stored scope, discarding anything not recognised.
 *
 * ## Why an unparseable value means "no scope" and not "an empty list"
 *
 * They are the same state here (see {@link ModelScope}), and that is the point of the requirement: a corrupt value must
 * degrade to the DEFAULT — the full catalogue — rather than to an empty picker. Coercing a value that failed to parse
 * into `[]`, or throwing on the way into a render, would leave a reader with a control that offers nothing and no
 * explanation.
 *
 * ## Why stale entries are NOT pruned here
 *
 * This function has no catalogue and cannot know what Pi currently offers, which is exactly why it must not guess. An
 * entry naming a model Pi has stopped reporting is **kept** and marked unavailable at render time
 * ({@link scopeView}): a provider that is briefly unreachable, or a key that failed to resolve, would otherwise erase
 * the reader's list on the next read — silently, because nothing recomputes it.
 *
 * Duplicates are collapsed (first occurrence wins), so a hand-edited or double-written value cannot render one model
 * twice in the picker.
 */
export function parseModelScope(raw: string | null): ModelScope {
  if (raw === null || raw === "") return emptyScope();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A half-written value from a crash mid-write. The default is correct, so this is not worth reporting.
    return emptyScope();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyScope();
  const models = (parsed as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) return emptyScope();

  const seen = new Set<string>();
  const kept: ModelRef[] = [];
  for (const entry of models) {
    const ref = toRef(entry);
    if (ref === undefined) continue;
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(ref);
  }
  return { models: kept };
}

/** Read from `localStorage`, or any other string store. */
export function loadModelScope(read: PrefsReader): ModelScope {
  return parseModelScope(read(MODEL_SCOPE_KEY));
}

export function serializeModelScope(scope: ModelScope): string {
  return JSON.stringify({ models: scope.models.map((ref) => ({ provider: ref.provider, id: ref.id })) });
}

export function isScoped(scope: ModelScope, provider: string, id: string): boolean {
  return scope.models.some((ref) => ref.provider === provider && ref.id === id);
}

/**
 * Add one model to the list, or remove it.
 *
 * A toggle rather than `add`/`remove` because that is the gesture the picker offers — one control on the current model
 * — and because a pair of functions is a pair of places the two halves can disagree about what "present" means.
 *
 * Added at the END: the newest intent is the most recent reach for a model, and the list is kept in the reader's order
 * (see {@link ModelScope}).
 */
export function toggleScope(scope: ModelScope, ref: ModelRef): ModelScope {
  const present = isScoped(scope, ref.provider, ref.id);
  return present
    ? { models: scope.models.filter((entry) => !(entry.provider === ref.provider && entry.id === ref.id)) }
    : { models: [...scope.models, { provider: ref.provider, id: ref.id }] };
}

/**
 * What the picker shows for a scope, against the catalogue Pi reported.
 *
 * Two facts rather than one filtered array, because they answer two questions the control has to keep apart:
 *
 *   - `models` — the scoped models Pi currently offers, **in the scope's order**, which is the list the picker renders.
 *   - `unavailable` — scoped entries Pi no longer reports. Kept, and named, so a provider outage marks the reader's
 *     list instead of quietly shrinking it.
 *
 * An empty `models` beside a non-empty `unavailable` is a real state (the provider behind the whole list is gone) and
 * is NOT the catalogue's empty state: "Pi offers no models" and "nothing in my list can be reached right now" are
 * different facts with different fixes, and conflating them is the mistake `supervisor.ts:877-882` records.
 *
 * Matching is on `provider` AND `id`: see the module comment.
 */
/** One scoped entry: the reference the reader stored, and the catalogue's record of it when Pi still offers it. */
export interface ScopeEntry {
  ref: ModelRef;
  /** Absent means Pi no longer reports this model — kept and marked, never dropped. */
  model?: ModelOption | undefined;
}

/**
 * The reader's list, in their order, each entry resolved against the catalogue.
 *
 * The ordering is why this exists as its own function: the dialog lists the list as the reader arranged it, so an
 * available model and a stale one must be able to sit next to each other in one sequence rather than in two blocks that
 * silently reorder the reader's choice.
 */
export function scopeEntries(scope: ModelScope, catalogue: readonly ModelOption[]): ScopeEntry[] {
  const offered = new Map<string, ModelOption>();
  for (const model of catalogue) {
    const key = `${model.provider}/${model.id}`;
    // First wins, so a duplicated catalogue entry cannot make the list render the same model twice.
    if (!offered.has(key)) offered.set(key, model);
  }
  return scope.models.map((ref) => {
    const model = offered.get(refKey(ref));
    return model === undefined ? { ref } : { ref, model };
  });
}

export function scopeView(
  scope: ModelScope,
  catalogue: readonly ModelOption[],
): { models: ModelOption[]; unavailable: ModelRef[] } {
  const entries = scopeEntries(scope, catalogue);
  return {
    models: entries.flatMap((entry) => (entry.model === undefined ? [] : [entry.model])),
    unavailable: entries.flatMap((entry) => (entry.model === undefined ? [entry.ref] : [])),
  };
}

/**
 * The full catalogue narrowed by a typed filter, for the list's search field.
 *
 * Substring, case-insensitive, over the id, the human name and the provider — the three things a reader types when they
 * half-remember a model ("sonnet", "anthropic", "4.1"). Substring rather than prefix because model ids put the useful
 * token in the middle (`openrouter/deepseek-ai/DeepSeek-V4.1-Flash`) far more often than at the start.
 *
 * An empty query returns the catalogue untouched — "no filter" is not "nothing matches", and an empty result from an
 * empty field would be the same mistake as reporting a failed read as an empty list.
 */
export function filterCatalogue(catalogue: readonly ModelOption[], query: string): ModelOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...catalogue];
  return catalogue.filter((model) => {
    const name = model.name ?? "";
    return (
      model.id.toLowerCase().includes(needle) ||
      name.toLowerCase().includes(needle) ||
      model.provider.toLowerCase().includes(needle)
    );
  });
}
