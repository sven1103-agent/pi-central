#!/bin/sh
# Which layer enforces what: is a Dogwood rule a boundary, or a decision behind one?
#
# This exists because the platform-independence write-up called the deny-set translation a portability
# finding, and a question about it ("Dogwood is a policy engine, not kernel hardening like SBPL") showed
# the framing was wrong. The correction is easy to write and easy to lose again, so it is asserted.
#
# Four facts, each from Box's own documentation or source rather than from the write-up:
#
#   1. Box says box.toml, not policy, sets what the workload's system calls reach - "and the operating
#      system enforces that".
#   2. seccomp "does not resolve pathnames", so the syscall filter is not a filesystem boundary.
#   3. a Linux filesystem refusal is a MOUNT VIEW overmount, described in the source as "strictly
#      stronger than a rule, and it is why the Linux half needs no path matching".
#   4. a refused path must exist at launch - "a refused file that does not exist yet has no lowering".
#
# Reads the installed Box package and the upstream repository. Starts nothing.
#
#   sh check-layer-distinction.sh [path-to-box-package]
set -u

repo=strands-agents/box
fail=0
say() { printf '%s\n' "$*"; }
check() { if [ "$2" -eq 0 ]; then say "PASS  $1"; else say "FAIL  $1"; fail=1; fi; }

command -v gh >/dev/null 2>&1 || { echo "FAIL  gh is not on PATH"; exit 1; }
command -v base64 >/dev/null 2>&1 || { echo "FAIL  base64 is not on PATH"; exit 1; }

at() { gh api "repos/$repo/contents/$1?ref=main" --jq .content 2>/dev/null | base64 -d 2>/dev/null; }

say "== 1. Box attributes system-call reach to box.toml, not to policy =="
policy=$(at docs/user/policy.md)
[ -z "$policy" ] && policy=$(at docs/user/reference/policy.md)
printf '%s' "$policy" | grep -qi 'sets what the workload'
check "the policy reference says box.toml (not policy) sets what system calls reach" "$?"

say ""
say "== 2. the syscall filter does not resolve paths, so it is not a filesystem boundary =="
le=$(at docs/design/linux-enforcement.md)
printf '%s' "$le" | grep -qi 'does not resolve pathnames'
check "linux-enforcement.md says seccomp does not resolve pathnames" "$?"

say ""
say "== 3. a Linux filesystem refusal is an overmount, i.e. a kernel view =="
view=$(at crates/containment/src/backend/linux/namespace/view.rs)
printf '%s' "$view" | grep -qi 'overmounts the grant'
check "view.rs plans a refusal as an overmount of the grant it defeats" "$?"
printf '%s' "$view" | grep -qi 'needs no path matching'
check "and says so outright: the Linux half needs no path matching" "$?"

say ""
say "== 4. and the view has a limit a rule does not: the path must exist at launch =="
printf '%s' "$view" | grep -qi 'does not exist yet has no lowering'
check "view.rs records that a refused path which does not exist cannot be lowered" "$?"

say ""
say "== 5. Dogwood is still a real default-deny engine - the correction is not a downgrade =="
printf '%s' "$policy" | grep -qi 'denies by default'
check "policy denies by default, so it is a genuine admission controller" "$?"

say ""
say "== 6. Box has a KERNEL backend on both platforms, so a port does not drop kernel enforcement =="
# Read from the shipped binary rather than a document: the helper reports its own backends and calls the
# same libc entry point Safehouse calls. A port that kept the policy engine and lost the backend would be
# the failure this asserts against.
pkg=${1:-}
if [ -z "$pkg" ]; then
    pkg=$(ls -d "${HOME:-/nonexistent}"/.strands/box/packages/*/ 2>/dev/null | head -1)
elif [ -d "$pkg/packages" ]; then
    :
else
    # An argument naming .../resources should be walked back to the package root.
    case "$pkg" in */resources) pkg=$(dirname "$pkg")/ ;; esac
fi
helper="${pkg%/}/strands-box-contain-trampoline"
if [ -x "$helper" ]; then
    strings "$helper" | grep -q 'macOS Seatbelt and, on Linux, the namespace'
    check "the shipped backend reports Seatbelt on macOS and namespaces on Linux" "$?"
    strings "$helper" | grep -q 'sandbox_init'
    check "and drives sandbox_init - the same kernel call Safehouse uses" "$?"
else
    say "FAIL  no containment helper at $helper"
    fail=1
fi

say ""
if [ "$fail" -eq 0 ]; then
    say "RESULT: TWO layers - a kernel view (or Seatbelt) enforces, Dogwood decides behind it."
    say "        Neither substitutes for the other, which is what DOGWOOD-VS-SBPL.md records."
else
    say "RESULT: FAILED - re-read DOGWOOD-VS-SBPL.md against the sources above"
fi
exit "$fail"
