#!/bin/sh
# Is the @box/pi pack's "pi doesn't run on Linux yet" still true?
#
# This is the one claim the platform-independence recommendation turned on, and the first version of
# RESULT.md quoted it instead of dating it. It is a documentation line, and documentation goes stale;
# the containment behaviour it describes is code, and code has a commit date.
#
# The check is therefore a bisect of the claim against the behaviour, using the upstream repository
# rather than a local copy, because the installed pack and the repository can disagree and the
# installed pack is the one that goes stale:
#
#   1. Does the pack still make the claim? (it does, as of the run that wrote this)
#   2. Does the design document that owns the behaviour still say Linux REFUSES executable memory?
#   3. Which commit changed that behaviour, and when?
#
# Needs `gh` authenticated (it reads a public repository) and `base64`. No Box install, no Linux host.
#
#   sh check-pi-linux-claim.sh
#
# Exit 0 only when the claim is CONTRADICTED by the behaviour, which is the finding.
set -u

repo=strands-agents/box
fail=0
say() { printf '%s\n' "$*"; }
check() { if [ "$2" -eq 0 ]; then say "PASS  $1"; else say "FAIL  $1"; fail=1; fi; }

command -v gh >/dev/null 2>&1 || { say "FAIL  gh is not on PATH; this check reads the upstream repository"; exit 1; }
command -v base64 >/dev/null 2>&1 || { say "FAIL  base64 is not on PATH"; exit 1; }

# A file from the repository at a ref, decoded.
at() {
    gh api "repos/$repo/contents/$1?ref=$2" --jq .content 2>/dev/null | base64 -d 2>/dev/null
}

say "== 1. the pack still claims pi does not run on Linux =="
pack=$(at resources/packs/pi/README.md main)
printf '%s' "$pack" | grep -q "doesn't run on Linux"
check "the @box/pi README on main still carries the Linux limitation" "$?"

say ""
say "== 2. the behaviour document says the opposite =="
# platform-differences.md is the table an operator reads to learn what the kernel allows where.
pd=$(at docs/design/platform-differences.md main)
printf '%s' "$pd" | grep -q "Linux permits writable-and-executable"
check "platform-differences.md says Linux permits writable-and-executable mmap/mprotect" "$?"

say ""
say "== 3. the commit that changed it, and when =="
# Bisected by hand once; pinned here so the date is checkable rather than remembered.
commit=f7af148b
date=$(gh api "repos/$repo/commits/$commit" --jq .commit.author.date 2>/dev/null)
subject=$(gh api "repos/$repo/commits/$commit" --jq '.commit.message | split("\n")[0]' 2>/dev/null)
say "      $commit  $date"
say "      $subject"
printf '%s' "$subject" | grep -qi "allow executable memory on Linux"
check "the commit is the one that allowed executable memory for JIT runtimes" "$?"

# The commit must predate the pack's claim being trusted, i.e. the claim is older than the fix.
pack_age=$(gh api "repos/$repo/commits?path=resources/packs/pi/README.md&per_page=1" --jq '.[0].commit.author.date' 2>/dev/null)
say "      pack README last touched: $pack_age"
[ "$(printf '%s\n%s\n' "$date" "$pack_age" | sort | head -1)" = "$date" ]
check "the JIT fix predates the last edit to the pack README, so the README was not re-tested after it" "$?"

say ""
if [ "$fail" -eq 0 ]; then
    say "RESULT: the claim is STALE - the behaviour changed before the pack README was last edited"
else
    say "RESULT: inconclusive - re-read the two documents above by hand"
fi
exit "$fail"
