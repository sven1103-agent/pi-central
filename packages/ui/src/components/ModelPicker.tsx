/**
 * The model picker (issue #1).
 *
 * Replaces a read-only value in the session header with a control that changes the model, and the
 * acceptance criteria are mostly about **not lying**:
 *
 *   - The list comes from `get_available_models`, grouped by provider, current one marked.
 *   - Choosing one sends `set_model`, and the header then shows what **Pi reports back**, not an
 *     optimistic guess. Pi validates the choice (`No API key for <provider>/<model>`), persists it,
 *     and re-applies the thinking level, so the request is not the outcome.
 *   - A refusal appears as an error naming the reason, never as a silent no-op.
 *   - While a run is streaming the control says what will happen rather than pretending it is
 *     immediate: a model change applies to the next turn.
 *
 * The catalogue is fetched on open rather than kept in `LiveSession`. It is hundreds of entries
 * (426 measured across three providers) and changes only with the provider configuration, so
 * resending it on every state refresh would be waste; absent therefore means "not asked yet", which
 * is a different thing from an empty list and must render differently.
 *
 * A native `<select>` is used deliberately. The design calls for a custom popover, but this control
 * must work before it is pretty: a `<select>` is keyboard- and screen-reader-correct with no code,
 * groups natively via `<optgroup>`, and cannot be broken by a focus bug. It is the honest v1, and a
 * popover is a cosmetic follow-up rather than a behavioural one.
 */
import type { LiveSession, ModelOption } from "@pi-central/protocol";
import { useState } from "react";
import { truncateMiddle } from "../format.ts";
import { isCurrentModel, modelChangeTiming, modelsByProvider } from "../store.ts";

/**
 * How many characters the closed control shows before the middle is elided.
 *
 * Matches `.picker-select`'s `max-width: 30ch`, so the shortened label is what fits rather than a
 * second guess at the width. Kept here rather than only in CSS because the shortening decision needs
 * the number, and having CSS clip a *pre-shortened* string is the difference between a well-chosen
 * elision and a trailing cut (issue #42).
 *
 * **Raised from 22 to 30** (issue #74). The reviewer's note was that the label was being elided —
 * `openrouter/d_4.1-f…` — while empty space sat beside it in the header. The model is what the cost
 * attribution is about, so losing the variant is expensive; the cap only has to fit the *header*,
 * not a rail row. The two numbers still move together, and a test asserts they agree.
 */
const LABEL_MAX = 30;

export interface ModelPickerProps {
  session: LiveSession;
  /** The catalogue, or `undefined` when it has not been fetched yet. */
  models: ModelOption[] | undefined;
  /** Why the catalogue could not be read, if it could not. */
  error: string | undefined;
  /** Ask the orchestrator for the catalogue. Called on open AND on an explicit retry. */
  onRequest: () => void;
  onSelect: (provider: string, modelId: string) => void;
}

export function ModelPicker({ session, models, error, onRequest, onSelect }: ModelPickerProps) {
  // Whether THIS mount has already asked. `onFocus` fires repeatedly (every focus, every click),
  // so without this each focus would send another request. The guard lives here rather than in the
  // parent so that "Retry" can deliberately bypass it — a retry that were also guarded would be a
  // button that cannot work, which is the failure mode this project treats as worse than absence.
  const [requested, setRequested] = useState(false);
  const ask = (): void => {
    if (requested) return;
    setRequested(true);
    onRequest();
  };
  // `starting` and `stopped`/`failed` have no live Pi process to ask or command, so the control is
  // disabled with a reason. A disabled control with no explanation is worse than no control.
  const usable = session.state !== "starting" && session.state !== "stopped" && session.state !== "failed";
  const timing = modelChangeTiming(session);
  // "Loading" is derived here rather than passed in: it means "this control asked and has no answer
  // and no failure yet", which is a fact only this component knows.
  const loading = requested && models === undefined && error === undefined;

  if (error !== undefined) {
    return (
      <div className="picker picker-broken">
        <span className="picker-label">Model</span>
        <span className="picker-value" title={error}>
          unavailable
        </span>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            // Deliberately bypasses the guard: a retry after a failure must actually retry.
            setRequested(true);
            onRequest();
          }}
        >
          Retry
        </button>
        <span className="picker-note warn">Could not read the model list: {error}</span>
      </div>
    );
  }

  // Before the catalogue arrives, the current model is still known from `get_state`, so the value
  // shown is the session's real model rather than a placeholder — only the CHOICES are missing.
  const current = session.model === undefined
    ? "—"
    : session.provider
      ? `${session.provider}/${session.model}`
      : session.model;

  // The full label for the current model, matching whatever the corresponding `<option>` says so the
  // overlay and the list cannot disagree: a loaded catalogue shows the friendly `name`, and before it
  // arrives the raw `provider/id` is all there is.
  const selected = models?.find((model) => isCurrentModel(session, model));
  const fullLabel = selected ? (selected.name ?? selected.id) : current;
  /*
   * The MODEL on its own, and the provider moved out of the label (issue #163).
   *
   * `fullLabel` is the catalogue's name, which usually carries no provider — so in a setup with the same model
   * configured on two providers, the header named the model and hid the half that decides cost and routing. And
   * wherever the name IS absent, the fallback is `provider/id`, which repeated the provider on both lines.
   *
   * The provider is emitted as its own field with its own label, because it is a fact the user configured and gave
   * a name to. `truncateMiddle` stays: a long model id must not push the controls out of the header.
   */
  const modelLabel = truncateMiddle(selected ? (selected.name ?? selected.id) : (session.model ?? "—"), LABEL_MAX);

  return (
    <div className="picker picker-stacked">
      <span className="picker-row">
        {/*
          The provider, READ rather than chosen. It is part of the session's identity — Pi has no per-session
          provider switch, and a session keeps the provider it started on — so presenting it as a control would
          offer a change that cannot happen. `title` carries the raw id for the case where two providers share a
          friendly name.
        */}
        <span className="picker-label">Provider</span>
        <span className="picker-provider mono" title={session.provider ?? undefined}>
          {session.provider ?? "—"}
        </span>
      </span>
      <span className="picker-row">
      <label className="picker-label" htmlFor={`model-${session.id}`}>
        Model
      </label>
      <div className="picker-field">
        {/*
          * The SHORTENED view, drawn over the select; the select beneath keeps full option text.
          *
          * A native `<select>` renders the selected option's text in its closed state, so "compact
          * when closed, complete when open" is not expressible through option text alone — and both
          * halves are required here: the header must stay identifying while the list must stay
          * readable, because picking from truncated names is how you choose the wrong model.
          *
          * `aria-hidden` because it is a visual restatement of the select's own value: a screen
          * reader should hear the FULL name once, from the select, rather than a shortened one
          * twice. The `title` carries the full value for a pointer, so no one has to decode an
          * elision to find out which model is in use.
          */}
        <span
          className={`picker-display mono${usable ? "" : " is-disabled"}`}
          aria-hidden="true"
          title={fullLabel}
        >
          {modelLabel}
        </span>
        <select
          id={`model-${session.id}`}
          className="picker-select"
          title={fullLabel}
        // Controlled by the session, not by local state: the shown value is Pi's, so a refused
        // change leaves the select exactly where it was instead of showing the requested value.
        value={models === undefined ? "" : currentKey(session, models)}
        disabled={!usable}
        // Opening fetches on demand, so the catalogue is never stale-by-default and the list is
        // read at the moment it is about to be shown.
        onFocus={ask}
        onMouseDown={ask}
        onChange={(event) => {
          const [provider, ...rest] = event.target.value.split("/");
          if (provider !== undefined && rest.length > 0) onSelect(provider, rest.join("/"));
        }}
        >
          {/*
            The current value must exist as an option or the select cannot display it. When the catalogue has not
            loaded, this is the only entry — which is why the select reads as the model rather than as empty.

            The MODEL alone, not `current` (issue #163). `current` is `provider/id`, which repeated the provider on
            the line just below the field that now names it. The full identity is still on the `title` attributes of
            both the overlay and the select, so nothing is lost — and once the catalogue arrives the options carry
            full names anyway.
          */}
          {models === undefined && <option value="">{session.model ?? "—"}</option>}
          {models !== undefined && models.length === 0 && <option value="">no models available</option>}
          {/* Full names, deliberately: this list is where a model is chosen, and the overlay covers
              the closed control only. Truncating here would put the elision where the decision is
              made. */}
          {models !== undefined &&
            modelsByProvider(models).map((group) => (
              <optgroup key={group.provider} label={group.provider}>
                {group.models.map((model) => (
                  <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                    {model.name ?? model.id}
                    {model.reasoning ? " · thinking" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      </div>
      </span>
      {loading && <span className="picker-note">reading the model list…</span>}
      {timing !== "" && <span className="picker-note">{timing}</span>}
    </div>
  );
}

/**
 * The select's value for the session's current model.
 *
 * Matched against the fetched catalogue so the select shows a value that is actually one of its
 * options. If Pi reports a model the catalogue does not contain — a configuration change mid-session
 * — the value is cleared rather than set to a non-existent option, which browsers render as blank
 * or as the first entry (both of which would misreport the current model).
 */
function currentKey(session: LiveSession, models: ModelOption[]): string {
  const match = models.find((model) => isCurrentModel(session, model));
  return match ? `${match.provider}/${match.id}` : "";
}
