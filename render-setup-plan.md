# Jennifer Render Runbook

## Decision
Move only Jennifer chat proxy first (`:3090`) to Render.

## Why first
- Smallest change surface
- Removes the chat webhook's dependency on the old local tunnel
- Keeps Typebot builder/viewer on current host until verified

## Current production endpoint strategy (adopted)
- The only required chat API hostname is `https://jennifer-proxy.onrender.com`.
- Typebot sends chat turns to `https://jennifer-proxy.onrender.com/chat`.

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
- `LEAD_SUMMARY_ENABLED` (optional `true`/`false`; Render currently keeps this disabled)
- `JENNIFER_MESSAGE_INTENT_URL` (optional; fixed signed-intent endpoint)
- `JENNIFER_MESSAGE_INTENT_SECRET` (required only to enable signed message intents)

## Runtime endpoints
- `GET /` returns proxy health: `{"status":"Solar chat proxy running"}`
- `POST /chat` is the website/Typebot webhook endpoint.
- `GET /history-ui?token=...` opens the hosted chat-history UI.
- `GET /history-ui` without a token returns the UI shell only; history data still requires the token on `/history` and `/leads`.
- `GET /history?token=...` returns all chat history as JSON.
- `GET /history?sessionId=...&token=...` returns one session.
- `GET /leads?token=...` returns captured partial and completed leads.
- `POST /history/import` imports old Typebot history; protect with the history token.

## Live Typebot flow invariants
1. The welcome text is exactly: `Hi, I'm Jennifer, Affordable Solar's AI assistant. What are you trying to figure out about solar?`
2. The flow creates one session ID per chat and reuses it for every turn in that chat.
3. Each visitor message is sent as JSON to `https://jennifer-proxy.onrender.com/chat` with the message and session ID.
4. The flow maps `data.response` to `llm_response`, displays it, and returns to one free-text input. It has no direct LLM block, category buttons, or separate lead-capture branch.
5. `settings.general.isInputPrefillEnabled` is `false` in both the matching `PublicTypebot` and `Typebot` rows.

## Chat and lead behavior
- Jennifer identifies as Affordable Solar's AI assistant and never implies she is human.
- The latest visitor message controls the topic. Jennifer answers explicit questions before discovery or callback collection.
- When Jennifer misunderstands a visitor, she briefly acknowledges the error and answers the corrected topic.
- Callback collection starts only after visitor agreement and remains interruptible by questions, corrections, or withdrawal.
- Capturing callback details does not end the conversation.
- A lead can be `partial` once a phone number is captured.
- A lead becomes `completed` when name, phone, and preferred call time are captured.
- A completed lead asks separately whether Eric may text the captured number.
  Callback consent alone is never text consent.
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
- Claims under `APPROVED KNOWLEDGE` in `jennifer-system-prompt.txt` are business-owned claims and must be reverified when products, certifications, warranties, financing, service coverage, or utility facts change.
- Jennifer never invokes Messages or accepts an outbound body. With explicit
  text consent and both intent settings present, it sends a signed fixed-template
  intent to the Mac queue; customer dispatch remains independently disabled.
- Ollama summary is guarded behind `OLLAMA_HOST` + timeout; default keep disabled unless explicitly enabled.
- Pushover and Telegram are optional. Missing notification credentials must not break chat handling.
- Pushover secrets can be copied from local config files into Render env vars without committing values:
  - `/Users/infinitewatts/.config/pushover/.api_token` -> `PUSHOVER_API_TOKEN`
  - `/Users/infinitewatts/.config/pushover/.user_key` -> `PUSHOVER_USER_KEY`
  - `/Users/infinitewatts/.config/pushover/.device` -> `PUSHOVER_DEVICE`

## Verification command
Run the deterministic conversation regressions before every deploy:

```sh
node --test jennifer-test-harness.js
```

## Backup gate
1. Export the matching `PublicTypebot` row and `Typebot` row before any live flow change.
2. Store the backup outside the database and record its SHA-256 hash.
3. Verify the backup contains groups, edges, variables, settings, and the five live-flow invariants above.
4. Do not mutate the live flow unless the backup parses and its hash has been recorded.

## Deploy gate
1. Run `node --test jennifer-test-harness.js` and `node --check jennifer-proxy.js` from the deployment commit.
2. Update and verify the AI-disclosing Typebot welcome before deploying a prompt that assumes the disclosure is present.
3. Verify Render reaches `live` with the intended commit from `typebot-jennifer-proxy-render`.
4. Verify `GET /` returns `{"status":"Solar chat proxy running"}` and `POST /chat` returns valid JSON.
5. Run the answer-first, identity, topic-repair, interrupted-handoff, and no-repeat production smoke cases.
6. Confirm the five live-flow invariants again after the smoke run.

## Rollback gate
1. If a deploy or smoke gate fails, redeploy the last verified Render commit.
2. If the Typebot flow changed, restore both rows together from the matching verified backup.
3. Recheck the health endpoint, one chat turn, and all five live-flow invariants.
4. Do not use historical full-flow SQL files as rollback sources.

## Current production notes
- The Render URL is the active production chat proxy.
- Telegram and Pushover alerts are additive; neither replaces the other.
- Render filesystem JSONL storage is acceptable for the current lightweight setup, but Postgres or a Render disk is the recommended next durability upgrade if lead/history persistence becomes business-critical.
- If Render is the active production path, retire the old local `launchd` units for `com.infinitewatts.jennifer-proxy`. Leaving them on with `KeepAlive` can create a local crash loop and noisy monitoring if the `OpenRouter / OPENROUTER_API_KEY` keychain item is missing.
- Re-enable the local launcher only for intentional local testing, and only after verifying the required `OPENROUTER_API_KEY` keychain secret exists.
- The local launcher should use the shared BWS runner (`/Users/infinitewatts/secrets-ops/bin/bws-run-profile platform-ops`) rather than direct per-app Keychain secret lookup so it matches the current operator secret-delivery model.
