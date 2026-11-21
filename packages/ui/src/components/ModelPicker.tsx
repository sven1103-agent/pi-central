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
 *
 * ## The scope, and why it narrows the `<select>` rather than replacing it (issue #265)
 *
 * The catalogue is 426 models across three providers in the report this comes from, and 406 across the two that
 * answered when the count was reproduced while this landed — either way it is not a list, it is a catalogue, and a
 * `<select>` of that size cannot be searched or narrowed by typing a letter. So the reader names the models they use
 * (`model-scope.ts`) and this control offers those. Three rules follow from the requirement rather than from taste:
 *
 *   - the full catalogue stays ONE labelled affordance away, because scoping narrows a list and must never become a
 *     filter that hides models the app is still willing to offer;
 *   - an EMPTY scope renders this component exactly as it rendered before the feature existed, so nobody's current
 *     list changes underneath them;
 *   - `models.length === 0` is still "no models available". A scope must not become a third, indistinguishable empty
 *     state — `supervisor.ts:877-882` keeps "there are none" and "the question failed" apart, and this is the same
 *     distinction one level up.
 */
import type { LiveSession, ModelOption } from "@pi-central/protocol";
import { useEffect, useRef, useState } from "react";
import { truncateMiddle } from "../format.ts";
import { emptyScope, refKey, scopeIsSet, scopeView, type ModelScope } from "../model-scope.ts";
import { isCurrentModel, modelControlUsable, modelsByProvider } from "../store.ts";

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
 *
 * **Raised again, to 44, after a second screenshot review** (`img_22.png`) showed `deepseek-ai/Deep…1-Flash-`
 * in the header with ~1100px of empty space beside it. The cap was sized for the OLD three-strip header, where
 * the pickers competed with a metrics row; the header is one band now and has room. Eliding the model when there
 * is space to show it is the same defect #74 reported, only later: the variant is what identifies the model, and
 * it is the thing the reader is checking.
 *
 * The number is a HINT, not the only defence: `.picker-select` also caps in `ch` so a pathological id cannot
 * push the controls out of the header, and a test keeps the two in step.
 */
const LABEL_MAX = 44;

export interface ModelPickerProps {
  session: LiveSession;
  /** The catalogue, or `undefined` when it has not been fetched yet. */
  models: ModelOption[] | undefined;
  /** Why the catalogue could not be read, if it could not. */
  error: string | undefined;
  /** Ask the orchestrator for the catalogue. Called on open AND on an explicit retry. */
  onRequest: () => void;
  onSelect: (provider: string, modelId: string) => void;
  /**
   * The reader's own list (issue #265). Absent means empty, which renders the whole catalogue — today's behaviour.
   *
   * Passed in rather than read from `localStorage` here: it is a per-MACHINE preference, and two pickers that each read
   * storage would disagree the moment one of them wrote.
   */
  scope?: ModelScope | undefined;
  /**
   * Open the surface that edits the list.
   *
   * Absent means "this host has nowhere to show it", and the control that would open it is not rendered: a control that
   * cannot act is worse than no control, which is the rule the Retry button's comment states too.
   *
   * The editor itself is NOT rendered here (issue #265). The picker lives in the transcript's 340px sticky companion,
   * and `.transcript-shell` declares `container-type: inline-size` — which makes it the containing block for fixed
   * descendants, so a `.modal-backdrop` rendered here would cover the conversation and claim an `aria-modal` modality it
   * does not have over the rail or the panel. The shell renders the dialog instead, the same way it renders `Settings`
   * and `ShortcutSheet`.
   *
   * The TRIGGER is handed over with the call, because the shell returns focus to it when the dialog closes — the rule
   * `Settings` and `ShortcutSheet` follow. Capturing `document.activeElement` in the shell would be wrong: a pointer
   * click does not focus a button in every browser, so the element that opened the surface is only known here.
   */
  onManageModels?: ((trigger: HTMLElement) => void) | undefined;
  /**
   * The thinking-level control, rendered on the MODEL's row (issue #163).
   *
   * Passed in rather than imported: the two are coupled — the levels are per-model, so a change to one invalidates
   * the other — and they must share a row and a label column. Accepting it as a slot keeps `ThinkingPicker` owning
   * its own fetch/failure logic while the layout decides where it sits.
   */
  thinking?: React.ReactNode;
}

export function ModelPicker({
  session,
  models,
  error,
  onRequest,
  onSelect,
  scope = emptyScope(),
  onManageModels,
  thinking,
}: ModelPickerProps) {
  const selectRef = useRef<HTMLSelectElement | null>(null);
  /**
   * A click that arrived before the catalogue did, waiting for it.
   *
   * Held in a ref rather than state because it is a pending INTENT, not something to render — and a re-render
   * is exactly what must not happen here: the open has to occur in the same task that observes the data.
   */
  const pendingOpen = useRef(false);

  /**
   * Open the popup as soon as there is something to show.
   *
   * `showPicker()` requires a user gesture, so it cannot be called from an effect once `models` arrives — the
   * gesture is gone by then. Instead this waits for the next render, when the options exist, and opens. The
   * alternative the browser offers is reopening: which is precisely the bug being fixed.
   */
  const waitForCatalogue = (): void => {
    pendingOpen.current = true;
  };

  useEffect(() => {
    if (!pendingOpen.current || models === undefined) return;
    pendingOpen.current = false;
    // `showPicker` throws if there is no user activation or the element is not visible; both are possible and
    // neither is worth an error boundary — the control still works on the next click.
    try {
      selectRef.current?.showPicker();
    } catch {
      /* Leave it to the next click. */
    }
  }, [models]);

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
  const usable = modelControlUsable(session);
  // "Loading" is derived here rather than passed in: it means "this control asked and has no answer
  // and no failure yet", which is a fact only this component knows.
  const loading = requested && models === undefined && error === undefined;

  /** Whether the reader has a list, and so whether the picker offers that instead of the catalogue. */
  const scoped = scopeIsSet(scope);
  /*
   * The scoped view, or `undefined` when the catalogue is what should be shown.
   *
   * `models.length > 0` is load-bearing: an EMPTY catalogue is Pi answering "there are none", and rendering a scope
   * against it would turn a definitive answer into "your list is empty", which is the conflation the whole empty-state
   * rule exists to prevent. So the empty catalogue keeps its own `no models available` option below, scope or no scope.
   */
  const view = scoped && models !== undefined && models.length > 0 ? scopeView(scope, models) : undefined;
  /*
   * The session's model, when the reader's list does not contain it.
   *
   * Without this the scoped `<select>` would have no option matching `session.model`, and a control whose value is not
   * among its options renders blank — so the header would stop saying which model the session is on, which is the one
   * fact this control must never lose. It is labelled as in use rather than merged into the reader's list, because it is
   * NOT in it: scope narrows what the picker offers, and the model in force is always one of the things it offers.
   */
  const currentModel = models?.find((model) => isCurrentModel(session, model));
  const currentOutsideScope =
    view !== undefined &&
    currentModel !== undefined &&
    !view.models.some((model) => model.provider === currentModel.provider && model.id === currentModel.id);

  /** One `<option>`, so the scoped and unscoped lists cannot render a model two different ways. */
  const optionFor = (model: ModelOption) => (
    <option key={refKey(model)} value={refKey(model)}>
      {model.name ?? model.id}
      {model.reasoning ? " · thinking" : ""}
    </option>
  );

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
  // arrives the raw `provider/id` is all there is. `currentModel` is the same lookup the scoped list
  // uses, so the two cannot name different models.
  const fullLabel = currentModel ? (currentModel.name ?? currentModel.id) : current;
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
  const modelLabel = truncateMiddle(currentModel ? (currentModel.name ?? currentModel.id) : (session.model ?? "—"), LABEL_MAX);

  /*
   * TWO ROWS, ONE LABEL COLUMN, and only one control under each label.
   *
   * From a screenshot: the provider sat above and to the right of the model, `Thinking` was on the PROVIDER's
   * line, and `Model` hung below on its own — three different left edges in one 120px block. The cause was that
   * the pickers were siblings in the header row, each with its own label, so nothing lined up: a `<label>` and a
   * value of different widths cannot be aligned by eye.
   *
   * So the header gets one block with a `grid-template-columns` label column, and this component emits ROWS of
   * it. Thinking joins the model's row because the two are coupled — the levels are per-model — and because the
   * provider is the only thing that needs its own line, being a read-only fact rather than a control.
   *
   * `data-picker-row` is what tells the shell where to place each row: two columns, so every label starts at the
   * same x and every control starts at the same x, whatever their content.
   */
  return (
    <>
      <span className="picker-label" data-picker-row="provider" data-picker-label="">
        Provider
      </span>
      <span className="picker-provider mono" data-picker-row="provider" title={session.provider ?? undefined}>
        {session.provider ?? "—"}
      </span>

      <label className="picker-label" data-picker-row="model" data-picker-label="" htmlFor={`model-${session.id}`}>
        Model
      </label>
      <span className="picker-controls" data-picker-row="model">
        <span className="picker-field">
          {/*
            * The SHORTENED view, drawn over the select; the select beneath keeps full option text.
            *
            * A native `<select>` renders the selected option's text in its closed state, so "compact when closed,
            * complete when open" is not expressible through option text alone — and both halves are required
            * here: the header must stay identifying while the list must stay readable, because picking from
            * truncated names is how you choose the wrong model.
            *
            * `aria-hidden` because it is a visual restatement of the select's own value: a screen reader should
            * hear the FULL name once, from the select, rather than a shortened one twice. The `title` carries the
            * full value for a pointer, so no one has to decode an elision to find out which model is in use.
            */}
          <span className={`picker-display mono${usable ? "" : " is-disabled"}`} aria-hidden="true" title={fullLabel}>
            {/* In its own element so the label can be ELLIPSIZED where the control is narrower than the cap: a flex
                container cannot clip its own text with an ellipsis, so a long label in the 340px companion ended in a
                cut glyph. See `.picker-display-text`. */}
            <span className="picker-display-text">{modelLabel}</span>
          </span>
          <select
            id={`model-${session.id}`}
            ref={selectRef}
            className="picker-select"
            title={fullLabel}
            // Controlled by the session, not by local state: the shown value is Pi's, so a refused change leaves
            // the select exactly where it was instead of showing the requested value.
            value={models === undefined ? "" : currentKey(session, models)}
            disabled={!usable}
            /*
              Fetch on the FIRST interaction, and open only once there is something to show (issue reported from
              use: "when selecting a model from the first time, i cant see all available models, i need to reopen
              it").

              A native `<select>` builds its popup at the moment it opens — `mousedown` — and never re-renders it
              while it is up. So `onMouseDown={ask}` inevitably produced a popup containing only the placeholder
              option, and the catalogue that arrived 200 ms later was drawn into the closed control. The second
              click worked because the data was already there. No amount of re-rendering fixes that; the open has
              to wait.

              `preventDefault` on mousedown suppresses the default open, the click still lands, and `showPicker()`
              is called once the answer is in. `showPicker` needs a user gesture — which is why this runs from the
              handler rather than from an effect when `models` arrives.
            */
            onMouseDown={(event) => {
              if (models !== undefined) return; // known already: let the browser open it
              event.preventDefault();
              ask();
              waitForCatalogue();
            }}
            // Keyboard users never fire mousedown: Enter/Space on a focused select opens it directly.
            onKeyDown={(event) => {
              if (models !== undefined) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              ask();
              waitForCatalogue();
            }}
            onFocus={ask}
            onChange={(event) => {
              const [provider, ...rest] = event.target.value.split("/");
              if (provider !== undefined && rest.length > 0) onSelect(provider, rest.join("/"));
            }}
          >
            {/*
              The current value must exist as an option or the select cannot display it. When the catalogue has
              not loaded, this is the only entry — which is why the select reads as the model rather than as empty.

              The MODEL alone, not `provider/id` (issue #163): the provider is named on the line above, and repeating
              it here put it on two lines. The full identity is on the overlay's and the select's `title`.
            */}
            {models === undefined && <option value="">{session.model ?? "—"}</option>}
            {/*
              An EMPTY catalogue keeps its own answer, scope or no scope. "Pi reports no models" is a definitive reply;
              showing the reader an empty list because their scope was measured against it would turn that reply into
              "your list is empty", which is a different problem with a different fix.
            */}
            {models !== undefined && models.length === 0 && <option value="">no models available</option>}
            {/* Full names, deliberately: this list is where a model is chosen, and the overlay covers the closed
                control only. Truncating here would put the elision where the decision is made. */}
            {models !== undefined && view === undefined && modelsByProvider(models).map((group) => (
              <optgroup key={group.provider} label={group.provider}>
                {group.models.map(optionFor)}
              </optgroup>
            ))}
            {view !== undefined && (
              <>
                {/* The model in force, when the reader's list does not name it. See `currentOutsideScope`. */}
                {currentOutsideScope && currentModel !== undefined && (
                  <optgroup label="in use">
                    {optionFor(currentModel)}
                  </optgroup>
                )}
                {modelsByProvider(view.models).map((group) => (
                  <optgroup key={group.provider} label={group.provider}>
                    {group.models.map(optionFor)}
                  </optgroup>
                ))}
                {/*
                  Kept and marked, never pruned: a provider that is unreachable for a minute must not erase the
                  reader's list. `disabled` because Pi does not report these models at all, so there is nothing for
                  `set_model` to accept — the entry stays visible and removable from the list dialog instead of
                  becoming a request that cannot succeed.
                */}
                {view.unavailable.length > 0 && (
                  <optgroup label="not available from Pi">
                    {view.unavailable.map((ref) => (
                      <option key={refKey(ref)} value={refKey(ref)} disabled>
                        {ref.id} · {ref.provider}
                      </option>
                    ))}
                  </optgroup>
                )}
              </>
            )}
          </select>
        </span>
        {/*
          ONE labelled affordance to everything Pi offers (issue #265).

          The word is what makes scoping honest rather than a hidden filter: with a list in force the count says how
          many models are being withheld, and with no list the label says what the control is FOR, which is the only
          way to discover that a list can be made at all. Not rendered without `onManageModels` — see the prop.
        */}
        {onManageModels !== undefined && models !== undefined && models.length > 0 && (
          <button
            type="button"
            className="btn btn-quiet picker-scope"
            aria-haspopup="dialog"
            title="Choose the models the picker offers. Every model Pi reports stays available."
            onClick={(event) => onManageModels(event.currentTarget)}
          >
            {scoped ? `All ${models.length} models` : "Choose my models"}
          </button>
        )}
        {/* Thinking sits on the model's line: the levels are per-model, so a change to one invalidates the other,
            and the provider is the only thing here that needs a line of its own. */}
        {thinking}
      </span>
      {/* The notes span the block rather than sitting inside a row, so a long message cannot widen the label
          column. `data-picker-row` places them across both columns. */}
      {/*
        `data-picker-label` must NOT be on the note.
        
        It was, which put the note in the LABEL column — a `auto`-width column sized by its widest label (`Provider`,
        `Model`, `Thinking`). So "reading the model list…" was rendered into that narrow column, overflowed it, and
        appeared as a clipped fragment at the far right of the header (`img_25`: the stray `read…` past `Thinking`).
        The note spans both columns instead, which is what the comment below always intended.
      */}
      {loading && (
        <span className="picker-note" data-picker-row="note">
          reading the model list…
        </span>
      )}
      {/* The list says it, not just the control that shows it: an entry that is marked but never explained leaves the
          reader wondering whether the model is gone or the app is. `warn` because it is a fact they may have to act on.
          Only when there IS one — a standing note about a condition that does not hold is noise. */}
      {view !== undefined && view.unavailable.length > 0 && (
        <span className="picker-note warn" data-picker-row="note">
          {view.unavailable.length === 1
            ? "1 model in your list is not available from Pi."
            : `${view.unavailable.length} models in your list are not available from Pi.`}
        </span>
      )}
    </>
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
