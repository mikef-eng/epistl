#!/usr/bin/env bash
# Self-contained tests for require-coverage.sh (no bats).
# Stub gh on PATH; pipe fixture JSON; assert exit codes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$ROOT/require-coverage.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

chmod +x "$SCRIPT"

STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN" "$TMP/cwd"

# --- stub gh ---
# Controlled by GH_STUB_MODE env:
#   none     — exit 1 (no PR)
#   err      — exit 1 with network-ish error
#   bodyfile — print JSON from $GH_STUB_BODY_FILE
cat >"$STUB_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${GH_STUB_MODE:-none}" in
  none)
    echo "no pull requests found for branch" >&2
    exit 1
    ;;
  err)
    echo "HTTP 401: Bad credentials" >&2
    exit 1
    ;;
  bodyfile)
    body="$(cat "$GH_STUB_BODY_FILE")"
    # Escape for JSON string
    python3 -c "import json,sys; print(json.dumps({'number': 42, 'body': sys.stdin.read()}))" <<<"$body"
    exit 0
    ;;
  *)
    echo "unknown GH_STUB_MODE=$GH_STUB_MODE" >&2
    exit 99
    ;;
esac
EOF
chmod +x "$STUB_BIN/gh"
export PATH="$STUB_BIN:$PATH"

pass=0
fail=0

run_case() {
  local name="$1" expect="$2" mode="$3" agent="$4" stop="$5" body_file="${6:-}"
  local input exit_code=0 stop_py
  if [ "$stop" = "true" ]; then stop_py=True; else stop_py=False; fi
  input="$(python3 -c "
import json
print(json.dumps({
  'cwd': '$TMP/cwd',
  'agent_type': '$agent',
  'stop_hook_active': $stop_py,
  'agent_transcript_path': '/tmp/x'
}))
")"
  export GH_STUB_MODE="$mode"
  if [ -n "$body_file" ]; then
    export GH_STUB_BODY_FILE="$body_file"
  else
    unset GH_STUB_BODY_FILE || true
  fi
  set +e
  printf '%s' "$input" | "$SCRIPT" >/dev/null 2>"$TMP/stderr"
  exit_code=$?
  set -e
  if [ "$exit_code" -eq "$expect" ]; then
    echo "PASS: $name (exit $exit_code)"
    pass=$((pass + 1))
  else
    echo "FAIL: $name (expected $expect, got $exit_code)" >&2
    echo "--- stderr ---" >&2
    cat "$TMP/stderr" >&2 || true
    fail=$((fail + 1))
  fi
}

GOOD_BODY="$TMP/good.md"
cat >"$GOOD_BODY" <<'EOF'
## Summary
x

## Lane
api

## Coverage

| Acceptance criterion | Test |
| --- | --- |
| does the thing | `foo.rs::test_thing` |

## Testing recommendation
Logic-affecting
EOF

EMPTY_TABLE="$TMP/empty.md"
cat >"$EMPTY_TABLE" <<'EOF'
## Lane
api

## Coverage

| Acceptance criterion | Test |
| --- | --- |

## Testing recommendation
Logic-affecting
EOF

NO_COVERAGE="$TMP/nocov.md"
cat >"$NO_COVERAGE" <<'EOF'
## Lane
api

## Testing recommendation
Logic-affecting
EOF

# 1) no PR → exit 0
run_case "no PR" 0 none api-dev false

# 2) PR with full table → exit 0
run_case "PR with table" 0 bodyfile api-dev false "$GOOD_BODY"

# 3) PR without Coverage → exit 2
run_case "PR without table" 2 bodyfile api-dev false "$NO_COVERAGE"

# 4) PR with heading but empty table → exit 2
run_case "empty Coverage table" 2 bodyfile api-dev false "$EMPTY_TABLE"

# 5) stop_hook_active=true → exit 0
run_case "stop_hook_active" 0 bodyfile api-dev true "$NO_COVERAGE"

# 6) non-lane agent type → exit 0
run_case "non-lane agent" 0 bodyfile merge-gate false "$NO_COVERAGE"

# bonus: gh auth error → fail open (0)
run_case "gh error fail-open" 0 err api-dev false

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
