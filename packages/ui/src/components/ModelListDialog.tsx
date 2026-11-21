/**
 * Every model Pi offers, and which of them are the reader's (issue #265).
 *
 * ## Why one surface for both jobs
 *
 * The picker itself keeps the native `<select>`: it is keyboard- and screen-reader-correct with no code, and the
 * scoped list is rendered straight into it, so the control a reader already knows keeps working. What a `<select>`
 * cannot do is carry a second action per row — an option is one click, and there is no way to put "add this to my
 * list" inside one. So the list is edited here, where a row can hold two controls.
 *
 * Putting BOTH jobs on this surface is what keeps the requirement "the full catalogue stays reachable" true with one
 * affordance rather than two: the same dialog that shows the whole catalogue is where a model is scoped, so the full
 * list is never merely a list to read.
 *
 * ## Why a modal, and why the SHELL renders it
 *
 * The picker lives in the transcript's header: a 340px sticky column inside `.transcript`, which is `overflow-y: auto`
 * and so clips both axes. An absolutely positioned panel would be cut off at the transcript's edge.
 *
 * A fixed one is no better, and this is the part that is easy to get wrong: `.transcript-shell` declares
 * `container-type: inline-size`, and a size container is the CONTAINING BLOCK for fixed descendants. So a
 * `.modal-backdrop` rendered from inside the picker would cover the conversation only, while `aria-modal="true"` claimed
 * the whole window — a keyboard reader would discover the lie by tabbing into the rail behind it.
 *
 * So this is a dialog rendered at the shell, which is the app's one dialog idiom (`Settings`, `ShortcutSheet`): a
 * surface that needs room gets the room, the backdrop covers the window it claims to, and `Esc`/focus behave as they do
 * everywhere else here.
 *
 * ## Two sections, no duplicates
 *
 * "Your models" is the reader's list in their own order, stale entries included and marked. "All other models" is the
 * rest of the catalogue, grouped by provider. A model appears in exactly one of them, so a star never has to be
 * interpreted twice, and the union of the two sections is still exactly what Pi offers.
 *
 * ## Selecting a model is not the same as scoping one
 *
 * Clicking a name sends `set_model`, exactly as the picker's own list does — the header then shows what Pi reports
 * back. Clicking the star only touches the stored list: it never changes the session's model, which is the requirement
 * that makes this surface safe to open while a run is in progress.
 *
 * ## A choice CLOSES the dialog, a star does not
 *
 * The choice changes the session, and the session's header is behind the backdrop. Reported from use: the model changed
 * and nothing appeared to happen, because the only visible evidence was a row quietly marking itself "in use" while the
 * header — the one place the change is legible — was covered. A refusal has the same problem: Pi reports it into the
 * header, so a dialog left open would hide a failed selection and make it look like a successful one.
 *
 * So a choice closes the dialog and lets the header speak. That is what a native `<select>` does too, so the two
 * surfaces that change a model end the same way. Starring stays open: it edits the reader's LIST, several models are
 * usually marked in a row, and closing on each press would make the surface unusable for the job it is for.
 */
import type { ModelOption } from "@pi-central/protocol";
import { useEffect, useId, useRef, useState } from "react";
import {
  filterCatalogue,
  isScoped,
  refKey,
  scopeEntries,
  toggleScope,
  type ModelRef,
  type ModelScope,
} from "../model-scope.ts";
import { modelsByProvider } from "../store.ts";

export interface ModelListDialogProps {
  /** The catalogue, as Pi reported it. Never empty: the shell only opens this on a non-empty one. */
  catalogue: readonly ModelOption[];
  scope: ModelScope;
  /** `${provider}/${id}` of the session's model, so the row in use says so. */
  currentKey: string | undefined;
  /**
   * Whether choosing a model here reaches the session.
   *
   * False while the session is starting, stopped or failed: a `set_model` has nothing to act on, and offering the action
   * anyway would trade one honest disabled control for a request that cannot succeed. Scoping stays available either
   * way — it is the reader's list, not the session's state.
   */
  canSelect: boolean;
  onScopeChange: (next: ModelScope) => void;
  onSelect: (provider: string, modelId: string) => void;
  onClose: () => void;
}

/** The word for one model in a row: the human name when Pi reports one, the id otherwise. */
function label(model: ModelOption): string {
  return model.name ?? model.id;
}

export function ModelListDialog({
  catalogue,
  scope,
  currentKey,
  canSelect,
  onScopeChange,
  onSelect,
  onClose,
}: ModelListDialogProps) {
  const [query, setQuery] = useState("");
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  /**
   * The star that was just pressed, and where the equivalents live.
   *
   * Pressing a star MOVES the row: the two sections are exclusive, so adding a model removes its row from the catalogue
   * and creates a new one at the top, which is a different DOM node. React therefore drops focus to `<body>` — and a
   * keyboard reader would have to tab in from the top of the page after every single press, on a list whose whole
   * purpose is marking several models in a row.
   *
   * So the key of the pressed model is remembered, and focus is put back on its star once the new scope has rendered.
   * That is why refs are kept in a map instead of one ref: the element being focused is a DIFFERENT element from the one
   * clicked, and only the model's `provider/id` is the same.
   */
  const pressed = useRef<string | null>(null);
  const starRefs = useRef(new Map<string, HTMLButtonElement>());

  /*
   * The latest `onClose`, read through a ref, so the listener below is registered once — the same shape `ShortcutSheet`
   * uses and for the same reason: `App` passes inline arrows, and an effect that re-registers on every render would
   * re-run its work (there, moving focus) on every socket event.
   */
  const closeOf = useRef(onClose);
  closeOf.current = onClose;

  useEffect(() => {
    // The filter is the fastest way through 406 rows, so it is where focus belongs on open — and it is what makes `Esc`
    // work without a click. Mount-only: "on open" is a mount, not an update.
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // `stopPropagation`, because the composer's escape ladder is also on the window: without it one Escape would close
      // this dialog AND stop the focused session's run — two actions for one keystroke. `ShortcutSheet`'s rule.
      event.stopPropagation();
      closeOf.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const entries = scopeEntries(scope, catalogue);
  const scoped = scope.models.length > 0;

  /*
   * The filter is applied to each section separately rather than to one flattened list, so a match in the reader's own
   * list cannot disappear behind a heading that says there are none.
   *
   * Unavailable entries are matched on `provider/id`, which is all there is of them: Pi reports nothing about a model
   * it no longer offers, so there is no name to search.
   */
  const needle = query.trim().toLowerCase();
  const matchesText = (text: string): boolean => text.toLowerCase().includes(needle);
  const visibleEntries = needle === "" ? entries : entries.filter((entry) =>
    entry.model === undefined
      ? matchesText(refKey(entry.ref))
      : matchesText(label(entry.model)) || matchesText(entry.model.id) || matchesText(entry.model.provider));

  const unscoped = catalogue.filter((model) => !isScoped(scope, model.provider, model.id));
  const others = filterCatalogue(unscoped, query);
  const othersByProvider = modelsByProvider(others);

  /** Toggle one model in the scope, without touching the session's model. */
  const toggle = (ref: ModelRef): void => {
    pressed.current = refKey(ref);
    onScopeChange(toggleScope(scope, ref));
  };

  /**
   * Choose a model for the session, and close.
   *
   * See the header: the change lands in the header behind this dialog, so a dialog that stayed open would hide the
   * result of the action it just performed. Closing IS the feedback — the reader returns to the header, where the model
   * and any refusal Pi reports are both visible.
   */
  const choose = (ref: ModelRef): void => {
    onSelect(ref.provider, ref.id);
    closeOf.current();
  };

  // Focus follows the pressed star into whichever section it lands in; see `pressed`.
  useEffect(() => {
    const key = pressed.current;
    if (key === null) return;
    pressed.current = null;
    starRefs.current.get(key)?.focus();
  }, [scope]);

  /** The star, which is a toggle button: filled when the model is in the list. */
  const star = (ref: ModelRef, name: string) => {
    const present = isScoped(scope, ref.provider, ref.id);
    const key = refKey(ref);
    return (
      <button
        type="button"
        className={`model-star${present ? " is-in" : ""}`}
        aria-label={present ? `Remove ${name} from your models` : `Add ${name} to your models`}
        aria-pressed={present}
        title={present ? "Remove from your models" : "Add to your models"}
        // Null is ignored on purpose: React detaches a changed inline `ref` before reattaching it, so honouring the null
        // would delete the entry the effect is about to look up.
        ref={(element) => {
          if (element !== null) starRefs.current.set(key, element);
        }}
        onClick={() => toggle(ref)}
      >
        {/* Decorative: the accessible name above already says which action this is and on what. */}
        <span aria-hidden="true">{present ? "★" : "☆"}</span>
      </button>
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal model-list"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="model-list-head">
          <h3 id={titleId}>Models</h3>
          {/*
            The scope's LIMIT stated where the list is edited, because the two are easy to confuse: it narrows the
            picker, it does not change what Pi can reach. The note at the bottom of this dialog repeats the half that
            matters for storage (per machine), which is the other thing a reader would reasonably assume otherwise.
          */}
          <p className="model-list-lede">
            {scoped
              ? "Your list is what the picker offers. Every model Pi reports stays available here."
              : "No list yet, so the picker offers every model Pi reports. Star the ones you use and it will offer just those."}
          </p>
          <input
            ref={searchRef}
            type="search"
            className="model-list-search"
            /* The label is the placeholder plus this name: a dialog this small does not need a second visible line, and
               a search field with no accessible name is a field a screen reader announces as "edit text". */
            aria-label="Filter models"
            placeholder="Filter models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {/* The ONLY scroller, so the title and `Done` stay put — the failure `.keys-body` documents. */}
        <div className="model-list-body">
          {scoped && (
            <section className="model-group" aria-labelledby={`${titleId}-mine`}>
              <h4 id={`${titleId}-mine`}>
                Your models <span className="model-count">{scope.models.length}</span>
              </h4>
              {visibleEntries.length === 0 ? (
                <p className="model-empty">No model in your list matches “{query.trim()}”.</p>
              ) : (
                <ul className="model-rows">
                  {visibleEntries.map((entry) => {
                    const key = refKey(entry.ref);
                    return (
                      <li key={key} className="model-row">
                        {entry.model === undefined ? (
                          /*
                            Kept and MARKED rather than dropped (the requirement, and the reason
                            `parseModelScope` does not prune): a provider that is briefly unreachable would otherwise
                            erase the reader's list. It is not a select action, because Pi does not offer the model —
                            but the star stays, so a stale entry can always be removed. A stale entry with no way out
                            would be worse than one that vanished.
                          */
                          <span className="model-pick is-unavailable">
                            <span className="model-name mono">{entry.ref.id}</span>
                            <span className="model-meta">
                              {entry.ref.provider} · not available from Pi
                            </span>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="model-pick"
                            disabled={!canSelect}
                            onClick={() => choose(entry.ref)}
                            title={`Use ${label(entry.model)}`}
                          >
                            <span className="model-name">{label(entry.model)}</span>
                            <span className="model-meta mono">
                              {entry.ref.provider}
                              {key === currentKey ? " · in use" : ""}
                              {entry.model.reasoning === true ? " · thinking" : ""}
                            </span>
                          </button>
                        )}
                        {star(entry.ref, entry.model === undefined ? entry.ref.id : label(entry.model))}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          <section className="model-group" aria-labelledby={`${titleId}-all`}>
            <h4 id={`${titleId}-all`}>
              {scoped ? "All other models" : "All models"} <span className="model-count">{others.length}</span>
            </h4>
            {others.length === 0 ? (
              /*
                Two different nothings. "Everything is already in your list" is success; "nothing matches" is a filter to
                widen. Saying the first as the second would tell the reader to keep typing when they are done.
              */
              <p className="model-empty">
                {unscoped.length === 0
                  ? "Every model Pi reports is in your list."
                  : `No model matches “${query.trim()}”.`}
              </p>
            ) : (
              othersByProvider.map((group) => (
                <div key={group.provider} className="model-subgroup">
                  <h5>{group.provider}</h5>
                  <ul className="model-rows">
                    {group.models.map((model) => (
                      <li key={`${model.provider}/${model.id}`} className="model-row">
                        <button
                          type="button"
                          className="model-pick"
                          disabled={!canSelect}
                          onClick={() => choose({ provider: model.provider, id: model.id })}
                          title={`Use ${label(model)}`}
                        >
                          <span className="model-name">{label(model)}</span>
                          <span className="model-meta mono">
                            {model.id}
                            {`${model.provider}/${model.id}` === currentKey ? " · in use" : ""}
                            {model.reasoning === true ? " · thinking" : ""}
                          </span>
                        </button>
                        {star({ provider: model.provider, id: model.id }, label(model))}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        </div>

        <div className="model-list-foot">
          <p className="model-list-note">
            Your list is stored on this machine, not in the session, so every session here shares it.
            {canSelect ? "" : " This session cannot change model while it is not running."}
          </p>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
