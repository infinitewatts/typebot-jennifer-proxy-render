# Jennifer Render Runbook

## Decision
Move only Jennifer chat proxy first (`:3090`) to Render.

## Why first
- Smallest change surface
- Removes primary failure point behind Cloudflare tunnel (jennifer.affordablesolar.io)
- Keeps Typebot builder/viewer on current host until verified

## Current production endpoint strategy (adopted)
- Primary hostname for the chat API is the Render URL: `https://jennifer-proxy.onrender.com`
- `jennifer.affordablesolar.io` may remain as a branded frontend alias when explicitly routed, but is **not required for function**.
- Keep branded DNS/tunnel mapping only if you want the vanity domain in public usage; the service is fully usable without it.

## Render deployment contract
- Service: `jennifer-proxy`
- Render service id: `srv-d8fdc1v40ujc738gr1cg`
- Environment: Node.js
- Start command: `./start-render.sh`
- Build command used in deploy flow: `bun install --no-save`
- Health check endpoint: `/`
- Region: oregon
- Plan: free
- Scaling: 1 instance, always on
- Source remote used by Render: `typebot-jennifer-proxy-render`

## Env vars needed
- `OPENROUTER_API_KEY` (required)
- `TELEGRAM_BOT_TOKEN` (optional, sends alerts to the Sales topic when present)
- `PUSHOVER_API_TOKEN` or `PUSHOVER_TOKEN` (optional, required for Pushover alerts)
- `PUSHOVER_USER_KEY` or `PUSHOVER_USER` (optional, required for Pushover alerts)
- `PUSHOVER_DEVICE` (optional, targets one Pushover device)
- `CHAT_HISTORY_ACCESS_TOKEN` (required when history endpoints are protected)
- `JENNIFER_SYSTEM_PROMPT_PATH` (optional, defaults to `./jennifer-system-prompt.txt`)
- `LEAD_TEXT_DELAY_MS` (optional, defaults to `240000`)
- `LEAD_SUMMARY_ENABLED` (optional `true`/`false`; Render currently keeps this disabled)
- `ENABLE_IMESSAGE` (optional `false` by default)

## Runtime endpoints
- `GET /` returns proxy health: `{"status":"Solar chat proxy running"}`
- `POST /chat` is the website/Typebot webhook endpoint.
- `GET /history-ui?token=...` opens the hosted chat-history UI.
- `GET /history-ui` without a token returns the UI shell only; history data still requires the token on `/history` and `/leads`.
- `GET /history?token=...` returns all chat history as JSON.
- `GET /history?sessionId=...&token=...` returns one session.
- `GET /leads?token=...` returns captured partial and completed leads.
- `POST /history/import` imports old Typebot history; protect with the history token.

## Chat and lead behavior
- The Typebot website flow should call `https://jennifer-proxy.onrender.com/chat`.
- Jennifer answers first, then discovers the visitor's reason before qualification.
- Equipment, quote, battery, hail, and vague-intent flows use topic-specific discovery.
- The proxy tracks repeated discovery questions per in-memory session and avoids repeating exact questions when possible.
- A lead can be `partial` once a phone number is captured.
- A lead becomes `completed` when name, phone, and preferred call time are captured.
- Lead records are stored in `chat-leads.jsonl` and exposed through `/leads`.
- Chat history is stored in `chat-history.jsonl` and exposed through `/history-ui`.

## Notifications
- New website chat starts send:
  - Telegram alert when `TELEGRAM_BOT_TOKEN` is set.
  - Pushover alert when `PUSHOVER_API_TOKEN` and `PUSHOVER_USER_KEY` are set.
  - ntfy fallback only when Telegram is not configured.
- Partial and completed leads send:
  - Telegram alert with lead details.
  - Pushover alert with `HOT`, `WARM`, or `CASUAL` title context.
- Pushover delivery is confirmed in Render logs with:
  - `Pushover alert sent, status: 1`
- Telegram delivery is confirmed in Render logs with:
  - `Telegram alert sent, ok: true`
- Alert links to chat history must include `CHAT_HISTORY_ACCESS_TOKEN` when history protection is enabled.

## Notes before deploy
- `jennifer-proxy.js` uses container-safe, repo-relative prompt resolution for `/chat` startup.
- iMessage send path is guarded behind `ENABLE_IMESSAGE=true` and falls back on Linux hosts.
- Ollama summary is guarded behind `OLLAMA_HOST` + timeout; default keep disabled unless explicitly enabled.
- Pushover and Telegram are optional. Missing notification credentials must not break chat handling.
- Pushover secrets can be copied from local config files into Render env vars without committing values:
  - `/Users/infinitewatts/.config/pushover/.api_token` -> `PUSHOVER_API_TOKEN`
  - `/Users/infinitewatts/.config/pushover/.user_key` -> `PUSHOVER_USER_KEY`
  - `/Users/infinitewatts/.config/pushover/.device` -> `PUSHOVER_DEVICE`

## Migration steps
1. Keep render runtime files under `/typebot` (`render.yaml`, `start-render.sh`, `package.json`, code updates).
2. Verify deploy reaches `live` state in Render CLI with commit from `typebot-jennifer-proxy-render`.
3. Smoke tests:
   - `GET /` -> `{"status":"Solar chat proxy running"}`
   - `POST /chat` -> valid JSON response
   - Better Stack uptime checks should target `GET /` only, not `/history-ui`, `/history`, or local `:3090`.
   - Render logs include `Pushover alert sent, status: 1` after a new-chat test when Pushover is configured.
4. Verify production hostname target path:
   - `https://jennifer-proxy.onrender.com` (required)
   - `https://jennifer.affordablesolar.io` (optional only if you want branded access)
5. After this baseline is stable, proceed with Typebot viewer/builder migration next.

## Current production notes
- The Render URL is the active production chat proxy.
- Telegram and Pushover alerts are additive; neither replaces the other.
- Render filesystem JSONL storage is acceptable for the current lightweight setup, but Postgres or a Render disk is the recommended next durability upgrade if lead/history persistence becomes business-critical.
- If Render is the active production path, retire the old local `launchd` units for `com.infinitewatts.jennifer-proxy`. Leaving them on with `KeepAlive` can create a local crash loop and noisy monitoring if the `OpenRouter / OPENROUTER_API_KEY` keychain item is missing.
- Re-enable the local launcher only for intentional local testing, and only after verifying the required `OPENROUTER_API_KEY` keychain secret exists.
- The local launcher should use the shared BWS runner (`/Users/infinitewatts/secrets-ops/bin/bws-run-profile platform-ops`) rather than direct per-app Keychain secret lookup so it matches the current operator secret-delivery model.
