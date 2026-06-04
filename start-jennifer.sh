#!/bin/bash
set -euo pipefail

BWS_RUNNER="/Users/infinitewatts/secrets-ops/bin/bws-run-profile"
NODE_BIN="/opt/homebrew/bin/node"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATH_VALUE="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.bun/bin"

env_args=("PATH=$PATH_VALUE" "HOME=$HOME")
for var in PORT JENNIFER_SYSTEM_PROMPT_PATH LEAD_SUMMARY_ENABLED ENABLE_IMESSAGE JENNIFER_NEW_CHAT_ALERTS CHAT_HISTORY_ACCESS_TOKEN JENNIFER_CHAT_HISTORY_FILE JENNIFER_CHAT_LEADS_FILE LEAD_TEXT_DELAY_MS OLLAMA_HOST OLLAMA_MODEL; do
  if [ "${!var+x}" = x ]; then
    env_args+=("$var=${!var}")
  fi
done

exec "$BWS_RUNNER" platform-ops -- /usr/bin/env "${env_args[@]}" "$NODE_BIN" "$SCRIPT_DIR/jennifer-proxy.js"
