# Principles

Nine rules this project holds itself to. They are the reason several constraints and invariant tests
exist, and the reason some obvious conveniences were refused.

The README carries a three-line summary; this is the full set.

1. **Isolation is the feature.** Never trade per-session sandboxing for convenience.
2. **The orchestrator is the trust boundary.** It stays local, holds no untrusted content, and
   never executes model output.
3. **Pi is the source of truth.** Do not re-implement session semantics; consume RPC and the
   persisted session tree.
4. **Additive, not a replacement.** Pi Central supervises `pi`; it does not fork it.
5. **Local first.** No telemetry, no network egress beyond providers Pi already calls.
6. **Untrusted content is inert.** Transcripts and file contents are strings to display, never
   markup to execute — see [ADR-0006](decisions/0006-untrusted-markdown-rendering.md).
7. **Confine the agents, not the user.** Safehouse constrains model-generated actions in a workdir.
   The orchestrator is a user-level app acting as the user, on the user's files — see
   [ADR-0007](decisions/0007-filesystem-access-model.md).
8. **Never state something false.** A displayed value that is wrong is a defect, not a cosmetic
   issue: this project has shipped misleading counts, a mislabelled session id, and a permission
   error reported as a missing directory, and treats each as a bug.
9. **A peer, not a configurator.** Pi Central does not write into a user's Pi environment — no
   skills, no extensions, no settings. It reads what exists and writes only its own state. A
   defense does not require a new artifact in the environment it defends, and any setup a session
   needs is a documented action the user takes (see [docs/AGENT-SETUP.md](AGENT-SETUP.md)).
