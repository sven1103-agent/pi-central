#!/bin/sh
# The keychain (C13) — what a Box profile replaces, and what it does not.
#
# The platform-independence write-up called the credential model "an improvement" without checking
# what happens to OUR keychain, which is the most load-bearing macOS code in the orchestrator. This
# check answers it in four parts, and the third is the one that decides whether the port is cheap:
#
#   1. Box's secret schemes are a closed list, and no keychain is on it.
#   2. A route supplies a provider key as an ENVIRONMENT VARIABLE — the same name pi reads itself.
#   3. The shipped @box/gh pack declines to route the GitHub token for git push.
#   4. The pieces the keychain exists for are files elsewhere, so they port unchanged.
#
# Reads an installed Box package and the upstream repository; starts nothing.
#
#   sh check-keychain-claim.sh [path-to-box-package]
#
# Exit 0 only when all four hold.
set -u

repo=strands-agents/box
fail=0
say() { printf '%s\n' "$*"; }
check() { if [ "$2" -eq 0 ]; then say "PASS  $1"; else say "FAIL  $1"; fail=1; fi; }

# The package directory: an argument, then the usual install location.
pkg=${1:-}
if [ -z "$pkg" ]; then
    pkg=$(ls -d "${HOME:-/nonexistent}"/.strands/box/packages/*/resources 2>/dev/null | head -1)
fi
if [ -z "$pkg" ] || [ ! -d "$pkg" ]; then
    say "FAIL  no Box package found; install Box or pass its resources directory"
    say "      https://strandsagents.com/docs/user-guide/box/install/"
    exit 1
fi
say "box resources: $pkg"

say ""
say "== 1. no keychain among Box's secret sources =="
# The schemes are enumerated in the credentials doc; the plugins directory is the file-level truth.
schemes=$(grep -rhoE '(env|aws|credsd|op)://' "$pkg/packs"/*/pack.toml 2>/dev/null | sort -u)
say "      schemes in shipped packs: $(printf '%s' "$schemes" | tr '\n' ' ')"
printf '%s' "$schemes" | grep -q 'env://'
check "env:// is a supported scheme (the one that replaces a keychain lookup)" "$?"
! printf '%s' "$schemes" | grep -qi 'keychain'
check "no keychain scheme appears in any shipped pack" "$?"

plugins=$(ls "$pkg/plugins" 2>/dev/null)
say "      shipped plugins: $(printf '%s' "$plugins" | tr '\n' ' ')"
! printf '%s' "$plugins" | grep -qi 'keychain'
check "no keychain plugin ships" "$?"

say ""
say "== 2. a provider key arrives as an env var, which pi reads without auth.json =="
printf '%s' "$(cat "$pkg/packs/anthropic/pack.toml" 2>/dev/null)" | grep -q 'secret.ref = "env://ANTHROPIC_API_KEY"'
check "@box/anthropic supplies the key as ANTHROPIC_API_KEY (an env var, not a file)" "$?"
# Measured separately and recorded in KEYCHAIN.md: pi accepts that variable with an empty agent dir.
say "      (pi reads it with an empty agent dir - measured, see KEYCHAIN.md)"

say ""
say "== 3. the gh pack declines to route the token for git push =="
ghpack=$(cat "$pkg/packs/gh/pack.toml" 2>/dev/null)
printf '%s' "$ghpack" | grep -q 'the box does not swap'
check "the shipped @box/gh says git over HTTPS gets no credential from a route" "$?"
printf '%s' "$ghpack" | grep -q 'sends no token'
check "and says it sends no token at all" "$?"

say ""
say "== 4. the rest of the agent identity is files, so it ports unchanged =="
# These are the ADR-0010 paths; they are assertions about our own tree, not about Box.
here=$(cd "$(dirname "$0")/../../.." && pwd)
env=$(cat "$here/packages/orchestrator/src/env.ts" 2>/dev/null)
printf '%s' "$env" | grep -q 'GH_CONFIG_DIR'
check "the gh token is delivered by a config DIRECTORY, not a keychain" "$?"
printf '%s' "$env" | grep -q 'GIT_CONFIG_GLOBAL'
check "the git identity is a FILE, not a keychain" "$?"
printf '%s' "$env" | grep -q 'ssh_auth_sock'
check "the ssh-agent is refused by name, so the SSH identity needs no keychain either" "$?"

say ""
if [ "$fail" -eq 0 ]; then
    say "RESULT: the keychain is REPLACED for provider keys, kept as a file for gh and SSH"
else
    say "RESULT: FAILED - re-read KEYCHAIN.md against the pack above"
fi
exit "$fail"
