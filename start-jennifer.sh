#!/bin/bash
set -euo pipefail

source "$HOME/.zeroclaw/lib/keychain-env.sh"
zc_require_keychain || exit 1
zc_export_required_kc "OpenRouter" "OPENROUTER_API_KEY"
zc_export_optional_kc "Telegram" "TELEGRAM_BOT_TOKEN"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.bun/bin"
exec /opt/homebrew/bin/node "$(dirname "$0")/jennifer-proxy.js"
