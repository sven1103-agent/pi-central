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
import { isCurrentModel, modelChangeTiming, modelsByProvider } from "../store.ts";

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

  return (
    <div className="picker">
      <label className="picker-label" htmlFor={`model-${session.id}`}>
        Model
      </label>
      <select
        id={`model-${session.id}`}
        className="picker-select"
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
        {/* The current value must exist as an option or the select cannot display it. When the
            catalogue has not loaded, this is the only entry — which is why the select reads as the
            model rather than as empty. */}
        {models === undefined && <option value="">{current}</option>}
        {models !== undefined && models.length === 0 && <option value="">no models available</option>}
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
