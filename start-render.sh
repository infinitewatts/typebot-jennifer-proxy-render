#!/usr/bin/env bash
set -euo pipefail

export LEAD_SUMMARY_ENABLED="${LEAD_SUMMARY_ENABLED:-0}"
export JENNIFER_SYSTEM_PROMPT_PATH="${JENNIFER_SYSTEM_PROMPT_PATH:-$(dirname "$0")/jennifer-system-prompt.txt}"

exec node "$(dirname "$0")/jennifer-proxy.js"
