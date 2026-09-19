#!/usr/bin/env bash
# SubagentStop hook: require ## Coverage (+ Lane / Testing recommendation)
# on api-dev / mobile-dev / native-dev PRs before the lane is allowed to stop.
# Exit 0 = allow stop; exit 2 = block stop (stderr fed back to the agent).
set -euo pipefail

INPUT="$(cat)"

json_field() {
  local key="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$INPUT" | jq -r --arg k "$key" 'if .[$k] == null then empty else .[$k] end'
  else
    printf '%s' "$INPUT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
v = d.get('$key')
if v is None or v is False and '$key' != 'stop_hook_active':
    # keep false for stop_hook_active; empty for missing
    pass
print('' if v is None else ('true' if v is True else ('false' if v is False else v)))
"
  fi
}

# stop_hook_active may be boolean true — normalize via python for reliability
STOP_ACTIVE="$(printf '%s' "$INPUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
v=d.get('stop_hook_active')
print('true' if v is True or v == 'true' else 'false')
")"
AGENT_TYPE="$(printf '%s' "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('agent_type') or '')")"
CWD="$(printf '%s' "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cwd') or '')")"

if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

# Defensive filter when agent_type is present (settings matcher is primary).
if [ -n "$AGENT_TYPE" ]; then
  case "$AGENT_TYPE" in
    api-dev|mobile-dev|native-dev) ;;
    *) exit 0 ;;
  esac
fi

if [ -z "$CWD" ] || [ ! -d "$CWD" ]; then
  echo "require-coverage: missing or invalid cwd; failing open" >&2
  exit 0
fi

cd "$CWD"

if ! command -v gh >/dev/null 2>&1; then
  echo "require-coverage: gh not on PATH; failing open" >&2
  exit 0
fi

ERR_FILE="$(mktemp)"
trap 'rm -f "$ERR_FILE"' EXIT

if ! PR_JSON="$(gh pr view --json body,number 2>"$ERR_FILE")"; then
  if grep -qiE 'no pull requests|Could not find a pull request|not found' "$ERR_FILE"; then
    exit 0
  fi
  echo "require-coverage: gh error; failing open" >&2
  cat "$ERR_FILE" >&2 || true
  exit 0
fi

BODY="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("body") or "")')"
NUM="$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys; n=json.load(sys.stdin).get("number"); print(n if n is not None else "")')"

has_heading() {
  printf '%s\n' "$BODY" | grep -qE "^##[[:space:]]+$1([[:space:]]|$)"
}

coverage_has_data_row() {
  printf '%s\n' "$BODY" | awk '
    BEGIN { in_cov=0; seen_header=0; found=0 }
    /^##[[:space:]]+Coverage([[:space:]]|$)/ { in_cov=1; next }
    /^##[[:space:]]/ { if (in_cov) { in_cov=0 } }
    in_cov && /^\|/ {
      if ($0 ~ /^\|[[:space:]:|-]+$/) next
      if (!seen_header) { seen_header=1; next }
      found=1
      exit
    }
    END { exit(found ? 0 : 1) }
  '
}

fail=0
cov_msg=""
extra=""

if ! has_heading "Coverage"; then
  fail=1
  cov_msg="PR #${NUM:-?} body is missing a ## Coverage table with at least one row. Add it per the pr-coverage-table skill (gh pr edit --body), then finish."
elif ! coverage_has_data_row; then
  fail=1
  cov_msg="PR #${NUM:-?} body is missing a ## Coverage table with at least one row. Add it per the pr-coverage-table skill (gh pr edit --body), then finish."
fi

if ! has_heading "Lane"; then
  fail=1
  extra="${extra}## Lane "
fi
if ! has_heading "Testing recommendation"; then
  fail=1
  extra="${extra}## Testing recommendation "
fi

if [ "$fail" -eq 1 ]; then
  if [ -n "$cov_msg" ]; then
    echo "$cov_msg" >&2
  fi
  if [ -n "$extra" ]; then
    echo "PR #${NUM:-?} body is also missing: ${extra}" >&2
  fi
  exit 2
fi

exit 0
