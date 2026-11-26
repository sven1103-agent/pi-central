#!/bin/sh
# Which key reaches the wire: auth.json's !command, or the provider's env var?
#
# This decides whether a Box route can replace the keychain at all, and the first answer in
# KEYCHAIN.md was WRONG because it was inferred from a 401 rather than from the header. Both a
# keychain value and an environment value were rejected by the real API, so "it made a call" said
# nothing about which one it made the call with.
#
# The fix is to read the value that actually leaves the process: a local proxy, named by a
# models.json baseUrl, prints the x-api-key header. Three arms, so the answer cannot be an artefact of
# one configuration:
#
#   A  auth.json !command AND an env var   -> which one is printed?
#   B  no auth.json, env var only          -> the env var works on its own (control)
#   C  auth.json !command only, no env var -> the command works on its own (control)
#
# Measured on the run that wrote this: A prints the COMMAND's value. So pi prefers a configured
# key over the environment, and a Box route cannot replace a keychain key while auth.json still
# carries a !security command. That inverted the conclusion this file was written to support.
#
# Needs `pi` and `node` on PATH. Makes no outbound request: the proxy is local and the port is
# allocated by asking the OS, so the check cannot collide with a running service.
#
#   sh check-precedence.sh
#
# Exit 0 only when all three arms agree with the measured answer.
set -u

command -v pi >/dev/null 2>&1 || { echo "FAIL  pi is not on PATH"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FAIL  node is not on PATH"; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/pc-precedence.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
fail=0
say() { printf '%s\n' "$*"; }
check() { if [ "$2" -eq 0 ]; then say "PASS  $1"; else say "FAIL  $1"; fail=1; fi; }

# A proxy that prints the key header, then refuses. The port is chosen by the OS and written to a file,
# so two runs cannot fight over it and nothing is hardcoded.
cat > "$work/proxy.mjs" <<'MJS'
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const out = process.argv[2];
const s = createServer((req, res) => {
    writeFileSync(out, JSON.stringify({ key: req.headers["x-api-key"] ?? null }));
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "captured" } }));
});
s.listen(0, "127.0.0.1", () => process.stdout.write(String(s.address().port)));
setTimeout(() => process.exit(0), 30000);
MJS

# arm <label> <port-file> <seen-file> <extra-env...>
arm() {
    label=$1; portfile=$2; seen=$3; shift 3
    dir="$work/$label"
    mkdir -p "$dir/agent" "$dir/bin"
    node "$work/proxy.mjs" "$seen" > "$portfile" &
    proxy_pid=$!
    # Wait for the port, rather than sleeping a guessed interval.
    i=0
    while [ ! -s "$portfile" ] && [ "$i" -lt 100 ]; do i=$((i + 1)); sleep 0.1; done
    port=$(cat "$portfile")
    printf '%s\n' "{\"providers\":{\"anthropic\":{\"baseUrl\":\"http://127.0.0.1:$port\"}}}" > "$dir/agent/models.json"
    # The label decides whether a configured key exists. Matched as an explicit list rather than by
    # testing whether the label contains "auth": the first version of this file did that, so arm "both"
    # wrote no auth.json and silently became a second copy of arm B - a control that reported a correct
    # answer for the wrong reason, which is the failure mode this whole harness exists to avoid.
    case "$label" in
        both|configured) printf '%s\n' '{ "anthropic": { "type": "api_key", "key": "!security-key" } }' > "$dir/agent/auth.json" ;;
    esac
    printf '%s\n' '#!/bin/sh' 'echo command-value' > "$dir/bin/security-key"
    chmod +x "$dir/bin/security-key"
    # shellcheck disable=SC2086
    ( cd "$dir" && env PATH="$dir/bin:$PATH" PI_CODING_AGENT_DIR="$dir/agent" "$@" \
        pi -p "say OK" > "$dir/out.txt" 2>&1 )
    kill "$proxy_pid" 2>/dev/null
    if [ -s "$seen" ]; then node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).key))' "$seen"; fi
}

say "== A: auth.json command AND an environment variable =="
a=$(arm both "$work/pa" "$work/sa" ANTHROPIC_API_KEY=environment-value)
say "      x-api-key sent: $a"
[ "$a" = "command-value" ]
check "the auth.json command wins over the environment variable" "$?"

say ""
say "== B: no auth.json, environment variable only (control) =="
b=$(arm env "$work/pb" "$work/sb" ANTHROPIC_API_KEY=environment-value)
say "      x-api-key sent: $b"
[ "$b" = "environment-value" ]
check "with no configured key, the environment variable is used" "$?"

say ""
say "== C: auth.json command only, no environment variable (control) =="
c=$(arm configured "$work/pc" "$work/sc")
say "      x-api-key sent: $c"
[ "$c" = "command-value" ]
check "the command works on its own, so arm A is not an artefact" "$?"

say ""
if [ "$fail" -eq 0 ]; then
    say "RESULT: pi PREFERS the configured key. A route cannot replace a keychain key while"
    say "        auth.json still carries a !security command - the command must be removed first."
else
    say "RESULT: FAILED - re-measure before relying on the precedence claim"
fi
exit "$fail"
