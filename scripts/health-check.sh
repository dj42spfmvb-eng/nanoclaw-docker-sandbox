#!/usr/bin/env bash
# NanoClaw Health Monitor — lightweight, deterministic health checks
# Usage: ./scripts/health-check.sh [--quiet] [--alert]
#   --quiet  Only output if issues found (for cron)
#   --alert  Enable IPC/notification alerting on critical issues
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="$PROJECT_DIR/store/messages.db"
LOG_PATH="$PROJECT_DIR/logs/nanoclaw.log"
IPC_DIR="$PROJECT_DIR/data/ipc"
ALERT_STATE="$PROJECT_DIR/data/health-check-last-alert"

# Thresholds
STALE_WARN_SEC=900      # 15 min
STALE_CRIT_SEC=1800     # 30 min
CONTAINER_WARN_SEC=1800 # 30 min
CONTAINER_CRIT_SEC=2700 # 45 min
MAX_CONTAINERS=5
IPC_WARN=5
IPC_CRIT=10
ERROR_WARN=1
ERROR_CRIT=5
ALERT_COOLDOWN_SEC=900  # 15 min between alerts
DAYTIME_START=8
DAYTIME_END=23

# Parse flags
QUIET=false
ALERT=false
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=true ;;
    --alert) ALERT=true ;;
  esac
done

NOW=$(date +%s)
NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HOUR=$(date +%-H)
IS_DAYTIME=false
if [ "$HOUR" -ge "$DAYTIME_START" ] && [ "$HOUR" -lt "$DAYTIME_END" ]; then
  IS_DAYTIME=true
fi

# JSON-safe string escaping
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g' | tr '\n' ' '
}

# ── Check 1: Process Alive ──────────────────────────────────────────────────

check_process() {
  local status="ok" pid="" detail=""
  if launchctl list com.nanoclaw &>/dev/null; then
    # Extract PID, strip trailing semicolons and whitespace
    pid=$(launchctl list com.nanoclaw 2>/dev/null | grep '"PID"' | awk '{print $NF}' | tr -d ';' || true)
    if [ -z "$pid" ] || [ "$pid" = "-" ]; then
      pid=$(launchctl list 2>/dev/null | grep com.nanoclaw | awk '{print $1}' | tr -d ';' || true)
    fi
    if [ -n "$pid" ] && [ "$pid" != "-" ] && kill -0 "$pid" 2>/dev/null; then
      detail="Running (PID $pid)"
    else
      status="critical"; detail="Registered with launchd but PID not running"
    fi
  else
    status="critical"; detail="Not registered with launchd"
  fi
  printf '{"status":"%s","pid":"%s","detail":"%s"}' "$status" "$pid" "$(json_escape "$detail")"
}

# ── Check 2: WhatsApp Connected ─────────────────────────────────────────────

check_whatsapp() {
  local status="ok" detail=""
  if [ ! -f "$LOG_PATH" ]; then
    printf '{"status":"unknown","detail":"Log file not found"}'
    return
  fi

  # Strip ANSI codes and find last connection event
  local cleaned
  cleaned=$(tail -500 "$LOG_PATH" | sed $'s/\x1b\[[0-9;]*m//g')
  local last_connected last_closed
  last_connected=$(echo "$cleaned" | grep -n "Connected to WhatsApp" | tail -1 | cut -d: -f1 || true)
  last_closed=$(echo "$cleaned" | grep -n "Connection closed" | tail -1 | cut -d: -f1 || true)

  last_connected=${last_connected:-0}
  last_closed=${last_closed:-0}

  if [ "$last_connected" -gt "$last_closed" ]; then
    detail="Connected (last event: Connected to WhatsApp)"
  elif [ "$last_closed" -gt 0 ]; then
    local has_reconnect
    has_reconnect=$(echo "$cleaned" | tail -n +"$last_closed" | grep -c "Reconnecting\.\.\." || true)
    if [ "$has_reconnect" -gt 0 ]; then
      status="warning"; detail="Connection closed, reconnecting in progress"
    else
      status="critical"; detail="Connection closed, no reconnect detected"
    fi
  else
    status="unknown"; detail="No connection events found in recent logs"
  fi
  printf '{"status":"%s","detail":"%s"}' "$status" "$(json_escape "$detail")"
}

# ── Check 3: Message Staleness ───────────────────────────────────────────────

check_messages() {
  local status="ok" age_sec=0 last_received="" last_processed="" detail=""
  if [ ! -f "$DB_PATH" ]; then
    printf '{"status":"unknown","detail":"Database not found"}'
    return
  fi

  last_received=$(sqlite3 "$DB_PATH" "SELECT MAX(timestamp) FROM messages;" 2>/dev/null || true)
  last_processed=$(sqlite3 "$DB_PATH" "SELECT value FROM router_state WHERE key = 'last_timestamp';" 2>/dev/null || true)

  if [ -z "$last_received" ]; then
    printf '{"status":"unknown","detail":"No messages in database"}'
    return
  fi

  # Parse timestamp — handle both epoch ms and ISO format
  local recv_epoch=0
  if echo "$last_received" | grep -qE '^[0-9]+$'; then
    recv_epoch=$((last_received / 1000))
  else
    # ISO format (UTC) — parse with TZ=UTC to avoid local time confusion
    local ts_clean
    ts_clean=$(echo "$last_received" | sed 's/\.[0-9]*Z$//' | sed 's/T/ /')
    recv_epoch=$(TZ=UTC date -j -f "%Y-%m-%d %H:%M:%S" "$ts_clean" +%s 2>/dev/null || echo 0)
  fi

  if [ "$recv_epoch" -gt 0 ]; then
    age_sec=$((NOW - recv_epoch))
    # Guard against negative (clock skew)
    if [ "$age_sec" -lt 0 ]; then age_sec=0; fi
  fi

  local age_min=$((age_sec / 60))
  local stale_warn_min=$((STALE_WARN_SEC / 60))
  local stale_crit_min=$((STALE_CRIT_SEC / 60))

  if [ "$IS_DAYTIME" = "false" ]; then
    detail="Nighttime — staleness check relaxed (last: ${age_min}m ago)"
  elif [ "$age_sec" -ge "$STALE_CRIT_SEC" ]; then
    status="critical"; detail="No messages for ${age_min}m (>${stale_crit_min}m)"
  elif [ "$age_sec" -ge "$STALE_WARN_SEC" ]; then
    status="warning"; detail="No messages for ${age_min}m (>${stale_warn_min}m)"
  else
    detail="Last message ${age_min}m ago"
  fi
  printf '{"status":"%s","last_received":"%s","last_processed":"%s","age_seconds":%d,"detail":"%s"}' \
    "$status" "$(json_escape "$last_received")" "$(json_escape "${last_processed:-unknown}")" \
    "$age_sec" "$(json_escape "$detail")"
}

# ── Check 4: Container Health ────────────────────────────────────────────────

check_containers() {
  local status="ok" active=0 longest=0 detail=""

  if ! command -v docker &>/dev/null; then
    printf '{"status":"unknown","active":0,"detail":"Docker not found"}'
    return
  fi

  local containers
  containers=$(docker ps --filter "name=nanoclaw-" --format '{{.Names}}\t{{.CreatedAt}}' 2>/dev/null || true)

  if [ -z "$containers" ]; then
    printf '{"status":"ok","active":0,"max":%d,"longest_runtime_min":0,"containers":[],"detail":"No containers running"}' "$MAX_CONTAINERS"
    return
  fi

  local name_list=""
  while IFS=$'\t' read -r name created; do
    active=$((active + 1))
    name_list="${name_list}\"${name}\","

    # Parse created time — format: "2026-03-16 12:52:42 -0700 PDT"
    local created_epoch runtime_sec
    created_epoch=$(date -j -f "%Y-%m-%d %H:%M:%S %z" "$(echo "$created" | awk '{print $1, $2, $3}')" +%s 2>/dev/null || echo "$NOW")
    runtime_sec=$((NOW - created_epoch))

    if [ "$runtime_sec" -gt "$longest" ]; then
      longest=$runtime_sec
    fi

    if [ "$runtime_sec" -ge "$CONTAINER_CRIT_SEC" ]; then
      status="critical"
    elif [ "$runtime_sec" -ge "$CONTAINER_WARN_SEC" ] && [ "$status" != "critical" ]; then
      status="warning"
    fi
  done <<< "$containers"

  name_list="${name_list%,}"

  if [ "$active" -ge "$MAX_CONTAINERS" ] && [ "$status" != "critical" ]; then
    status="warning"
  fi

  local longest_min=$((longest / 60))
  detail="${active} container(s), longest: ${longest_min}m"
  printf '{"status":"%s","active":%d,"max":%d,"longest_runtime_min":%d,"containers":[%s],"detail":"%s"}' \
    "$status" "$active" "$MAX_CONTAINERS" "$longest_min" "$name_list" "$(json_escape "$detail")"
}

# ── Check 5: IPC Backlog ────────────────────────────────────────────────────

check_ipc() {
  local status="ok" pending_msg=0 pending_tasks=0 error_files=0 detail=""

  if [ ! -d "$IPC_DIR" ]; then
    printf '{"status":"ok","pending_messages":0,"pending_tasks":0,"error_files":0,"detail":"IPC directory not found"}'
    return
  fi

  for group_dir in "$IPC_DIR"/*/; do
    [ -d "$group_dir" ] || continue
    if [ -d "${group_dir}messages" ]; then
      local count
      count=$(find "${group_dir}messages" -name "*.json" -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
      pending_msg=$((pending_msg + count))
    fi
    if [ -d "${group_dir}tasks" ]; then
      local count
      count=$(find "${group_dir}tasks" -name "*.json" -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
      pending_tasks=$((pending_tasks + count))
    fi
  done

  if [ -d "$IPC_DIR/errors" ]; then
    error_files=$(find "$IPC_DIR/errors" -name "*.json" -maxdepth 1 -mmin -60 2>/dev/null | wc -l | tr -d ' ')
  fi

  local total=$((pending_msg + pending_tasks))
  if [ "$total" -ge "$IPC_CRIT" ]; then
    status="critical"; detail="Backlog: ${pending_msg} messages, ${pending_tasks} tasks"
  elif [ "$total" -ge "$IPC_WARN" ]; then
    status="warning"; detail="Backlog: ${pending_msg} messages, ${pending_tasks} tasks"
  else
    detail="No backlog"
  fi

  if [ "$error_files" -gt 0 ]; then
    detail="$detail (${error_files} recent errors)"
    if [ "$status" = "ok" ]; then status="warning"; fi
  fi

  printf '{"status":"%s","pending_messages":%d,"pending_tasks":%d,"error_files":%d,"detail":"%s"}' \
    "$status" "$pending_msg" "$pending_tasks" "$error_files" "$(json_escape "$detail")"
}

# ── Check 6: Recent Errors ──────────────────────────────────────────────────

check_errors() {
  local status="ok" count=0 has_fatal=false detail="" types=""

  if [ ! -f "$LOG_PATH" ]; then
    printf '{"status":"unknown","count":0,"detail":"Log file not found"}'
    return
  fi

  local cleaned
  cleaned=$(tail -200 "$LOG_PATH" | sed $'s/\x1b\[[0-9;]*m//g')
  count=$(echo "$cleaned" | grep -c "ERROR\|FATAL" || true)

  if echo "$cleaned" | grep -q "FATAL"; then
    has_fatal=true
  fi

  types=$(echo "$cleaned" | grep "ERROR\|FATAL" | sed 's/.*] //' | sort -u | head -5 | tr '\n' '; ' || true)

  if [ "$has_fatal" = "true" ] || [ "$count" -ge "$ERROR_CRIT" ]; then
    status="critical"; detail="${count} errors in last 200 lines"
  elif [ "$count" -ge "$ERROR_WARN" ]; then
    status="warning"; detail="${count} errors in last 200 lines"
  else
    detail="No recent errors"
  fi

  printf '{"status":"%s","count":%d,"recent_types":"%s","detail":"%s"}' \
    "$status" "$count" "$(json_escape "$types")" "$(json_escape "$detail")"
}

# ── Run All Checks ──────────────────────────────────────────────────────────

PROCESS=$(check_process)
WHATSAPP=$(check_whatsapp)
MESSAGES=$(check_messages)
CONTAINERS=$(check_containers)
IPC=$(check_ipc)
ERRORS=$(check_errors)

# Aggregate worst status from check outputs (not subshell vars)
WORST="ok"
for result in "$PROCESS" "$WHATSAPP" "$CONTAINERS" "$IPC" "$ERRORS"; do
  if echo "$result" | grep -q '"status":"critical"'; then
    WORST="critical"; break
  elif echo "$result" | grep -q '"status":"warning"'; then
    WORST="warning"
  fi
done

REPORT="{\"timestamp\":\"$NOW_ISO\",\"overall\":\"$WORST\",\"checks\":{\"process\":$PROCESS,\"whatsapp\":$WHATSAPP,\"messages\":$MESSAGES,\"containers\":$CONTAINERS,\"ipc\":$IPC,\"errors\":$ERRORS}}"

# ── Output ───────────────────────────────────────────────────────────────────

if [ "$QUIET" = "true" ] && [ "$WORST" = "ok" ]; then
  : # Suppress output when healthy
else
  echo "$REPORT"
fi

# ── Alert on Critical ────────────────────────────────────────────────────────

if [ "$ALERT" = "true" ] && [ "$WORST" = "critical" ]; then

  # Check cooldown
  SEND_ALERT=true
  if [ -f "$ALERT_STATE" ]; then
    last_alert=$(cat "$ALERT_STATE" 2>/dev/null || echo 0)
    if [ $((NOW - last_alert)) -lt "$ALERT_COOLDOWN_SEC" ]; then
      SEND_ALERT=false
    fi
  fi

  if [ "$SEND_ALERT" = "true" ]; then
    # Build human-readable summary from check results
    SUMMARY="[Health Alert] NanoClaw: CRITICAL"
    for check_pair in "process:$PROCESS" "whatsapp:$WHATSAPP" "messages:$MESSAGES" "containers:$CONTAINERS" "ipc:$IPC" "errors:$ERRORS"; do
      check_name="${check_pair%%:*}"
      check_json="${check_pair#*:}"
      local_status=$(echo "$check_json" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
      local_detail=$(echo "$check_json" | grep -o '"detail":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [ "$local_status" = "critical" ] || [ "$local_status" = "warning" ]; then
        SUMMARY="$SUMMARY
- $check_name: $local_detail"
      fi
    done

    # Tier 2: macOS notification (always works, even if NanoClaw is down)
    osascript -e "display notification \"$(echo "$SUMMARY" | head -3 | tr '\n' ' ')\" with title \"NanoClaw Health\" sound name \"Basso\"" 2>/dev/null || true

    # Tier 1: IPC message to main group (only if process is running)
    MAIN_FOLDER=$(sqlite3 "$DB_PATH" "SELECT folder FROM registered_groups WHERE is_main = 1 LIMIT 1;" 2>/dev/null || true)
    MAIN_JID=$(sqlite3 "$DB_PATH" "SELECT jid FROM registered_groups WHERE is_main = 1 LIMIT 1;" 2>/dev/null || true)

    if [ -n "$MAIN_FOLDER" ] && [ -n "$MAIN_JID" ]; then
      IPC_MSG_DIR="$IPC_DIR/$MAIN_FOLDER/messages"
      mkdir -p "$IPC_MSG_DIR"
      ALERT_FILE="$IPC_MSG_DIR/health-alert-$(date +%s).json"
      cat > "$ALERT_FILE" <<ALERTEOF
{"type":"message","chatJid":"$MAIN_JID","text":"$(json_escape "$SUMMARY")"}
ALERTEOF
    fi

    # Record alert time
    echo "$NOW" > "$ALERT_STATE"
  fi
fi

# ── Exit Code ────────────────────────────────────────────────────────────────

case "$WORST" in
  critical) exit 2 ;;
  warning)  exit 1 ;;
  *)        exit 0 ;;
esac
