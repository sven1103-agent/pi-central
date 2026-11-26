#!/bin/sh
# Does Strands Box's policy language express Pi Central's deny set?
#
# Three checks, and the second is what makes the first mean anything: a policy that loads proves
# nothing unless a policy that SHOULD fail also fails. Same shape as
# packages/orchestrator/test/fragment.test.ts ("a deliberately broken fragment DOES report a syntax
# error (the check has teeth)").
#
# Needs `box` on PATH (https://strandsagents.com/docs/user-guide/box/install/) and `HOME` writable,
# because Box keeps its profile storage under `$HOME/.strands/box`. It validates a policy and never
# starts a workload, so it is safe to run anywhere Box itself runs.
#
#   sh check-translation.sh
#
# Exit 0 only when all checks pass. A missing `box` is a failure, not a skip: three of these checks
# look for a REFUSAL, and "command not found" is a refusal too. Without this guard a machine with no
# Box on PATH would report 2 of 3 checks as passing for the wrong reason.
set -u

here=$(cd "$(dirname "$0")" && pwd)
fail=0

say() { printf '%s\n' "$*"; }
check() { # check <label> <exit-code>
    if [ "$2" -eq 0 ]; then say "PASS  $1"; else say "FAIL  $1"; fail=1; fi
}

if ! command -v box >/dev/null 2>&1; then
    say "FAIL  box is not on PATH, so nothing here can be checked"
    say "      install it: https://strandsagents.com/docs/user-guide/box/install/"
    exit 1
fi
say "box: $(box --version 2>&1)"

say ""
say "== 1. the translated deny set loads, and its rules are in the run's policy =="
full=$(cd "$here" && box profile show .box/profile.toml --full 2>&1)
status=$?
check "box profile show accepted the profile (exit 0)" "$status"

printf '%s' "$full" | grep -q 'no_user_ssh'
check "the ~/.ssh directory deny is in the composed policy" "$?"

printf '%s' "$full" | grep -q 'no_host_gitconfig'
check "the host gitconfig deny is in the composed policy" "$?"

printf '%s' "$full" | grep -q 'filesystem_deny_read_0'
check "the [filesystem] deny generated the rules that hold for every process" "$?"

say ""
say "== 2. an unrecognised action is REFUSED (the check has teeth) =="
work=$(mktemp -d "${TMPDIR:-/tmp}/pc-translation.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
cp -R "$here/.box" "$work/.box"
cat >> "$work/.box/pc-denies.dw" <<'DW'

@id("no_such_action")
forbid (principal, action == Box::Action::"fs:teleport", resource)
when { context.input.path == "~/.ssh" };
DW
out=$(cd "$work" && box profile show .box/profile.toml 2>&1)
status=$?
[ "$status" -ne 0 ]
check "a policy naming fs:teleport is refused (non-zero exit)" "$?"
printf '%s' "$out" | grep -q 'unrecognized action'
check "and the refusal is a policy error naming the unrecognised action" "$?"

say ""
say "== 3. a socket-shaped condition is refused, so the ssh-agent deny has no counterpart =="
cp "$here/.box/pc-denies.dw" "$work/.box/pc-denies.dw"
cat >> "$work/.box/pc-denies.dw" <<'DW'

@id("unix_socket_deny")
forbid (principal, action == Box::Action::"net:connect", resource)
when { context.input.socket_path like "~/.ssh/agent" };
DW
out=$(cd "$work" && box profile show .box/profile.toml 2>&1)
status=$?
[ "$status" -ne 0 ]
check "net:connect has no socket field, so that rule refuses to load" "$?"
# Box wraps this message across lines, so the two halves are matched separately rather than with one
# pattern: a single regex over wrapped text would pass or fail on the terminal width it happened to use.
printf '%s' "$out" | grep -q 'socket_path'
check "and the refusal names the attribute that does not exist" "$?"
printf '%s' "$out" | grep -q 'did you mean .host.'
check "and it names the fields net:connect does have" "$?"

say ""
if [ "$fail" -eq 0 ]; then say "RESULT: all checks passed"; else say "RESULT: FAILED"; fi
exit "$fail"
