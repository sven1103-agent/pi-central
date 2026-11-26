# Result: the keychain is not ported by Box — it is replaced, and that is a debt forgiven

**Status:** spike addendum. Answers a question the first write-up skipped: what happens to the
keychain (C13, ADR-0010 §6, Amendment 4).
**Issue:** [#303](https://github.com/sven1103-agent/pi-central/issues/303)
**Harness:** [harness/check-keychain-claim.sh](harness/check-keychain-claim.sh)

## The verdict, in one line

**Box has no keychain source at all, and does not need one — but the replacement covers provider
keys only, so our `gh` token and SSH identity would need a route or a file, and one of them is
something Box does not send.**

That is not a port of C13. It is the deletion of C13 and the creation of two smaller problems, and
the difference matters because three of the four things the keychain machinery exists for are
*our own inventions for problems Box does not have*.

## What the keychain actually does today

The first two write-ups treated "the credential model" as one thing. It is four, and they port
differently:

| Job | Where | Portable? |
|---|---|---|
| Provider keys, resolved by a `!security` command out of `auth.json` | C13, ADR-0010 §6, Amendment 1 | **Dissolves.** A route replaces it. |
| The `gh` token | `GH_CONFIG_DIR`, ADR-0010 §3 | **Replaced by a route, with a caveat** (below). |
| The SSH key and commit signing | ADR-0010 §4, Amendment 3 | **Files, not a keychain.** Ports unchanged. |
| One lock-state probe per launch, so a reboot costs one dialog not N | Amendment 4, `keychain.ts` | **Dissolves entirely.** Nothing to probe. |

That last row is the interesting one. `keychain.ts` is 385 lines, `supervisor.ts` carries 40
keychain mentions, `capabilities.ts` 36, `transport.ts` 17, plus 24 tests across
`keychain.test.ts` and `supervisor-keychain.test.ts` — and every one of them exists because a macOS
keychain **locks**, **prompts**, and has a **user-wide search list**. Box has none of those
properties for a route-based secret. The entire Amendment 4 machinery, which took an issue (#269),
a reboot report, and a careful 8-second bound to get right, would be **deleted, not ported**.

That is the strongest single argument for Box in this whole spike, and it is the opposite of the
framing the brief used. The brief listed the keychain as a **high** cost to move. It is the
cheapest thing here, because it is the thing that stops existing.

## Measured: what replaces the provider key

Two runs, same pi, same empty agent directory, one variable between them:

```text
# CONTROL: empty agent dir, no env var
Warning: No models available. Use /login to log into a provider via OAuth or API key.
No API key found for the selected model.

# WITH a fake env key
401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},
     "request_id":"req_011ChRk4cbtWZawfeyGtdcLv"}
```

The control proves nothing was configured; the second proves pi **read the environment variable and
made a real API call** with it. So `ANTHROPIC_API_KEY` — the name `@box/anthropic` supplies — is a
key pi accepts without `auth.json` and without a keychain.

The keychain step is therefore real but avoidable, and the avoidance is exactly what a route does:

```toml
[egress.anthropic]
destinations = ["api.anthropic.com"]
secret.ref = "env://ANTHROPIC_API_KEY"
secret.header = "x-api-key"
secret.phantom_prefix = "sk-ant-"
```

Measured: the scheme list is closed and **contains no keychain**. `secret.ref` accepts `env://`,
`aws://`, `credsd://` and a vault plugin; the shipped plugins are `1password` and
`aws-secrets-manager`. So on a Mac, a provider key currently in the login keychain must move to one
of those four — and `env://` is the one that keeps the key in the shell rather than on disk.

**What is lost, stated plainly:** today the provider key is encrypted at rest and never appears in a
process environment. Under a route it is either in the operator's shell environment (`env://`), or
in a vault (`1password`), or held by a signing daemon (`credsd`). Box's design decision is explicit
that the secret never enters the box — but it does live somewhere the operator chose, and a naive
`env://` setup trades "encrypted at rest" for "in the environment". That is a regression in exactly
one dimension, and it is the operator's choice rather than a forced one.

## The two things Box does not replace, and one it does not send

### The `gh` token: a route exists, and the shipped pack declines it

`@box/gh`'s `pack.toml` says so itself, in its own header:

> The pack sends no token, because a tool pack cannot hold a route. **gh hands git the route's
> stand-in as a Basic password, which the box does not swap, so git over HTTPS to github.com gets
> no credential from that route.**

So `box run gh` can reach the API with a route declared in the *profile*, but `git push` over HTTPS
would send the **placeholder** as the password. That is not a subtle failure: it is a push that
authenticates as nothing. Our current mechanism — an agent-owned `hosts.yml` under `GH_CONFIG_DIR`,
with a real token in it — does work, and Box would need it kept as a file rather than replaced by a
route.

That is a genuine loss of the model but not of the capability: the token stays in the agent tree
exactly as it is today. It is worth recording because the brief guessed the keychain was the hard
part and the token the easy part, and the truth is the other way round.

### SSH and signing port unchanged

ADR-0010 §4 and Amendment 3 deliberately made the agent's SSH identity **files** — a key, a `config`
pointed at by `core.sshCommand`, an `allowed_signers` file — precisely so no ssh-agent was needed.
A Box profile grants those files, and `@box/git` already sets `GIT_CONFIG_GLOBAL`, `GIT_AUTHOR_*` and
its own `core.sshCommand` handling. Nothing about that needs a keychain, so nothing about it changes.

## What Box does to the "the agent never holds the secret" claim

The first write-up said Box's model is "strictly stronger" than ADR-0010. That is true of provider
keys and **false of the token**, which the agent still holds in a file. The accurate statement is that
Box is stronger where a route applies and identical where a file applies, so the claim belongs to the
per-credential table rather than to the credential model as a whole. This is the correction the
keychain question forced, and it is why the table above is per-job.

## What this costs if we do port

| Work | Size |
|---|---|
| Delete `keychain.ts` and Amendment 4's machinery | **−385 lines, −24 tests** — a deletion, not a port, and **only after** the command-keys are gone (measured below) |
| Replace provider-key resolution with routes | one `[egress.<provider>]` block per provider |
| Keep `gh` as a file, or accept no HTTPS push | currently **keep it** — the route does not cover push |
| Keep SSH and signing as files | no change |
| Move the provider key out of the login keychain | operator action, one vault or one export |
| `capabilities.ts`'s keychain finding | deleted, and its `unreachable`/`not-provisioned` distinction survives for the other four |

The two findings in `capabilities.ts` that are worth keeping — *not provisioned* versus *provisioned
but unreachable*, and C12's "a denied read is not an absent file" — are about the shape of a
misdiagnosis, not about keychains, and they transfer to whatever replaces it.

## What would prove this wrong

- ~~That pi ignores `ANTHROPIC_API_KEY` when `auth.json` has a `!command`.~~ **Tested, and it does.** The
  configured key wins, so this is no longer a way to be wrong `-` it is the finding below, and the reason
  the deletion has to come after the configuration change.
- **That a route can be made to cover `git push`.** The `@box/gh` header says a tool pack cannot hold
  a route; a *profile* route plus `secret.placement = "basic_auth"` is documented for other hosts, so
  the gap may be the pack's structure rather than the mechanism. Worth one test against
  `github.com` if a port is ever taken seriously.
- **That the lock-state problem returns.** It should not, because a route has no lock. But `credsd://`
  is a daemon with its own session refresh, and a run that outlives its credential is the same defect
  in a new place — Box documents that it refreshes per request, which is why it is the better choice
  than `env://` for a long-lived session.

## Measured: pi prefers the configured key, and my first answer was wrong

This question decides whether a Box route can replace the keychain at all — *does a route's
environment variable reach pi when `auth.json` carries a `!security` command for that provider?*

My first answer was "yes, the environment wins". It was wrong, and it was wrong for the reason this
repository keeps writing down: I inferred it from a `401`. Both a keychain value and an environment
value are rejected by the real API, so *"a call was made"* says nothing about **which value made it**.
The header is the only evidence, and I had not looked at it.

[harness/check-precedence.sh](harness/check-precedence.sh) looks at it. A local proxy, named by a
`models.json` `baseUrl`, prints the `x-api-key` header that actually leaves the process. Three arms,
so the answer cannot be an artefact of one configuration:

```text
== A: auth.json command AND an environment variable ==
      x-api-key sent: command-value
PASS  the auth.json command wins over the environment variable

== B: no auth.json, environment variable only (control) ==
      x-api-key sent: environment-value
PASS  with no configured key, the environment variable is used

== C: auth.json command only, no environment variable (control) ==
      x-api-key sent: command-value
PASS  the command works on its own, so arm A is not an artefact

RESULT: pi PREFERS the configured key. A route cannot replace a keychain key while
        auth.json still carries a !security command - the command must be removed first.
```

**This is the most consequential measurement in the keychain answer, and it inverts the bill.** A
route is *shadowed* by a configured command-key. A ported Pi Central that added `[egress.<provider>]`
and left `auth.json` alone would send the keychain value, keep the keychain grant, keep C13, and keep
every lock prompt — while looking like it had replaced the keychain with a route. That is exactly the
shape of defect C15c records: a mechanism that appears replaced and is only shadowed.

## The corrected bill, in the right order

| Step | Work | Size |
|---|---|---|
| 1 | **Remove `!security` command-keys** from the agent's provider config | configuration, not code — **and the step that actually deletes C13** |
| 2 | Add `[egress.<provider>]` routes so a key still arrives | one block per provider |
| 3 | Delete `keychain.ts` and Amendment 4's machinery | −385 lines, −24 tests, *only after step 1* |
| 4 | Keep `gh` as a file (the shipped route does not cover `git push`) | no change |
| 5 | Keep SSH and signing as files | no change |

Step 1 before step 3 is not a preference. If the keychain code is deleted while `auth.json` still
carries a `!security` key, the session silently loses its provider key — arm A says the command is
what supplies it — and every session starts, reports `idle`, and cannot think. That is C13 exactly,
reproduced by a port that did the steps in the intuitive order.

## Why this is still the cheapest item, despite the correction

The correction changes *who does the work*, not the size of it. `keychain.ts` (385 lines), the
40 keychain references in `supervisor.ts`, the 36 in `capabilities.ts`, the 17 in `transport.ts`, and
the 24 tests in `keychain.test.ts` and `supervisor-keychain.test.ts` exist because a macOS keychain
**locks**, **prompts**, and has a **user-wide search list**. A Box route has none of those properties.
So the code is still deleted rather than ported — it just cannot be deleted first.

That ordering is worth one sentence in any ADR, because it is the kind of thing a port gets wrong
once and then debugs for a week: **adopting routes does not remove the keychain; removing the
command-keys does.**

## The honest one-liner for the ADR

**A Box port would delete our keychain code rather than port it — after, not before, the agent stops
resolving provider keys through `!security` commands — replace provider-key resolution with a route
(a gain, at the cost of where the key rests), and leave the `gh` token as a file because the shipped
pack declines to route it for `git push`.**

