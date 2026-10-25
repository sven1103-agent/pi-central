/**
 * History — past sessions, searchable by content (US-4).
 *
 * The prototype listed 40 rows that did nothing when clicked; history that cannot be resumed
 * is just a log file. This makes each row actionable, and is honest about the two ways resuming
 * can fail:
 *
 *   - the recorded directory no longer exists, in which case Pi would exit 1 in RPC mode, so it
 *     is refused BEFORE spawning (resume.ts) — and the refusal offers a way forward (US-5);
 *   - Pi Central never moves a session between directories (ADR-0008), so the offered action is
 *     resume in place or start fresh, never "continue elsewhere".
 */
import { useState } from "react";
import type { HistoricalSession } from "@pi-central/protocol";
import { formatAge } from "../format.ts";
import { searchHistory } from "../store.ts";
import { CopyButton } from "./CopyButton.tsx";

export function HistoryView({
  history,
  historyTotal,
  onResume,
  home,
}: {
  history: HistoricalSession[];
  /** Total on disk, which may exceed the loaded page. */
  historyTotal: number;
  onResume: (session: HistoricalSession) => void;
  home: string | undefined;
}) {
  const [query, setQuery] = useState("");
  const [refused, setRefused] = useState<HistoricalSession | undefined>(undefined);
  const results = searchHistory(history, query);

  return (
    <div className="history">
      <div className="history-search">
        <input
          type="search"
          value={query}
          placeholder="Search sessions by content, project, or name"
          aria-label="Search sessions"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query.length > 0 && (
          <button type="button" className="btn" onClick={() => setQuery("")}>
            Clear search
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <div className="empty" style={{ padding: 0 }}>
          <h2>No sessions on disk yet</h2>
          <p>
            History comes from <span className="mono">~/.pi/agent/sessions/</span>. A session
            appears here after its first message.
          </p>
        </div>
      ) : results.length === 0 ? (
        <div className="empty" style={{ padding: 0 }}>
          <h2>No sessions match “{query}”.</h2>
          <button type="button" className="btn" onClick={() => setQuery("")}>
            Clear search
          </button>
        </div>
      ) : (
        <>
          <p className="hint" style={{ marginBottom: 12 }} aria-live="polite">
            {results.length} of {history.length} session{history.length === 1 ? "" : "s"}
            {/* Say when the loaded set is a page. Presenting 500 of 1115 as a total would be a
                half-truth, and the honest version is one short clause. */}
            {historyTotal > history.length && (
              <> · searching the {history.length} most recent of {historyTotal}</>
            )}
          </p>
          {results.map((session) => (
            <HistoryRow
              key={session.path}
              session={session}
              home={home}
              onSelect={() => {
                if (!session.cwdExists) {
                  // Refused before spawning: Pi exits 1 on a missing directory in RPC mode.
                  setRefused(session);
                  return;
                }
                onResume(session);
              }}
            />
          ))}
        </>
      )}

      {refused && <ResumeRefusal session={refused} onDismiss={() => setRefused(undefined)} />}
    </div>
  );
}

function HistoryRow({
  session,
  home,
  onSelect,
}: {
  session: HistoricalSession;
  home: string | undefined;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="history-row" onClick={onSelect}>
      <span className="h1">
        <strong>{session.name ?? "Untitled session"}</strong>
        {session.scratch && <span className="chip chip-scratch">scratch</span>}
        {!session.cwdExists && <span className="chip chip-awaiting-approval">directory is gone</span>}
      </span>
      <span className="project" title={session.cwd}>
        {abbreviate(session.cwd, home)}
      </span>
      <p className="first">{session.firstMessage || "(no messages)"}</p>
      <span className="meta">
        <span>{formatAge(session.modifiedMs)}</span>
        <span>{session.messageCount} msgs</span>
        <span>{formatBytes(session.bytes)}</span>
      </span>
    </button>
  );
}

/**
 * The refusal, with a way forward.
 *
 * Two facts must survive: the directory is gone, and Pi Central will not move the session.
 * A user who reads only the first sentence would expect a "continue elsewhere" button, so the
 * second is stated explicitly.
 */
function ResumeRefusal({
  session,
  onDismiss,
}: {
  session: HistoricalSession;
  onDismiss: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onDismiss} role="presentation">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="refusal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="refusal-title">This session's directory is gone</h3>
        <p style={{ marginBottom: 12 }}>
          The directory this session worked in no longer exists:
        </p>
        <pre className="cmd" style={{ marginBottom: 12 }}>
          {session.cwd}
        </pre>
        <p style={{ marginBottom: 16 }}>
          Restore it, or start a new session in the directory you want to work in. Pi Central
          does not move a session between directories.
        </p>
        <div className="dialog-actions" style={{ marginTop: 0 }}>
          <button type="button" className="btn" onClick={onDismiss}>
            Close
          </button>
          <CopyButton text={session.cwd} label="Path" />
        </div>
      </div>
    </div>
  );
}

function abbreviate(path: string, home: string | undefined): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
