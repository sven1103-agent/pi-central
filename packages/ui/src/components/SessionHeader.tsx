/**
 * The focused session's compact header: identity, state, and the controls that change the session.
 *
 * ## What this replaces, and why it was three strips
 *
 * The workspace used to open with THREE full-width rows before the conversation started — a session header
 * (name, location, model pickers), a metrics strip (`ctx · tokens · cost · msgs`), and a legend promising what
 * the tool frames meant. Plus a `run-track` hairline between them, and the trace's own header below the
 * transcript. Each row was defensible alone; together they made the conversation look like a viewport squeezed
 * between control panels, and they gave secondary information the same structural weight as the task.
 *
 * The review's finding was specific: *"the workspace uses three different widths"* — narrow conversation, wide
 * composer, distant controls — which reads as components assembled rather than a composed workspace.
 *
 * So: one header. Identity and state on the left, configuration on the right, telemetry folded into a
 * disclosure that states the same numbers on one line when opened. Nothing is removed; the detail is one click
 * away and the default view is the conversation.
 *
 * ## What stays in the header, and why
 *
 * - **Name, state, location**: "which session am I in, is it doing anything, where does it work".
 * - **Model and thinking**: a session-level decision like rename or stop, and the value the reader is most
 *   likely to want to check while a run costs money. Both keep `ModelPicker`/`ThinkingPicker`, with their
 *   loading, error and next-turn semantics unchanged.
 * - **Context pressure** when it is high: the one metric that changes what the reader should do. It is also
 *   stated in words (`ctx 84% full`), never by colour alone.
 *
 * Telemetry is NOT hidden selectively: the disclosure shows every value the strip showed, through the same
 * formatters (`formatContext`, `formatTokens`, `formatCost`). One value, one format — the rule that a real
 * screenshot broke when the inspector said `127.2M` and the strip said `12723914`.
 */
import { useState } from "react";
import type { LiveSession } from "@pi-central/protocol";
import { displayName, formatContext, formatCost, formatTokens, headerLocation } from "../format.ts";
import { stateLabel } from "../store.ts";
import { InlineRename } from "./InlineRename.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ThinkingPicker } from "./ThinkingPicker.tsx";

export function SessionHeader({
  session,
  home,
  models,
  modelError,
  onRequestModels,
  onSelectModel,
  thinking,
  onRequestThinkingLevels,
  onSelectThinkingLevel,
  onRename,
}: {
  session: LiveSession;
  home: string | undefined;
  models: Parameters<typeof ModelPicker>[0]["models"];
  modelError: string | undefined;
  onRequestModels: () => void;
  onSelectModel: (provider: string, modelId: string) => void;
  thinking: { levels: string[] | undefined; error: string | undefined };
  onRequestThinkingLevels: () => void;
  onSelectThinkingLevel: (level: string) => void;
  onRename: (name: string) => void;
}) {
  /*
   * Local, and deliberately not persisted: it is a peek at numbers that are also in the Session panel. State
   * that only decides whether a four-word line is showing does not deserve a storage key or a prop.
   */
  const [usageOpen, setUsageOpen] = useState(false);
  const pressure = session.contextPercent !== null && session.contextPercent >= 80;

  return (
    <header className="session-header">
      <div className="title">
        <h2>
          {/*
            In its own element so it can truncate: a bare text node cannot carry `text-overflow`, and without it
            the name pushes the controls out of the header. Double-click renames (issues #78, #79).
          */}
          <InlineRename
            value={displayName(session)}
            label="Session name"
            className="session-name"
            onCommit={onRename}
          />
          {session.scratch && <span className="chip chip-scratch">scratch</span>}
          <span className={`chip chip-${session.state}`}>{stateLabel(session)}</span>
          {session.pending > 0 && <span className="chip chip-pending">+{session.pending} queued</span>}
        </h2>
        <span className="where" title={session.cwd}>
          {headerLocation(session, home)}
        </span>
      </div>

      {/*
        Context pressure earns its place in the header because it changes what the reader should do. Everything
        else is a fact to look up, so it is behind the disclosure beside it.
      */}
      {pressure && (
        <button
          type="button"
          className="header-pressure"
          aria-expanded={usageOpen}
          onClick={() => setUsageOpen((open) => !open)}
          title="Context is nearly full — compaction or a new session may be needed"
        >
          {formatContext(session.contextPercent)}
        </button>
      )}

      <button
        type="button"
        className="header-usage"
        aria-expanded={usageOpen}
        onClick={() => setUsageOpen((open) => !open)}
        title="Tokens, cost and message count"
      >
        Usage
      </button>

      {usageOpen && (
        /*
          The strip, restored on demand. Same formatters as before, so a value cannot be spelled two ways on one
          screen; `+N queued` stays here as well as in the chip, because the chip can be missed while reading.
        */
        <div className="header-usage-line" role="status">
          <span>{formatTokens(session.tokensTotal)} tok</span>
          <span>{formatCost(session.cost)}</span>
          <span>{session.messageCount} msgs</span>
          <span className={pressure ? "warn" : ""}>{formatContext(session.contextPercent)}</span>
          {session.pending > 0 && <span className="warn">+{session.pending} queued</span>}
        </div>
      )}

      {/*
        ONE block, two rows, one label column (issue #163): a `<label>` and a value of different widths cannot be
        aligned by eye, which is what put three left edges in a 120px space before.
      */}
      <div className="picker picker-grid">
        <ModelPicker
          session={session}
          models={models}
          error={modelError}
          onRequest={onRequestModels}
          onSelect={onSelectModel}
          thinking={
            // On the MODEL's row: the levels are per-model, so a change to one invalidates the other. The provider
            // is the only thing here that needs a line of its own, being a read-only fact.
            <ThinkingPicker
              session={session}
              levels={thinking.levels}
              error={thinking.error}
              onRequest={onRequestThinkingLevels}
              onSelect={onSelectThinkingLevel}
            />
          }
        />
      </div>
    </header>
  );
}
