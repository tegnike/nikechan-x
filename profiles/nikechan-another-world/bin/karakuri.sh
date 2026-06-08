#!/usr/bin/env bash
set -euo pipefail
shopt -s inherit_errexit

# karakuri.sh — karakuri-world API wrapper
#
# Required environment variables:
#   KARAKURI_API_BASE_URL  REST API base URL (e.g. https://karakuri.example.com/api)
#   KARAKURI_API_KEY       API key issued at agent registration
#
# Requires: curl, jq

usage() {
  cat <<'EOF'
Usage: karakuri.sh <command> [arguments]

Commands:
  login                                           Log in the agent directly
  logout                                          Log out the agent directly
  get_notification <notification_id>             Open saved notification detail once; starts response timeout without Discord follow-up
  command <notification_id> <command> <params-json>
                                                Execute one notification.choices command via generic endpoint
  Strict mode is enabled by default. Use get_notification, then execute only
  a command present in notification.choices[] via the generic command endpoint.
  Older direct helpers such as move/wait/get_status are disabled unless
  KARAKURI_STRICT_GENERIC_COMMANDS=0.

get_notification opens the saved notification JSON for a Discord notification_id and does not create an immediate Discord follow-up. It is safe to retry; response timeout starts only on the first fetch.

Every command except get_notification requires the same notification_id that was
already fetched with get_notification. Merge choices[].params with your filled
required_params into params-json, then execute at most one generic command for
the notification.
EOF
}

if [ $# -lt 1 ]; then
  usage
  exit 1
fi

if [ "$1" = "--help" ] || [ "$1" = "-h" ] || [ "$1" = "help" ]; then
  usage
  exit 0
fi

if [ -z "${KARAKURI_API_BASE_URL:-}" ]; then
  echo "Error: KARAKURI_API_BASE_URL is not set" >&2
  exit 1
fi

BASE_URL="${KARAKURI_API_BASE_URL%/}"
AUTH_HEADER="Authorization: Bearer ${KARAKURI_API_KEY:-}"

require_agent_api_key() {
  if [ -z "${KARAKURI_API_KEY:-}" ]; then
    echo "Error: KARAKURI_API_KEY is not set" >&2
    exit 1
  fi
}

require_positive_int() {
  # Args: <flag_label> <value>
  if ! [[ "$2" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: $1 must be a positive integer (got: $2)." >&2
    exit 1
  fi
}


require_notification_id() {
  if [ $# -lt 1 ] || [ -z "$1" ]; then
    echo "Error: notification_id is required." >&2
    exit 1
  fi
}

karakuri_state_dir() {
  printf '%s\n' "${KARAKURI_STATE_DIR:-/profile/profiles/nikechan-another-world/state/karakuri-notifications}"
}

karakuri_lock_key() {
  printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/_/g'
}

# Only duplicate executions of the same notification_id are blocked.
claim_notification_command() {
  local notification_id="$1"
  local command_name="$2"
  local params_json="$3"
  local state_dir claim_path claimed_at claim
  state_dir="$(karakuri_state_dir)"
  mkdir -p "$state_dir"
  claim_path="${state_dir}/$(karakuri_lock_key "$notification_id").json"
  claimed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  claim="$(jq -nc \
    --arg notification_id "$notification_id" \
    --arg command "$command_name" \
    --argjson params "$params_json" \
    --arg claimed_at "$claimed_at" \
    '{notification_id: $notification_id, command: $command, params: $params, claimed_at: $claimed_at, status: "claimed"}')"
  if ( set -o noclobber; printf '%s\n' "$claim" > "$claim_path" ) 2>/dev/null; then
    printf '%s\n' "$claim_path"
    return 0
  fi
  printf '%s\n' "$claim_path"
  return 1
}

already_claimed_response() {
  local claim_path="$1"
  if [ -f "$claim_path" ]; then
    jq -c \
      '{error: "notification_already_attempted", message: "This notification already has a command attempt recorded locally.", previous: .}' \
      "$claim_path" 2>/dev/null && return 0
  fi
  jq -nc '{error: "notification_already_attempted", message: "This notification already has a command attempt recorded locally."}'
}

mark_claim_result() {
  local claim_path="$1"
  local api_success="$2"
  local body="$3"
  local completed_at result_json status tmp
  completed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if [ "$api_success" = "true" ]; then
    status="success"
  else
    status="failed"
  fi
  result_json="$(jq -Rn --arg body "$body" '$body | (try fromjson catch .)')"
  tmp="${claim_path}.tmp.$$"
  jq -c \
    --arg status "$status" \
    --arg completed_at "$completed_at" \
    --argjson result "$result_json" \
    '. + {status: $status, completed_at: $completed_at, result: $result}' \
    "$claim_path" > "$tmp" && mv "$tmp" "$claim_path"
}

karakuri_hook_script() {
  printf '%s\n' "${KARAKURI_HOOK_SCRIPT:-/profile/scripts/karakuri-hooks.mjs}"
}

run_preprocess_hook() {
  local notification_id="$1"
  local body="$2"
  local hook
  hook="$(karakuri_hook_script)"
  if [ -f "$hook" ] && command -v node >/dev/null 2>&1; then
    if printf '%s\n' "$body" | node "$hook" pre "$notification_id"; then
      return 0
    fi
    echo "[karakuri.sh] preprocess hook failed; returning raw notification" >&2
  fi
  printf '%s\n' "$body"
}

run_postprocess_hook() {
  local notification_id="$1"
  local command_name="$2"
  local params_json="$3"
  local api_success="$4"
  local body="$5"
  local hook
  hook="$(karakuri_hook_script)"
  if [ -f "$hook" ] && command -v node >/dev/null 2>&1; then
    printf '%s\n' "$body" | node "$hook" post "$notification_id" "$command_name" "$params_json" "$api_success" >&2 || \
      echo "[karakuri.sh] postprocess hook failed" >&2
  fi
}

add_notification_id() {
  jq -c --arg notification_id "$1" '. + {notification_id: $notification_id}'
}

json_obj() {
  local args=()
  while [ $# -ge 2 ]; do
    args+=(--arg "$1" "$2")
    shift 2
  done
  jq -nc "${args[@]}" '$ARGS.named'
}

do_request() {
  if [ "${KARAKURI_DRY_RUN:-0}" = "1" ]; then
    # ドライランモード: curl を呼ばず、リクエスト構造を JSON で stdout に出力する。
    # テスト (apps/server/test/unit/skills/karakuri-script.test.ts) で payload 正当性を検証するための仕組み
    local method="GET" url="" body=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -X) method="$2"; shift 2 ;;
        -H) shift 2 ;;
        -d) body="$2"; shift 2 ;;
        -s|-w) shift ;;
        *) url="$1"; shift ;;
      esac
    done
    jq -nc \
      --arg method "$method" \
      --arg url "$url" \
      --arg body "$body" \
      '{method: $method, url: $url, body: ($body | (try fromjson catch null))}'
    return 0
  fi

  local response code body
  response=$(curl -s -w '\n%{http_code}' "$@")
  code="${response##*$'\n'}"
  body="${response%$'\n'"${code}"}"
  printf '%s\n' "${body}"
  [ "${code}" -ge 200 ] && [ "${code}" -lt 300 ]
}

do_get() {
  require_agent_api_key
  do_request -H "${AUTH_HEADER}" "${BASE_URL}$1"
}

urlencode() {
  jq -nr --arg value "$1" '$value | @uri'
}

do_info_get() {
  do_get "$1?notification_id=$(urlencode "$2")"
}

do_post() {
  require_agent_api_key
  do_request -X POST -H "${AUTH_HEADER}" -H "Content-Type: application/json" -d "$2" "${BASE_URL}$1"
}

validate_notification_choice_command() {
  local notification_id="$1"
  local command_name="$2"
  local notification_body suggestions
  if ! notification_body="$(do_get "/agents/notifications/$notification_id")"; then
    printf '%s\n' "$notification_body"
    return 1
  fi
  if printf '%s\n' "$notification_body" | jq -e --arg command "$command_name" '
      ((.notification.choices // .choices // []) | map(.command) | index($command)) != null
    ' >/dev/null; then
    return 0
  fi
  suggestions="$(printf '%s\n' "$notification_body" | jq -c '[.notification.choices[]?.command] // []' 2>/dev/null || printf '[]')"
  jq -nc \
    --arg notification_id "$notification_id" \
    --arg command "$command_name" \
    --argjson suggestions "$suggestions" \
    '{error: "notification_command_not_in_choices", message: "Command is not present in notification.choices; no API command was sent.", details: {notification_id: $notification_id, command: $command, allowed_commands: $suggestions}}'
  return 1
}

do_agent_command() {
  require_notification_id "$1"
  local notification_id="$1"
  local command_name="$2"
  local params_json="$3"
  local request_body response claim_path
  if ! validate_notification_choice_command "$notification_id" "$command_name"; then
    return 1
  fi
  if ! claim_path="$(claim_notification_command "$notification_id" "$command_name" "$params_json")"; then
    already_claimed_response "$claim_path"
    return 1
  fi
  request_body="$(jq -nc --arg notification_id "$notification_id" --arg command "$command_name" --argjson params "$params_json" '{notification_id: $notification_id, command: $command, params: $params}')"
  if response="$(do_post "/agents/command" "$request_body")"; then
    mark_claim_result "$claim_path" "true" "$response"
    run_postprocess_hook "$notification_id" "$command_name" "$params_json" "true" "$response"
    printf '%s\n' "$response"
  else
    mark_claim_result "$claim_path" "false" "$response"
    run_postprocess_hook "$notification_id" "$command_name" "$params_json" "false" "$response"
    printf '%s\n' "$response"
    return 1
  fi
}

do_info_command() {
  do_agent_command "$1" "$2" '{}'
}

build_conversation_payload() {
  # Args: <context: speak|end> <next_speaker_agent_id> <message_word> [more_message_words...] [trailing_flags...]
  #
  # Trailing flags (popped from the end of the argument list):
  #   --item <item_id>          → transfer: { item: { item_id, quantity } }
  #   --quantity <n>            → 上書き対象 quantity（--item と併用、省略時 1）
  #   --money <amount>          → transfer: { money }
  #   --accept | --reject       → transfer_response
  # 排他: --item と --money / --accept|reject と --item|money は併用不可。
  # context が "end" のときは --item / --money を拒否（end は新規譲渡を開始できない）。
  local context="$1"
  local next_speaker="$2"
  shift 2

  local item_id=""
  local quantity="1"
  local quantity_set=0
  local money=""
  local response=""

  while [ $# -gt 0 ]; do
    local last="${!#}"
    case "$last" in
      --accept|--reject)
        if [ -n "$response" ]; then
          echo "Error: --accept and --reject are mutually exclusive." >&2
          exit 1
        fi
        response="${last#--}"
        set -- "${@:1:$#-1}"
        ;;
      *)
        if [ $# -ge 2 ]; then
          local prev_idx=$(($# - 1))
          local prev="${!prev_idx}"
          case "$prev" in
            --item)
              item_id="$last"
              set -- "${@:1:$#-2}"
              continue
              ;;
            --quantity)
              quantity="$last"
              quantity_set=1
              set -- "${@:1:$#-2}"
              continue
              ;;
            --money)
              money="$last"
              set -- "${@:1:$#-2}"
              continue
              ;;
          esac
        fi
        break
        ;;
    esac
  done

  if [ -n "$item_id" ] && [ -n "$money" ]; then
    echo "Error: --item and --money are mutually exclusive." >&2
    exit 1
  fi
  if [ -n "$response" ] && { [ -n "$item_id" ] || [ -n "$money" ]; }; then
    echo "Error: --accept/--reject cannot be combined with --item/--money." >&2
    exit 1
  fi
  if [ "$quantity_set" = "1" ] && [ -z "$item_id" ]; then
    echo "Error: --quantity requires --item." >&2
    exit 1
  fi
  if [ "$context" = "end" ] && { [ -n "$item_id" ] || [ -n "$money" ]; }; then
    echo "Error: conversation_end does not accept --item or --money (use --accept or --reject only)." >&2
    exit 1
  fi
  if [ $# -lt 1 ]; then
    echo "Error: message is required." >&2
    exit 1
  fi

  local message="${*}"

  if [ -n "$item_id" ]; then
    require_positive_int "--quantity" "$quantity"
    jq -nc \
      --arg message "$message" \
      --arg next_speaker "$next_speaker" \
      --arg item_id "$item_id" \
      --argjson quantity "$quantity" \
      '{message: $message, next_speaker_agent_id: $next_speaker, transfer: {item: {item_id: $item_id, quantity: $quantity}}}'
  elif [ -n "$money" ]; then
    require_positive_int "--money" "$money"
    jq -nc \
      --arg message "$message" \
      --arg next_speaker "$next_speaker" \
      --argjson money "$money" \
      '{message: $message, next_speaker_agent_id: $next_speaker, transfer: {money: $money}}'
  elif [ -n "$response" ]; then
    jq -nc \
      --arg message "$message" \
      --arg next_speaker "$next_speaker" \
      --arg response "$response" \
      '{message: $message, next_speaker_agent_id: $next_speaker, transfer_response: $response}'
  else
    json_obj message "${message}" next_speaker_agent_id "${next_speaker}"
  fi
}

command="${1:-help}"
shift

if [ "${KARAKURI_STRICT_GENERIC_COMMANDS:-1}" = "1" ]; then
  case "${command}" in
    help|-h|--help|login|logout|get_notification|command)
      ;;
    notif-*)
      echo "Error: notification_id was passed as the karakuri.sh command. Use: karakuri.sh command <notification_id> <choices[].command> '<params-json>'" >&2
      exit 1
      ;;
    *)
      echo "Error: direct karakuri.sh '${command}' is disabled. Use only: karakuri.sh get_notification <notification_id>, then karakuri.sh command <notification_id> <choices[].command> '<params-json>'" >&2
      exit 1
      ;;
  esac
fi

case "${command}" in
  login)
    [ $# -eq 0 ] || { echo "Usage: karakuri.sh login" >&2; exit 1; }
    do_post "/agents/login" '{}'
    ;;
  logout)
    [ $# -eq 0 ] || { echo "Usage: karakuri.sh logout" >&2; exit 1; }
    do_post "/agents/logout" '{}'
    ;;
  get_notification)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh get_notification <notification_id>" >&2; exit 1; }
    [ -n "$1" ] || { echo "Usage: karakuri.sh get_notification <notification_id>" >&2; exit 1; }
    notification_body="$(do_get "/agents/notifications/$1")"
    run_preprocess_hook "$1" "$notification_body"
    ;;
  command)
    [ $# -eq 3 ] || { echo "Usage: karakuri.sh command <notification_id> <command> <params-json>" >&2; exit 1; }
    require_notification_id "$1"
    if ! echo "$3" | jq -e 'type == "object"' >/dev/null; then
      echo "Error: params-json must be a JSON object." >&2
      exit 1
    fi
    do_agent_command "$1" "$2" "$3"
    ;;
  move)
    [ $# -eq 2 ] || { echo "Usage: karakuri.sh move <notification_id> <target_node_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_agent_command "$1" move "$(json_obj target_node_id "$2")"
    ;;
  get_perception)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh get_perception <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_info_command "$1" get_perception
    ;;
  get_available_actions)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh get_available_actions <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_info_command "$1" get_available_actions
    ;;
  action)
    [ $# -ge 2 ] || { echo "Usage: karakuri.sh action <notification_id> <action_id> [duration_minutes]" >&2; exit 1; }
    require_notification_id "$1"
    if [ $# -ge 3 ]; then
      require_positive_int "duration_minutes" "$3"
      do_agent_command "$1" action "$(jq -nc --arg action_id "$2" --argjson duration_minutes "$3" '{action_id: $action_id, duration_minutes: $duration_minutes}')"
    else
      do_agent_command "$1" action "$(json_obj action_id "$2")"
    fi
    ;;
  use_item)
    [ $# -eq 2 ] || { echo "Usage: karakuri.sh use_item <notification_id> <item_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_agent_command "$1" use_item "$(json_obj item_id "$2")"
    ;;
  transfer)
    transfer_usage='Usage: karakuri.sh transfer <notification_id> <target_agent_id> --item <item_id> [--quantity <n>]
       karakuri.sh transfer <notification_id> <target_agent_id> --money <amount>'
    [ $# -ge 2 ] || { printf '%s\n' "$transfer_usage" >&2; exit 1; }
    require_notification_id "$1"
    transfer_notification_id="$1"
    transfer_target="$2"
    shift 2
    transfer_item_id=""
    transfer_quantity="1"
    transfer_money=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --item)
          [ $# -ge 2 ] || { echo "Error: --item requires a value." >&2; exit 1; }
          transfer_item_id="$2"
          shift 2
          ;;
        --quantity)
          [ $# -ge 2 ] || { echo "Error: --quantity requires a value." >&2; exit 1; }
          transfer_quantity="$2"
          shift 2
          ;;
        --money)
          [ $# -ge 2 ] || { echo "Error: --money requires a value." >&2; exit 1; }
          transfer_money="$2"
          shift 2
          ;;
        *)
          printf '%s\n' "$transfer_usage" >&2
          exit 1
          ;;
      esac
    done
    if [ -n "$transfer_item_id" ] && [ -n "$transfer_money" ]; then
      echo "Error: --item and --money are mutually exclusive." >&2
      exit 1
    fi
    if [ -z "$transfer_item_id" ] && [ -z "$transfer_money" ]; then
      printf '%s\n' "$transfer_usage" >&2
      exit 1
    fi
    if [ -n "$transfer_item_id" ]; then
      require_positive_int "--quantity" "$transfer_quantity"
      transfer_payload="$(jq -nc \
        --arg target_agent_id "$transfer_target" \
        --arg item_id "$transfer_item_id" \
        --argjson quantity "$transfer_quantity" \
        '{target_agent_id: $target_agent_id, item: {item_id: $item_id, quantity: $quantity}}')"
    else
      require_positive_int "--money" "$transfer_money"
      transfer_payload="$(jq -nc \
        --arg target_agent_id "$transfer_target" \
        --argjson money "$transfer_money" \
        '{target_agent_id: $target_agent_id, money: $money}')"
    fi
    do_agent_command "$transfer_notification_id" transfer "$transfer_payload"
    ;;
  transfer_accept)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh transfer_accept <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_agent_command "$1" transfer_accept '{}'
    ;;
  transfer_reject)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh transfer_reject <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_agent_command "$1" transfer_reject '{}'
    ;;
  wait)
    [ $# -eq 2 ] || { echo "Usage: karakuri.sh wait <notification_id> <duration>" >&2; exit 1; }
    require_notification_id "$1"
    require_positive_int "duration" "$2"
    do_agent_command "$1" wait "$(jq -nc --argjson duration "$2" '{duration: $duration}')"
    ;;
  conversation_start)
    [ $# -ge 3 ] || { echo "Usage: karakuri.sh conversation_start <notification_id> <target_agent_id> <message>" >&2; exit 1; }
    require_notification_id "$1"
    do_agent_command "$1" conversation_start "$(json_obj target_agent_id "$2" message "${*:3}")"
    ;;
  conversation_accept)
    [ $# -ge 2 ] || { echo "Usage: karakuri.sh conversation_accept <notification_id> <message>" >&2; exit 1; }
    require_notification_id "$1"
    do_agent_command "$1" conversation_accept "$(json_obj message "${*:2}")"
    ;;
  conversation_reject)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh conversation_reject <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_agent_command "$1" conversation_reject '{}'
    ;;
  conversation_join)
    [ $# -eq 2 ] || { echo "Usage: karakuri.sh conversation_join <notification_id> <conversation_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_agent_command "$1" conversation_join "$(json_obj conversation_id "$2")"
    ;;
  conversation_stay)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh conversation_stay <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_agent_command "$1" conversation_stay '{}'
    ;;
  conversation_leave)
    [ $# -ge 1 ] || { echo "Usage: karakuri.sh conversation_leave <notification_id> [message]" >&2; exit 1; }
    require_notification_id "$1"
    if [ $# -ge 2 ]; then
      do_agent_command "$1" conversation_leave "$(json_obj message "${*:2}")"
    else
      do_agent_command "$1" conversation_leave '{}'
    fi
    ;;
  conversation_speak)
    [ $# -ge 3 ] || { echo "Usage: karakuri.sh conversation_speak <notification_id> <next_speaker_agent_id> <message> [--item <id> [--quantity <n>] | --money <amount> | --accept | --reject]" >&2; exit 1; }
    require_notification_id "$1"
    speak_notification_id="$1"
    shift
    speak_payload="$(build_conversation_payload "speak" "$@")"
    do_agent_command "$speak_notification_id" conversation_speak "$speak_payload"
    ;;
  conversation_end)
    [ $# -ge 3 ] || { echo "Usage: karakuri.sh conversation_end <notification_id> <next_speaker_agent_id> <message> [--accept | --reject]" >&2; exit 1; }
    require_notification_id "$1"
    end_notification_id="$1"
    shift
    end_payload="$(build_conversation_payload "end" "$@")"
    do_agent_command "$end_notification_id" conversation_end "$end_payload"
    ;;
  get_map)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh get_map <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_info_command "$1" get_map
    ;;
  get_world_agents)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh get_world_agents <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_info_command "$1" get_world_agents
    ;;
  get_status)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh get_status <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_info_command "$1" get_status
    ;;
  get_nearby_agents)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh get_nearby_agents <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_info_command "$1" get_nearby_agents
    ;;
  get_active_conversations)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh get_active_conversations <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_info_command "$1" get_active_conversations
    ;;
  get_event)
    [ $# -eq 1 ] || { echo "Usage: karakuri.sh get_event <notification_id>" >&2; exit 1; }
    require_notification_id "$1"
    do_info_command "$1" get_event
    ;;

  *)
    echo "Error: Unknown command '${command}'" >&2
    usage >&2
    exit 1
    ;;
esac
