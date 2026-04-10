#!/usr/bin/env bash
set -u
cd "$(dirname "$0")" || exit 1

WORKDIR="$(pwd)"
PROMPT_FILE="$WORKDIR/PROMPT.md"
QUEUE_FILE="$WORKDIR/QUEUE.md"
LOG_FILE="$WORKDIR/LOG.md"
RAW_LOG_FILE="$WORKDIR/LOG.raw.jsonl"
STOP_FILE="$WORKDIR/STOP"

MAX_ITERATIONS="${MAX_ITERATIONS:-18}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-2}"

touch "$LOG_FILE" "$RAW_LOG_FILE"

# Trap SIGINT for clean Ctrl-C
INTERRUPTED=0
trap 'INTERRUPTED=1; echo "[runner] SIGINT received"' INT

JQ_FILTER='
def truncate(n): if (. | length) > n then .[0:n] + "…" else . end;
def tool_summary:
  .name as $n | .input as $i
  | if $n == "Bash" then ": " + (($i.command // "") | tostring | truncate(200))
    elif $n == "Edit" or $n == "Write" or $n == "Read" then ": " + (($i.file_path // "") | tostring)
    elif $n == "Grep" or $n == "Glob" then ": " + (($i.pattern // "") | tostring)
    else "" end;
if .type == "system" then "[claude] session started"
elif .type == "assistant" then
  (.message.content // [])
  | map(if .type == "text" then ((.text // "") | split("\n") | map("  " + .) | join("\n"))
        elif .type == "tool_use" then "→ " + (.name // "?") + tool_summary
        else empty end)
  | join("\n")
elif .type == "user" then
  (.message.content // [])
  | map(select(.type == "tool_result")
        | if (.is_error // false) then "  ✗ tool error: " + ((.content // "") | tostring | truncate(300))
          else empty end)
  | join("\n")
elif .type == "result" then
  "[claude] " + (.subtype // "ended")
  + (if .total_cost_usd then " — $" + (.total_cost_usd | tostring) else "" end)
else empty end
| select(. != "" and . != null)
'

count_unchecked() { grep -c '^- \[ \]' "$QUEUE_FILE" 2>/dev/null || echo 0; }

iteration=0
while :; do
  if [[ -f "$STOP_FILE" ]]; then echo "[runner] STOP file present, exiting"; break; fi
  if (( INTERRUPTED == 1 )); then break; fi
  if (( iteration >= MAX_ITERATIONS )); then echo "[runner] hit MAX_ITERATIONS=$MAX_ITERATIONS"; break; fi

  unchecked=$(count_unchecked)
  if [[ "$unchecked" -eq 0 ]]; then echo "[runner] queue empty, exiting"; break; fi

  iteration=$((iteration + 1))
  echo ""
  echo "=================================================================="
  echo " Ralph iteration $iteration  |  $(date -Iseconds)  |  $unchecked unchecked"
  echo "=================================================================="

  budget_args=()
  if [[ "$MAX_BUDGET_USD" != "0" ]]; then
    budget_args=(--max-budget-usd "$MAX_BUDGET_USD")
  fi

  cat "$PROMPT_FILE" \
    | claude -p \
        --dangerously-skip-permissions \
        --output-format stream-json \
        --verbose \
        "${budget_args[@]}" \
        2>&1 \
    | tee -a "$RAW_LOG_FILE" \
    | jq -rR --unbuffered 'fromjson? | '"$JQ_FILTER"' // empty' 2>/dev/null \
    | tee -a "$LOG_FILE"

  rc="${PIPESTATUS[1]}"
  if (( rc != 0 )); then sleep 5; fi
done

echo ""
echo "[runner] done. Unchecked remaining: $(count_unchecked)"
