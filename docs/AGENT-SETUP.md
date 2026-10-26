# Setting up an agent identity

Pi Central runs every session as an **agent identity**, not as you: the session has its own
`gitconfig`, its own `gh` config, its own SSH key, and (normally) its own keychain. This page is the
recipe for creating that identity on a fresh machine.

It is the companion to [ADR-0010](decisions/0010-agent-credential-identity.md), which explains
*why* the boundary is drawn here. This page is only *how*.

> **Why you need this at all.** Without an agent identity, a session either inherits your GitHub
> account, your SSH keys, and your git identity — a prompt injection then acts *as you* — or, once
> the policy denies those paths, has no credentials at all and cannot push or sign. The identity is
> what makes "the agent did it" a different statement from "you did it".

## Two ways to get one

| | When | What Pi Central does |
|---|---|---|
| **Adopt an existing tree** | You already have `~/.agent` (e.g. from [`pi-sandbox-hardening`](https://github.com/sven1103-agent/pi-sandbox-hardening)) | Reads and verifies only, **never writes** |
| **Create your own** | A fresh machine | Same — it *verifies* what you built, and warns when something is missing |

`resolveAgentRoot` adopts `~/.agent` when it exists and carries a **marker** file
(`agent.keychain-db`, `gitconfig`, `gh/`, or `ssh/`); otherwise it falls back to a
Pi-Central-owned tree under the state root. Set `PI_CENTRAL_AGENT_ROOT` to point at a tree
explicitly.

**Pi Central never writes this tree.** It may be shared with an interactive terminal setup, and two
writers on one credential tree is drift. Everything below is a command *you* run.

## The recipe

Substitute your agent's name for `example-agent`. The example uses `~/.agent` as the root.

### 1. Create the root and a dedicated SSH key

```bash
export AGENT_ROOT="$HOME/.agent"
mkdir -p "$AGENT_ROOT/ssh"
chmod 700 "$AGENT_ROOT"

# No passphrase, deliberately: sessions are headless RPC processes with no TTY, so a
# passphrase-protected key cannot be unlocked (ADR-0010 §1). The key is 0600 instead.
ssh-keygen -t ed25519 -N "" -C "example-agent" -f "$AGENT_ROOT/ssh/github_login_ed25519"
```

### 2. Point SSH at that key, and nothing else

```bash
cat > "$AGENT_ROOT/ssh/config" <<'EOF'
Host github.com
    HostName github.com
    User git
    IdentitiesOnly yes
    AddKeysToAgent no
    UseKeychain no
EOF
```

### 3. Pin GitHub's host keys

```bash
ssh-keyscan -t rsa,ecdsa,ed25519 github.com > "$AGENT_ROOT/ssh/known_hosts" 2>/dev/null
```

Pinning them up front matters: an unpinned host key prompts on first connect, and a headless
session cannot answer.

### 4. Add the wrapper that makes the tree self-contained

```bash
cat > "$AGENT_ROOT/ssh/ssh-github.sh" <<'EOF'
#!/bin/bash
# Resolves everything relative to this script, so the agent identity works regardless of HOME.
SSH_DIR="$(cd "$(dirname "$0")" && pwd)"

exec ssh \
  -F "${SSH_DIR}/config" \
  -o "IdentityFile=${SSH_DIR}/github_login_ed25519" \
  -o "UserKnownHostsFile=${SSH_DIR}/known_hosts" \
  "$@"
EOF
chmod +x "$AGENT_ROOT/ssh/ssh-github.sh"
```

**`-F` is the load-bearing flag.** It *replaces* the per-user `~/.ssh/config` rather than adding to
it. That is why the agent can authenticate with `~/.ssh` closed entirely — and it is why a session
cannot reach your host aliases through git.

### 5. Let the agent verify its own signatures

```bash
echo "example-agent $(cut -d' ' -f1,2 "$AGENT_ROOT/ssh/github_login_ed25519.pub")" \
  > "$AGENT_ROOT/ssh/allowed_signers"
```

Verification then consults the agent's own trust file instead of your host configuration.

### 6. Write the agent's gitconfig

Replace `/path/to` with the absolute `$AGENT_ROOT` — git wants absolute paths here.

```bash
cat > "$AGENT_ROOT/gitconfig" <<EOF
[user]
	name = example-agent
	email = example-agent@users.noreply.github.com
	signingkey = $AGENT_ROOT/ssh/github_login_ed25519
[core]
	sshCommand = $AGENT_ROOT/ssh/ssh-github.sh
[credential]
	helper =
[commit]
	gpgsign = true
[tag]
	gpgsign = true
[gpg]
	format = ssh
[gpg "ssh"]
	allowedSignersFile = $AGENT_ROOT/ssh/allowed_signers
EOF
chmod 600 "$AGENT_ROOT/gitconfig"
```

Four details are each individually load-bearing, and getting any one wrong is **silent** — the
commit still succeeds and is simply unsigned (see [ADR-0010 Amendment 2](decisions/0010-agent-credential-identity.md#amendment-2--signing-was-configured-off-and-a-key-check-cannot-see-it)):

- `signingkey` — `ssh` takes a **path**, so this is what selects the key.
- `gpg.format = ssh` — without it, git defaults to OpenPGP and finds no `gpg`.
- `gpg.ssh.allowedSignersFile` — without it a signature is produced but `verify-commit` fails.
- `helper =` — clears any inherited credential helper, closing the route where a helper shells
  out to `gh auth git-credential` and resolves a token from your login keychain.

### 7. Register the key with GitHub

Add the **public** key to the agent account:

```bash
cat "$AGENT_ROOT/ssh/github_login_ed25519.pub"
```

Paste it at <https://github.com/settings/keys> — signed in **as the agent account**, not as
yourself. For commit signing to show as *Verified*, it must also be registered as a **signing key**
on that account (the same key works for both).

### 8. Give the agent its own GitHub CLI authentication

```bash
mkdir -p "$AGENT_ROOT/gh"
GH_CONFIG_DIR="$AGENT_ROOT/gh" gh auth login
```

Sessions read `GH_CONFIG_DIR`, so this is the account `gh` inside a session acts as.

### 9. Provider keys, so the session can think

The model keys are **not** identity credentials and cannot be agent-owned: the agent runs on your
model access. Pi resolves them through `auth.json` indirections such as
`!security find-generic-password -ws 'litellm'`, which needs a reachable keychain.

- **Adopting `~/.agent`** — if a keychain already holds the keys, nothing to do.
- **Fresh machine** — create an agent keychain following the hardening project's procedure. This
  writes the **user-wide keychain search list**, which has been observed to drop
  `login.keychain-db` and break your own shell's keychain access; the prior art needed a restore
  trap. Do it deliberately, and verify `security list-keychains` afterwards.

A session with no reachable keychain **starts and then cannot reach a model** (C13), which is why
this step is here rather than treated as optional.

## Verify it, rather than trusting it

With `HOME` pointed at an empty directory — proving nothing here depends on your own `~/.ssh`:

```bash
export AGENT_ROOT="$HOME/.agent"
env HOME=/tmp/empty-home \
  GIT_CONFIG_GLOBAL="$AGENT_ROOT/gitconfig" GIT_CONFIG_SYSTEM=/dev/null \
  "$AGENT_ROOT/ssh/ssh-github.sh" -G github.com | grep -E 'identityfile|userknownhostsfile'
```

Expect both paths to be inside `$AGENT_ROOT`. Then authenticate and make a signed commit:

```bash
env HOME=/tmp/empty-home "$AGENT_ROOT/ssh/ssh-github.sh" -T git@github.com
#  -> Hi <agent-name>! You've successfully authenticated...

cd "$(mktemp -d)" && git init -q . && echo x > f && git add f
env GIT_CONFIG_GLOBAL="$AGENT_ROOT/gitconfig" GIT_CONFIG_SYSTEM=/dev/null \
  git -c gpg.ssh.program=/usr/bin/ssh-keygen commit -q -m probe
git log --show-signature -1
#  -> Good "git" signature for example-agent with ED25519 key SHA256:...
```

`Good "git" signature` is the check that matters. `git config --list` is **not** an adequate
substitute: it resolves includes and merges system and global config, so it reports the *effective*
value while hiding that the agent's own file disagrees — and it reads your host configuration to do
so.

## What Pi Central checks, and what it warns about

At session start, `assessAgentCapabilities()` inspects the store (metadata only — it never reads a
secret) and reports `not-provisioned` separately from `unreachable`. It **never blocks a session**:
an agent with no identity is still useful for work that does not need one.

The signing audit (`signing.ts`) reports the configuration, not just the key's presence, because
"is the key there?" cannot tell "the agent signed" from "nothing happened". When it finds a problem
it prints the exact `git config --file` commands to fix it and **does not run them** — the tree may
be yours, not Pi Central's.

## What the policy denies

Sessions run with `~/.ssh` denied **wholesale** — the directory, not a list of key names. A session
cannot read `~/.ssh/config`, `known_hosts`, or any private key, and cannot list the directory.

This is safe precisely because of step 4: `ssh -F` replaces the per-user config, so the agent never
needs your `~/.ssh`. The SSH identity above is fully self-contained — the recipe's verification
steps are run with an empty `HOME` to demonstrate that.

Your ssh-agent is closed on two layers: the spawn environment never passes `SSH_AUTH_SOCK` (C11),
and the policy denies both the `~/.ssh/agent` directory and the launchd `Listeners` sockets, since
a file deny does not cover `connect()` on a unix socket. An agent that could reach your agent could
sign as you **without reading any key file**, which is why this is denied even though the key files
are unreachable too.

## Known limitation

**The private key is plaintext at `0600`.** There is no keychain indirection for SSH — `ssh` reads
key files — so the alternative is a per-session agent requiring an interactive unlock, which a
headless session cannot provide (ADR-0010 §4). A managed agent was considered and rejected: with a
passphrase-less key it grants exactly what the file grants.

## See also

- [ADR-0010 — Agent credential identity](decisions/0010-agent-credential-identity.md), including
  both amendments
- [SANDBOX.md](SANDBOX.md) — the composed policy
- [CONSTRAINTS.md](CONSTRAINTS.md) — C11 (environment sanitization), C13 (keychain), C15a/C15b
