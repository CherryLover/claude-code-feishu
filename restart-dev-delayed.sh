#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[$(date '+%F %T')] stopping existing dev service..."

stopped=0
for pattern in "tsx src/index.ts" "node dist/index.js"; do
  if pkill -f "$pattern" >/dev/null 2>&1; then
    stopped=1
    echo "[$(date '+%F %T')] stopped: $pattern"
  fi
done

if [[ "$stopped" -eq 0 ]]; then
  pids_raw="$( (lsof +D "$SCRIPT_DIR" 2>/dev/null || true) | awk '$1 == "node" {print $2}' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//' )"
  if [[ -n "$pids_raw" ]]; then
    pids=($pids_raw)
    if kill "${pids[@]}" >/dev/null 2>&1; then
      echo "[$(date '+%F %T')] stopped node pids: ${pids[*]}"
      stopped=1
    else
      echo "[$(date '+%F %T')] warn: cannot stop node pids in current context: ${pids[*]}"
    fi
  fi
fi

if [[ "$stopped" -eq 0 ]]; then
  echo "[$(date '+%F %T')] no existing dev process stopped"
fi

echo "[$(date '+%F %T')] starting npm run dev..."
exec npm run dev
