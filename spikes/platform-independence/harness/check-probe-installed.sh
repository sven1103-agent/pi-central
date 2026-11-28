#!/bin/sh
# The probe workflow exists twice, and the two copies must not drift.
#
#   spikes/platform-independence/harness/linux-probe.yml   the canonical source, in the spike
#   .github/workflows/platform-independence-probe.yml      the installed copy GitHub will run
#
# Two copies is a deliberate cost: the spike must remain readable without the workflow existing, and
# GitHub only runs a file under .github/workflows. The failure a duplicate invites is silent -- an edit
# to one leaves the other older, and the run reports on a version nobody is reading. So the equality is
# asserted rather than assumed, the same way the repository asserts its version is declared once.
#
#   sh check-probe-installed.sh
#
# Exit 0 only when the two files are identical from `name:` down (the headers differ on purpose: one
# says which copy it is).
set -u

here=$(cd "$(dirname "$0")" && pwd)
source=$here/linux-probe.yml
installed=$here/../../../.github/workflows/platform-independence-probe.yml

say() { printf '%s\n' "$*"; }

for f in "$source" "$installed"; do
    [ -f "$f" ] || { say "FAIL  missing: $f"; exit 1; }
done

# Only the YAML body is compared: the comment headers legitimately differ, because each names itself.
a=$(mktemp); b=$(mktemp)
trap 'rm -f "$a" "$b"' EXIT
sed -n '/^name:/,$p' "$source" > "$a"
sed -n '/^name:/,$p' "$installed" > "$b"

if diff -q "$a" "$b" >/dev/null 2>&1; then
    say "PASS  the installed workflow matches the spike's source"
else
    say "FAIL  the two copies differ; the run would report on a version nobody is reading:"
    diff "$a" "$b" | head -20
    say ""
    say "      copy the source over:  cp $source $installed"
    exit 1
fi

say ""
say "RESULT: one workflow, two copies, asserted equal."
