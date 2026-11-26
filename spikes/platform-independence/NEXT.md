# Continuing the spike: the four things left, in the order they unblock each other

**Status:** open work, written down so it is not rediscovered.
**Issue:** [#303](https://github.com/sven1103-agent/pi-central/issues/303)
**Read first:** [RESULT.md](RESULT.md) · [KEYCHAIN.md](KEYCHAIN.md)

## What is already settled

Do not re-litigate these; each has a runnable check.

| Settled | Check |
|---|---|
| The deny set translates into Box's policy language, with one measured exception | `harness/check-translation.sh` |
| A broken policy is refused, so the check has teeth | same script, arm 2 |
| `net:connect` has no unix-socket field, so our ssh-agent deny has no counterpart | same script, arm 3 |
| Box has no keychain source, and does not route the `gh` token for `git push` | `harness/check-keychain-claim.sh` |
| pi prefers a configured `!security` key over a route's variable | `harness/check-precedence.sh` |
| The pack's "pi doesn't run on Linux" line predates the fix it describes | `harness/check-pi-linux-claim.sh` |

## 1. Does `pi` start in a Box on Linux? — the one experiment

This is the whole remaining question for option C. Everything above is a measurement; this one is a
**command**, and no amount of reading substitutes for it.

It was impossible from the machine that ran the spike: a Mac, itself inside Seatbelt, where `box run`
cannot bind its broker socket, so no workload of any kind starts. A hosted runner has a real kernel,
and `ubuntu-24.04-arm` is the architecture Box's own reference target uses.

[harness/linux-probe.yml](harness/linux-probe.yml) is that experiment as a workflow, `workflow_dispatch`
only so it never runs on an ordinary push:

```bash
cp spikes/platform-independence/harness/linux-probe.yml \
   .github/workflows/platform-independence-probe.yml
git add .github/workflows/platform-independence-probe.yml && git commit -m "probe: pi in a box on Linux"
gh workflow run platform-independence-probe.yml
gh run watch
```

It records the environment, clears the AppArmor user-namespace restriction the way Box's own CI does
(and says so if it cannot), installs Box and pi **through npm**, creates a profile, and then runs
`box run pi -- --version`.

### How to read the result, and how not to

The step keeps stdout and stderr in full rather than grepping, because the three outcomes are three
different findings and a summary line cannot tell them apart:

| Outcome | Meaning | What it does to the verdict |
|---|---|---|
| **exit 0** | pi started in the box | the pack's line is stale *in fact*, not only in date; option C is live |
| **exit 133, V8 / errno** | executable memory is still refused | the 2026-11-19 fix does not reach this path; option C blocked again, by a measured cause |
| **a namespace / `sudo` / `unshare` error** | the *host* refused the cage | says nothing about pi; the probe never reached the question |

That third row is why the workflow clears the userns knob first and prints `unshare(CLONE_NEWUSER): OK`
or a warning: this spike has already confused "the claim is stale" with "the thing works" once, and
the same confusion between "pi cannot run" and "the host would not let Box start" would be worse.

### What would make the probe itself untrustworthy

- **A profile that never composed.** If `box profile create` fails, the later steps fail for that
  reason. Read the `box profile show pi --full` output before the exit status.
- **pi installed by its own installer.** The `@box/pi` pack runs pi's script through node, and its
  troubleshooting says so. The workflow uses npm; an install by `curl … install.sh` would produce a
  launcher the box cannot run, and that failure is not about Linux.
- **`x86_64` where the reference target is ARM64.** The workflow defaults to `ubuntu-24.04-arm`. An
  x86 result is still useful — Box publishes an x86-64 build and its own CI runs one — but it is a
  different row of Box's support matrix (issue #46), and should be recorded as one.

## 2. Does a box that starts confine a unix socket?

The spike measured the *policy language* half of this: `net:connect` carries host, port, `ip4`, `ip6`
and nothing else, and a rule naming a socket-shaped field is refused. So our ssh-agent deny has no
counterpart, and a Box backend would close that socket by **not granting the path**.

What is unmeasured is whether that is sufficient — because no box would start. With #1 answered, this
becomes measurable: create a listener on a path the profile does not grant, and try to connect from
inside the workload. Expected `REFUSED`; a `CONNECTED` would mean the withheld grant is not a boundary
and the ssh-agent deny would be a genuine loss rather than a relocation.

The step in the workflow is deliberately `continue-on-error: true` and asks one question with a
`printf`, not a heredoc — an indented heredoc terminator does not close with `<<'DW'`, so the first
version of that step would have failed for a shell reason and read as a finding.

## 3. Does Box keep `pi`'s stdio byte-clean?

Pi Central speaks JSONL over the session's stdio (C7, LF-only). Box wraps the workload, prints notes
with coded prefixes to stderr, and prints its own progress. If any of that reaches the workload's
stdout, every session breaks in a way that looks like a Pi bug.

This is the highest-risk unknown for a port and the cheapest to test, because it needs no key: start
`pi --mode rpc` in a box, write one RPC frame, and check that the reply is a single parseable line.

```bash
# inside the box, with a box that starts:
pi --mode rpc <<< '{"type":"get_state"}' | head -1 | python3 -c \
  "import json,sys; json.loads(sys.stdin.readline()); print('clean JSONL')"
```

Worth doing next after #1, and independently of which option the decision takes — the answer bounds
what a Box backend would cost to integrate, even if Box is not adopted.

## 4. The policy-language gaps, enumerated

Three, and each is a line in a backend interface rather than a bug to fix:

1. **No unix-socket deny.** Item #2 measures whether that matters.
2. **Filesystem lists are exact-path only.** `"~/.ssh/*"` is refused: "must be exact and contain no
   pattern". Pi Central fits today by having already replaced its name patterns with a directory
   deny, which is luck of a fix rather than a property. A future rule needing a pattern cannot be
   expressed, and a backend interface must say so.
3. **A rule applies to the box's shell and Python, not to the agent's own file tools.** Those are
   confined by the filesystem lists instead. So the interface is not "a policy file and an argv": it
   is an argv, a policy whose `forbid` wins regardless of order, **and a statement of which file
   operations that policy covers**.

## What is NOT worth doing next

- **Re-reading the pack READMEs.** That is how the first two wrong answers were produced. Four of the
  claims in this spike were settled by running something, and two were contradicted by it.
- **Porting before #1.** The keychain work is real but it is a *deletion* ([KEYCHAIN.md](KEYCHAIN.md)),
  and deleting it before the configuration changes loses provider keys silently. Nothing in the
  keychain story is worth doing until the agent is known to run.
- **Deciding between options B and C now.** #1 decides it. If pi runs, C is cheap and B is
  unnecessary; if pi does not, B's interface is already specified by item #4.
