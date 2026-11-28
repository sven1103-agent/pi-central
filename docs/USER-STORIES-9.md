# User stories — Increment 9, Portable

What a person needs from platform independence, and why. Same conventions as
[USER-STORIES.md](USER-STORIES.md): written from the user's side, before deciding how to build it, each
with acceptance criteria that can **fail**.

**Status:** `proposed` → `accepted` → `built` → `verified`. Nothing here is built.
**Increment:** [INCREMENT-9-PORTABLE.md](INCREMENT-9-PORTABLE.md) · **Opened from:** [#303](https://github.com/sven1103-agent/pi-central/issues/303)

---

## Theme P — The product should not be macOS-shaped out of habit

Pi Central's own code barely assumes Darwin: **four** `process.platform` checks across `packages/`.
What makes it macOS-only is a dependency it does not own. These stories separate "we chose macOS" from
"we inherited macOS", because only the first is a decision.

### US-P1 — Run on Linux with real confinement
**Status:** proposed · **Priority:** high · **Constraint:** C10, ADR-0002

> As a person on Linux, I want to run Pi Central with each session confined to its working directory,
> so that handing a coding agent my project does not also hand it my whole machine.

**Context.** Today Safehouse refuses to run off Darwin (C10), so the honest answer to a Linux user is
"this product is not for you". The alternative already in the code is `direct` mode, which is labelled
`NO ISOLATION` — make the unsafe path the default for a platform, and the label stops being read.

**Acceptance criteria**

- A session on Linux starts with confinement, and a path outside its working directory is refused
  **by the kernel**, not by a rule the agent's own file tool can bypass.
- The refusal is demonstrated **against a permissive control run in the same harness**: the same probe
  succeeds when the grant is present and fails when it is absent. A confinement claim with no
  permissive run beside it is not evidence.
- The agent's **own file tools** are confined, not only a shell it starts. This is the criterion a port
  is most likely to miss, and the one to test first.
- Pi Central states which backend is in force, in the same words it uses for macOS today.
- A session on macOS behaves identically to today's, asserted by the existing suite rather than by a
  reviewer's memory.

**What would falsify this story.** A Linux session whose confinement depends on a deny the agent can
rephrase around — a path pattern, a rule in a policy file that does not bind file tools, or a grant
wider than the working directory.

### US-P2 — Keep the macOS boundary exactly as strong
**Status:** proposed · **Priority:** high · **Constraint:** C1, ADR-0002

> As a person already on macOS, I want a portable Pi Central to confine my sessions at least as
> strictly as it does now, so that supporting a second platform does not cost me the protection I had.

**Context.** The worry this story exists to answer is real and was misstated in the spike's own first
draft: "a policy engine is weaker than a kernel sandbox" is true, and irrelevant, because Box is both.
Measured: the shipped Box helper drives `sandbox_init` — the same kernel call Safehouse uses — and
emits the profile vocabulary our fragment already speaks (`file-read`, `subpath`, `network-outbound`,
`mach-lookup`).

**Acceptance criteria**

- On macOS a ported Pi Central still applies a **Seatbelt** profile. Asserted by observing the applied
  mechanism, not by reading documentation.
- Every deny the current fragment makes has an equivalent under the new backend, **or** is listed as an
  exception with a stated reason and a probe that shows what replaces it.
- The three known narrowings are stated in the UI or the docs rather than discovered: exact paths only,
  no unix-socket deny, and a refused path that must exist at launch.
- No configuration a user can set widens the sandbox beyond today's `FORBIDDEN_ENABLE` denylist.

**What would falsify this story.** A deny that the new backend can express but does not enforce, or a
port that silently drops the ssh-agent network deny because the new policy language has no field for it.

### US-P3 — The keychain stops being a startup gauntlet
**Status:** proposed · **Priority:** high · **Constraint:** C13, ADR-0010 §6, Amendment 4

> As a person whose machine just rebooted, I want to start Pi Central and answer **one** password
> prompt — or none — so that reopening my work does not begin with a dialog I have to fight.

**Context.** This is a shipped defect (#269) and a solved one: `keychain.ts`, 385 lines plus 24 tests,
exists so that a locked keychain costs one prompt rather than N, with an 8-second bound because the
desktop shell kills an orchestrator that prints no URL within 10 seconds. Every one of those lines
exists because a macOS keychain **locks**, **prompts**, and has a user-wide **search list**. A
route-based secret has none of those properties, so the code is *deleted* rather than ported.

**Acceptance criteria**

- A session reaches its model without any keychain read, on both platforms — asserted by a probe that
  fails if a keychain command is invoked.
- The deletion happens **after** the provider configuration stops naming a `!security` command, because
  measured, pi *prefers* a configured command-key over a route's environment variable. Deleting first
  loses the key silently: the session starts, reports `idle`, and cannot think.
- If any keychain probe remains, it still raises at most one prompt per launch and is still bounded.
- The warning a reader sees when a credential is unusable names the repair, and distinguishes *not
  provisioned* from *provisioned but unreachable* — the distinction #28 exists to preserve.

**What would falsify this story.** A ported session that still prompts after a reboot because
`auth.json` kept a command-key while a route was added beside it — the failure this story's second
criterion exists to prevent, and the one measured in
[KEYCHAIN.md](../spikes/platform-independence/KEYCHAIN.md).

### US-P4 — My GitHub identity still works, or I am told it does not
**Status:** proposed · **Priority:** high · **Constraint:** ADR-0010 §3, §4

> As a person whose agent pushes its own commits, I want a platform change to leave my agent's git and
> GitHub identity working — and if it cannot be made to work, I want to be told in one sentence what
> stopped working.

**Context.** Measured, and it is the opposite of what the spike first assumed: Box does **not** route the
GitHub token for `git push`. The shipped `@box/gh` pack says so itself — *"gh hands git the route's
stand-in as a Basic password, which the box does not swap, so git over HTTPS to github.com gets no
credential from that route."* Our current mechanism, an agent-owned `hosts.yml` under
`GH_CONFIG_DIR`, does work and must be **kept as a file** rather than replaced by a route.

**Acceptance criteria**

- A sandboxed session on either platform can commit as the agent and push over HTTPS, proven against
  the real remote rather than by reading configuration.
- A session whose token is absent says so **before** a push fails, naming the file or route it looked
  for.
- Commit signing either works or is reported as *not configured* — never silently unsigned, which is
  the defect [ADR-0010 Amendment 2](decisions/0010-agent-credential-identity.md) records.
- No route is trusted for a credential it cannot deliver. A route that would send a placeholder as a
  password is refused or reported, not relied on.

**What would falsify this story.** A push that authenticates as *nothing* and reports a generic 403 —
the precise failure the `@box/gh` pack documents and a port would inherit.

### US-P5 — I am never surprised by which isolation I got
**Status:** proposed · **Priority:** medium · **Constraint:** C10, principle 8

> As a person running Pi Central, I want to know at a glance what is confining my sessions and what its
> limits are, so that I can judge whether to trust it with a real repository.

**Context.** Pi Central has three isolation states today (sandboxed, `direct`/`NO ISOLATION`, and a
sidecar's own profile) and a port adds a fourth variable: which backend. A UI that says "sandboxed" when
the backend cannot deny a unix socket is a displayed value that is wrong, which principle 8 calls a
defect rather than a cosmetic issue.

**Acceptance criteria**

- `--check-config` names the backend, its mechanism, and its stated limits, in the same output on both
  platforms, and a machine-readable form is available.
- The UI never states a stronger guarantee than the backend provides. Where a limit exists (no
  unix-socket deny, exact paths only), it is stated where a reader would look for it.
- An unsupported platform is refused with a message that names the platform and the reason, not with a
  failed spawn.
- Nothing is claimed that a probe has not demonstrated; a limit that is unknown is labelled unknown.

**What would falsify this story.** A status line that reads "sandboxed" on a configuration where a probe
shows the boundary is absent.

### US-P6 — The decision is recorded, whichever way it goes
**Status:** proposed · **Priority:** high · **Constraint:** #303's deliverable

> As a maintainer, I want the platform question closed by an ADR — accept or decline, with the measured
> reason — so that it is not re-researched by the next person who wonders why this is macOS-only.

**Context.** #303 asks for "an ADR that either defines the backend boundary and names the second backend
to prove it, or records the decision not to port, with the reason and what would change it. A spike that
ends in 'it depends' has not finished." The spike finished the *research*; the decision is still open.

**Acceptance criteria**

- An ADR exists with one of two statuses, and neither of them is "proposed, pending more research".
- If it **accepts**, it names the interface (an argv, an order-independent policy, and a statement of
  which operations that policy covers) and the backend that proves it.
- If it **declines**, it states the measured reason and the specific observation that would change the
  decision — not "if users ask for it".
- [CONSTRAINTS.md](CONSTRAINTS.md) C10 and the README's requirements table are corrected to match,
  because both currently name *Safehouse* as the reason and the measured reason is wider.
- The spike's five harness checks are either promoted into CI or explicitly retired with a note saying
  where their evidence now lives.

**What would falsify this story.** A third spike on the same question, which is what this story exists to
prevent.

---

### US-P7 — The policy is mine, and I may only tighten it

**Status:** proposed · **Priority:** high · **Constraint:** deny-by-default, applied to configuration

> As an organisation adopting Pi Central, I want to change the sandbox policy to fit my own rules — and
> only ever make it stricter — so that I can adopt the product at all without weakening the isolation it
> promises.

**Context.** The deny set is a literal inside `fragment.ts` and the orchestrator reads no configuration
file at all (verified by searching `config.ts` and `server.ts` for `readFileSync`). So the policy is
Pi Central's, entirely. An organisation that must route model traffic through its own gateway, or that
must deny a path this project has never heard of, cannot adopt the product — and the constraint arrives on
day one, so "we will add an option later" does not help.

The obvious fix is the dangerous one. [POLICY.md](POLICY.md) measures Safehouse's own project-level
surface, `<workdir>/.safehouse`: it takes `key=value` options rather than policy expressions, so it
**widens** — a trusted file granted a path the appended fragment never named, three occurrences for one
path. Our layer cannot constrain what it does not name, and enumerating names is the failure C15c already
records ("a four-name deny list left `~/.gitconfig` readable while reporting the other three refused").

**Acceptance criteria**

- Exactly **one** profile ships, named `solo`, and it is the current deny set expressed as data rather
  than as a `const` — the rules do not change, only where they live and what they are called.
- An installation may add denies and exceptions in the state root, and every such change applies.
- An installation change that would **widen** the shipped boundary is **refused at load** with a message
  naming the rule, and the refusal is logged once — not merged, not silently dropped.
- Pi Central does **not** pass `--trust-workdir-config`, so a repository cannot widen the boundary by
  committing a file. Asserted, because a future caller could reintroduce the flag in one line.
- The shipped profile's digest is recorded and compared, so an upgrade that changes it is visible rather
  than inferred.
- The profile's name appears in the status a machine reports (US-P5), so a reader knows which policy they
  got.

**What would falsify this story.** An installation whose widening overlay is accepted silently — the
boundary would then depend on a file the session it governs can influence. Or a narrower overlay that is
refused, which would mean the rule was written as "no changes" rather than "only downward".

---

## Stories deliberately **not** written

Recorded so their absence is a decision rather than an oversight.

| Not written | Why |
|---|---|
| "Run on Windows" | Not measured, not designed, and Box names it as neither backend. A separate spike with its own evidence. |
| "Choose a backend in Settings" | A backend is not a preference: the isolation a session gets must not depend on a toggle a reader may not remember setting. It is a property of the installation. |
| "Fall back to no sandbox if the backend is missing" | This is #303 option D, and it makes the unsafe path the default. The existing `direct` mode is opt-in and labelled; a silent fallback is a different product. |
| "Use a container instead" | A container runtime is a different backend with a different credential story. Choosing two backends in one increment is how neither ships. |
