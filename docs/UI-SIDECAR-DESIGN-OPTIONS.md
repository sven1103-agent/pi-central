# UI sidecar: current design vs a containerised MCP browser

**Status:** comparison for a decision that has not been made. Nothing here is implemented.
**Parent:** [ADR-0015](decisions/0015-ui-sidecar.md) - **Issue:** [#276](https://github.com/sven1103-agent/pi-central/issues/276)

This document exists because the question keeps returning in the same form -- *"why not just run Playwright's
MCP server, maybe in Docker, one per session?"* -- and the answer is different for each half of it:

- **The server: measured and rejected.** Not because it fails to render, but because **nothing in it enforces what
  a client may call** (Phase 0B).
- **The container: not evaluated.** It is a plausible improvement, and it is a *different* improvement than it
  looks like.

The two layers are constantly confused, so the diagrams separate them deliberately. A container changes **what
confines the browser**. It does not change **what a session may ask for**. Only the four verbs do that.

---

## 1. Today: four verbs, a sibling sandbox, one pinned port

Two confinement decisions, both enforced **host-side**, which is the property everything else rests on.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  ┌─────────────────────────┐                 ┌──────────────────────────┐  │
│  │ Pi Central UI           │                 │ Orchestrator             │  │
│  │ the window you look at  │ ◄─ loopback ─►  │ UNSANDBOXED (ADR-0002)   │  │
│  │                         │                 │ owns the verb set and    │  │
│  └─────────────────────────┘                 │ the URL policy           │  │
│                                              └──────────────────────────┘  │
│                                                            ┴ spawn         │
│                                                            │               │
│                                                            ▼               │
│  ┌─────────────────────────┐                 ┌──────────────────────────┐  │
│  │ SESSION (sandboxed)     │                 │ SIDECAR (a sibling)      │  │
│  │ pi + its tools          │                 │ Chrome --no-sandbox      │  │
│  │ the AGENT               │                 │ egress pinned to         │  │
│  │                         │◄────────────────│ localhost:48001 only     │  │
│  │ dev server :48001       │                 │                          │  │
│  │                         │                 │ one port, one way        │  │
│  └─────────────────────────┘                 └──────────────────────────┘  │
│                                                                            │
│    MCP over HTTP + bearer token: the only way the agent reaches Chrome     │
└────────────────────────────────────────────────────────────────────────────┘
```

### What the agent can ask for

Nothing about CDP, Chrome, scripts or selectors. Only:

| Verb | What it does | What it cannot do |
|---|---|---|
| `capture` | returns a PNG as an image block | navigate anywhere but the one origin |
| `probe` | overflow / contrast / overlap / console, as a verdict | take a selector and an assertion |
| `act` | one click on one element | type, upload, run script, evaluate |
| `info` | describe the sidecar | anything else |

Dispatch is **host-side** (`sidecar-control.ts`). A verb arrives, is matched against a closed set, and either
becomes a fixed CDP operation or is refused. **No verb accepts a CDP method name, an expression, a script, or a
file path.** That is the whole design: the agent cannot compose an operation, only choose one.

### The three properties this buys, and where each lives

| Property | Enforced by | Can the agent change it? |
|---|---|---|
| A session sees **one port** | the rendered Seatbelt fragment | no -- 0600 file, outside the workdir |
| A session gets **four verbs** | host-side dispatch in the orchestrator | no -- it is not in the session at all |
| **Only the owning session** reaches its sidecar | bearer token on every request | no -- 24 random bytes, held by the orchestrator |

---

## 2. The naive MCP alternative: the same browser, a much wider door

This is `@playwright/mcp` as a sibling, which is what "just use the MCP server" means concretely. Everything above
about confinement is unchanged; only the surface differs.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ┌──────────────────────┐                ┌────────────────────────────────┐ │
│ │ Pi Central UI        │ ◄─ loopback ─► │ Orchestrator                   │ │
│ └──────────────────────┘                │ owns nothing about the browser │ │
│                                         └────────────────────────────────┘ │
│                                                          ┴ spawn           │
│                                                          │                 │
│                                                          ▼                 │
│ ┌──────────────────────┐                ┌────────────────────────────────┐ │
│ │ SESSION (sandboxed)  │                │ @playwright/mcp                │ │
│ │ pi + its tools       │                │ Chrome from /Applications      │ │
│ │ the AGENT            │                │                                │ │
│ │                      │ ◄────────────────────────── the port            │ │
│ │ dev server :48001    │                │ NO per-tool permission         │ │
│ │                      │                │                                │ │
│ │                      │                │                                │ │
│ └──────────────────────┘                └────────────────────────────────┘ │
│                                                                            │
│  25 TOOLS reachable by anything that can see the port, including:          │
│    browser_evaluate        run arbitrary code in the page                  │
│    browser_run_code_unsafe  the same, and named as such                    │
│    browser_file_upload      hand the page a file the agent chose           │
│  None of these can be withheld host-side: measured, Phase 0B.              │
└────────────────────────────────────────────────────────────────────────────┘
```

### The measurement that ends it

Phase 0B asked the only question that matters: **can the host narrow the tool list?**

| Question | Method | Result |
|---|---|---|
| Does the server withdraw a tool on request? | its `README`, exhaustively | **no such option.** `--blocked-origins` filters URLs; there is no `--allowed-tools` |
| What is exposed? | `tools/list` | **25 tools**, including `browser_evaluate`, `browser_run_code_unsafe`, `browser_file_upload` |
| Can a client narrow it? | `--exclude-tools` in Pi's config | yes -- **presentation only**, and the agent can edit that config |
| **Can a session bypass that narrowing?** | `tools/call browser_evaluate`, **no auth header** | **200 -- it executed and answered** |

That last row is the argument. A client that never declares `browser_evaluate` still reaches it, because **the
server is the only enforcement point and it enforces nothing**. MCP has no per-tool authorization without its
experimental `oauth` mode.

Two smaller measured facts: the server binds **IPv6-only** (`127.0.0.1` refused; `localhost` and `[::1]` answer),
and it starts a **persistent Chrome from `/Applications`** by default -- `--isolated` prevents the profile, not the
app.

**So the choice is not "four verbs or the MCP server".** It is "four verbs, or a general-purpose browser driver
reachable by every session on the machine".

---

## 3. The container idea: what it fixes, and what it leaves exactly as it was

Worth taking seriously. One container per session is architecturally coherent, and it removes a real weakness.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Orchestrator (unsandboxed) -- spawns both, owns the verbs either way       │
└────────────────────────────────────────────────────────────────────────────┘
      │ spawn                                  │ spawn + docker run
      ▼                                        ▼
┌──────────────────────────────────┐    ┌────────────────────────────────────┐
│ SESSION (sandboxed)              │    │ CONTAINER (own namespaces)         │
│ pi + its tools: the AGENT        │    │ Chrome, which needs NO             │
│                                  │    │ --no-sandbox in here               │
│ dev server :48001                │◄   │                                    │
│ (the page it wrote)              │    │ its own filesystem, PIDs and       │
│                                  │    │ network -- so the dev port         │
│                                  │    │ can be 5173 in EVERY session       │
│                                  │    │                                    │
│                                  │    │                                    │
└──────────────────────────────────┘    └────────────────────────────────────┘

The arrow is the whole difference: the browser is now reached at a MAPPED ADDRESS
instead of a pinned port -- which is the open question in section 4, not a solved one.
```

### Genuinely better

| Gain | Why it matters |
|---|---|
| **A second wall behind the fragment** | today the renderer's *only* confinement is one policy file, because `--no-sandbox` is mandatory. The ADR states that as a known negative; a container is the defence in depth that is missing |
| **Namespace isolation, not configuration** | session A's browser cannot see session B's dev server by *kernel* rule, not by a rule we rendered correctly |
| **No `--no-sandbox`** | Chrome keeps its own sandbox inside the container. A real reduction in the renderer's exposure |
| **Ports stop colliding** | each container has its own network namespace, so every session can use 5173. That deletes assigned ports, ordinals, the held-port skip and the reaper |

### Completely unchanged

| Unchanged | Why |
|---|---|
| **The 25 tools** | a container changes *where* the server runs, not *what a client may call*. `browser_evaluate` is still reachable inside the container |
| **No per-tool authorization** | still nothing in MCP short of `oauth` |
| **So the four verbs stay** | the container replaces the **fragment**, never the **verb set** |

Which is the distinction to hold on to:

```
  WHAT A SESSION MAY ASK FOR   -->  four verbs, dispatched host-side
                                    the SAME in both designs, and in Docker

  WHAT CONFINES THE RENDERER   -->  today: one Seatbelt fragment + --no-sandbox
                                    Docker: namespaces + Chrome's own sandbox
```

### The costs, stated plainly

| Cost | Detail |
|---|---|
| **Docker as a hard prerequisite** | today the sidecar needs only macOS. Every session would need a running engine |
| **Start cost on every session** | ~1-2 s per container, and the sidecar is spawned **eagerly** with each session -- so it is on the critical path of sessions that never use the browser |
| **Reaching the dev server** | the dev server lives on the host, so the pin becomes an **address mapping** instead of a port. **Unmeasured:** whether `host.docker.internal` can be pinned to one port as tightly as `localhost:48001` is today |
| **Image supply chain** | a pinned digest to ship or build, and an update story |
| **One more way to fail** | engine missing, container not up, wrong network mode -- each looks like "the browser is broken" |

---

## 4. Recommendation, and the two measurements that decide it

**Keep the current design. Write the container as a hardening slice, not a redesign**, gated on two measurements
that are cheap and decisive:

1. **Can `host.docker.internal` be pinned to a single port?** If not, the container makes egress *looser* than the
   fragment it replaces, and today's design is better on the axis that matters most.
2. **What does one container cost to start, and to keep resident?** If it is ~1.5 s and a few hundred MB per
   session, eager-per-session is untenable, and a shared container with per-session contexts reintroduces the
   cross-session question the port pin exists to answer.

If both come back favourable, the container becomes a clean improvement to the **renderer** layer, and **not one
line of the verb set changes** -- which is the sign the layers are in the right order.

---

## 5. What would change this answer

Recorded so it can be re-opened on evidence rather than on preference:

- **MCP gains per-tool authorization** (`oauth` scopes or equivalent) **and** the server supports it. Then the
  25-tool surface could be narrowed at the enforcement point, and "just use the MCP server" becomes real.
- **A container mapping tighter than a port rule**, i.e. the dev server reachable by exactly one container on
  exactly one port. Then the container strictly dominates the fragment.
- **A browser tool with a narrow, non-composable surface** appearing upstream. The four verbs exist because no
  server offered one; if one does, our dispatch has less to justify.