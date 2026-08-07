# Jennifer Mac Mini Production Cutover Spec

Date: 2026-07-19
Status: Ready for Phase 0; production is unchanged
Cutover gates: encrypted off-host restore proof; approved reboot with independent console recovery
Owner: Infinite Watts
Execution: Codex leader with role-specialized subagents

## Decision

Move Jennifer's production proxy from Render back to the Mac Mini because the
Typebot viewer and Cloudflare tunnel already depend on that host. Run Jennifer
as an always-on system LaunchDaemon, persist chat state outside the repository,
and make `https://jennifer.affordablesolar.io/chat` the only production webhook.

The UPS is confirmed by the owner. Render remains a manual rollback target for
seven days after cutover, then is retired. It is not an automatic fallback and
there is no dual routing or dual write.

## Goal

Remove Render cold starts and ephemeral chat storage without regressing the
conversation repair, notifications, protected history access, or deployment
safety. The completed system must start after a host reboot without a GUI login,
serve the branded Jennifer hostname, and recover from a process crash through
launchd.

## Current State

Verified on 2026-07-19:

- Production code: commit `ffde65bf02679e0fd72730be7090ef899cca7461`.
- Active Render service: `srv-d8fdc1v40ujc738gr1cg`.
- Active Render deploy: `dep-d9dsubj7uimc73c5kucg`, status `live`.
- Both Typebot rows call `https://jennifer-proxy.onrender.com/chat`:
  - `PublicTypebot` `cmmy41w3m0002my1z919waitb`
  - `Typebot` `cmmy404ln0001my1zn5g8uagy`
- Input prefill is `false` in both rows.
- The Cloudflare ingress rule already maps
  `jennifer.affordablesolar.io` to `http://localhost:3090`, and the ingress file
  validates.
- Cloudflare Tunnel already runs through the system LaunchDaemon
  `/Library/LaunchDaemons/com.infinitewatts.cloudflared-typebot.plist` with
  `RunAtLoad` and `KeepAlive` enabled.
- The Typebot viewer, builder, Redis, and Postgres containers all use the
  Docker restart policy `always` under the `orbstack` Docker context.
- The existing `/Library/LaunchDaemons/com.infinitewatts.orbstack.plist` is not
  boot-ready: its XML does not pass `plutil -lint`, its loaded job last exited
  with code 2, and stderr reports a TCC permission denial for OrbStack's data
  directory. Container restart policies do not help until OrbStack itself
  starts.
- `jennifer.affordablesolar.io` currently returns HTTP 502 because nothing is
  listening on port 3090.
- The old user LaunchAgent is disabled at
  `~/Library/LaunchAgents/com.infinitewatts.jennifer-proxy.plist.disabled`.
- An older system LaunchDaemon is also disabled at
  `/Library/LaunchDaemons/com.infinitewatts.jennifer-proxy.plist.disabled`.
- The old launcher still uses the rollback-only `platform-ops` BWS profile and
  must not be re-enabled unchanged.
- Current Render environment keys cover OpenRouter, Telegram, Pushover, and the
  protected history token.
- Current Render state reports zero history sessions, zero history messages,
  and zero leads. Recheck immediately before cutover because free-instance
  storage is ephemeral and the count can change.
- The repository has eight legacy history records in untracked
  `chat-history.jsonl` and no `chat-leads.jsonl`.
- Native Time Machine currently has no configured destination.

## Constraints

- No model or provider change.
- No new application dependency.
- Preserve all 41 conversation regressions.
- Do not print, commit, or write secret values to reusable shell history.
- Do not use `platform-ops`, the personal BWS backup token, local `.env` files,
  or silent secret fallbacks in the final runtime.
- Back up before every database or state-file mutation.
- Keep chat and lead JSONL files outside the Git worktree with mode `0600`.
- Keep the existing AI greeting, input-prefill setting, and conversation logic.
- Do not retain a tracked full-flow SQL snapshot.
- Render rollback is temporary and manual. Retire it after the burn-in gate.
- A host reboot requires explicit approval at execution time.
- A reboot also requires an owner-approved maintenance window and confirmed
  physical-console or remote-management access that does not depend on
  OrbStack, Docker, Typebot, or the Cloudflare tunnel.
- Do not switch Typebot to the Mac proxy until OrbStack, all four Typebot
  containers, Cloudflare Tunnel, and Jennifer pass a no-GUI-login reboot test.

## Non-Goals

- Moving Typebot, Postgres, Redis, or Cloudflare Tunnel to another host.
- Replacing JSONL persistence with a database.
- Changing the website widget design.
- Adding automatic failover between the Mac Mini and Render.
- Reworking notification delivery or retry semantics.
- Changing business claims in the Jennifer prompt.

## Target Architecture

```text
Visitor
  -> chat.affordablesolar.io (Typebot on Mac Mini)
  -> jennifer.affordablesolar.io/chat
  -> existing Cloudflare Tunnel
  -> 127.0.0.1:3090
  -> jennifer-proxy.js system LaunchDaemon
  -> OpenRouter
  -> Telegram and Pushover alerts
```

Render is absent from the active request path after the Typebot transaction.

## Runtime Contract

### OrbStack Dependency

[OrbStack documents command-line and headless operation](https://docs.orbstack.dev/headless),
but the current custom LaunchDaemon does not satisfy that contract. Replace it
with a reviewed, valid system LaunchDaemon that has:

- `UserName`: `infinitewatts`
- `ProgramArguments`: exactly one array entry, `/usr/local/bin/orb`, with no
  arguments, shell composition, or unescaped `&&`
- `RunAtLoad`: `true`
- `KeepAlive`: retry only after an unsuccessful exit
- `ThrottleInterval`: at least 30 seconds
- explicit `HOME=/Users/infinitewatts` and the deterministic runtime `PATH`
- dedicated stdout and stderr paths under the protected InfiniteWatts log
  directory

Install it as `root:wheel` with mode `0644`. A successful invocation and healthy
containers are necessary but not sufficient; the required proof is the approved
reboot test before cutover. If TCC still prevents startup without a login, stop
the migration. Do not enable automatic login or grant broader privacy access
without a separate owner decision.

### Service

Install `/Library/LaunchDaemons/com.infinitewatts.jennifer-proxy.plist` with:

- `UserName`: `infinitewatts`
- `WorkingDirectory`: `/Users/infinitewatts/typebot`
- `ProgramArguments`: exactly two array entries, `/bin/bash` and
  `/Users/infinitewatts/typebot/start-jennifer.sh`
- `RunAtLoad`: `true`
- `KeepAlive`: restart after an abnormal exit
- `ThrottleInterval`: at least 10 seconds
- `EnvironmentVariables`: the exact `HOME` and `PATH` values in the next section
- no `LimitLoadToSessionType`; the service must not require an Aqua login
- stdout and stderr under
  `/Users/infinitewatts/Library/Logs/InfiniteWatts/`

Validate the plist before installation, then install it as `root:wheel` with
mode `0644`. Create the log directory as `infinitewatts` with mode `0700`. Do
not re-enable either disabled legacy service. Remove both old disabled plists
after the new system daemon passes burn-in so only one service authority
remains.

### Nonsecret Environment

The LaunchDaemon and launcher own these explicit defaults and must not depend
on a login shell. The launcher assigns `HOME` before its first dereference:

- `HOME=/Users/infinitewatts`
- `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/infinitewatts/.local/bin:/Users/infinitewatts/.bun/bin`
- `PORT=3090`
- `JENNIFER_PUBLIC_BASE_URL=https://jennifer.affordablesolar.io`
- `JENNIFER_SYSTEM_PROMPT_PATH=/Users/infinitewatts/typebot/jennifer-system-prompt.txt`
- `JENNIFER_CHAT_HISTORY_ENABLED=true`
- `JENNIFER_NEW_CHAT_ALERTS=true`
- `JENNIFER_CHAT_HISTORY_FILE=/Users/infinitewatts/Library/Application Support/InfiniteWatts/jennifer/chat-history.jsonl`
- `JENNIFER_CHAT_LEADS_FILE=/Users/infinitewatts/Library/Application Support/InfiniteWatts/jennifer/chat-leads.jsonl`
- `LEAD_SUMMARY_ENABLED=false`
- `ENABLE_IMESSAGE=false`

Retain the current production `LEAD_TEXT_DELAY_MS` value. Do not add Ollama or
iMessage as a launch dependency.

### Secret Delivery

Add one `jennifer-proxy` profile to
`/Users/infinitewatts/secrets-ops/config/bws-profiles.json`. It injects only:

- `OPENROUTER_API_KEY` from `operator-tooling`
  (`47d126d4-6dce-41f9-a493-b466005360b6`)
- `TELEGRAM_BOT_TOKEN`, `PUSHOVER_API_TOKEN`, `PUSHOVER_USER_KEY`,
  `PUSHOVER_DEVICE`, and `CHAT_HISTORY_ACCESS_TOKEN` from
  `affordable-solar-automations`
  (`ee78f1b6-ff8e-4618-900a-b46600419414`)

Model the profile with a `projects` array and this bootstrap contract:

- Keychain service: `Bitwarden Secrets Manager - Jennifer Proxy`
- Keychain account: `BWS_ACCESS_TOKEN`
- Headless bootstrap file:
  `/Library/Application Support/InfiniteWatts/secrets/jennifer-proxy-bws-access-token`

The system daemon uses the scoped bootstrap file because it cannot depend on a
login Keychain. The profile retains the Keychain metadata so existing
secrets-ops audits can validate its ownership and scope.

Before adding the profile:

1. Copy the Pushover secrets from their current authoritative/local sources
   into the organization `affordable-solar-automations` project without
   printing values.
2. Copy `CHAT_HISTORY_ACCESS_TOKEN` from the current Render environment into
   that project without printing it.
3. Update the secret registry, machine registry, and BWS token-scope matrix so
   these keys no longer point to the personal `platform-ops` project and the
   Jennifer token is allowed only the two named projects.
4. Create a read-only Jennifer machine account scoped only to the two projects.
5. Store its bootstrap token at
   `/Library/Application Support/InfiniteWatts/secrets/jennifer-proxy-bws-access-token`
   with owner `infinitewatts` and mode `0600` for headless launch.
6. Run the secrets-ops registry and live token-scope audits, then verify
   required-key presence and notifier identity without printing values.

`start-jennifer.sh` must execute only through
`bws-run-profile jennifer-proxy`. Missing required secrets fail startup; there
is no legacy Keychain item, alternate bootstrap file, or `platform-ops`
fallback.

## Persistence Contract

Create the state directory with mode `0700`:

`/Users/infinitewatts/Library/Application Support/InfiniteWatts/jennifer`

Before starting the production daemon:

1. Create a timestamped mode-`0700` backup directory beneath `backups/`.
2. Copy the existing local `chat-history.jsonl` into the backup.
3. Requery Render `/history` and `/leads` using the protected token.
4. Export every Render session, flattening messages to
   `{sessionId, role, content, at}` JSONL records.
5. Reject history records with a missing or invalid `at` timestamp. Deduplicate
   by the exact tuple `sessionId + role + content + at`, then stable-sort by
   parsed `at`, preserving source order for equal timestamps.
6. Verify timestamps are nondecreasing within every session after the history
   sort.
7. Merge leads by `sessionId` using `withdrawnAt` as the event time for a
   withdrawn record and `createdAt` otherwise. Keep the newest event; if event
   times tie, a withdrawal wins so a do-not-call instruction cannot be lost.
8. Sort the selected lead records by event time so the proxy's last-record-wins
   loader is deterministic.
9. Validate every output line with `jq`, record line counts and SHA-256 hashes,
   then install the final files with mode `0600`.
10. Leave the repository copies untouched until the daemon loads and exposes
   the expected counts. Delete the untracked repository history copy only after
   backup and verification.

Do not store exported chat content in tracked evidence or shell output.

The timestamped directory above is a rollback snapshot, not disaster recovery.
Before Phase 2, configure an encrypted Time Machine destination or another
owner-approved encrypted off-host backup that covers the Jennifer state
directory. Prove coverage with an actual restore to a temporary directory and
matching hashes. The production cutover is blocked until this restore test
passes; no third-party backup dependency is required by the spec.

## Planned Repository and Host Changes

- Add this specification.
- Update `start-jennifer.sh` for the dedicated BWS profile, branded public URL,
  and external state paths.
- Add reviewed Jennifer and OrbStack LaunchDaemon plist templates to the
  repository, then install them under `/Library/LaunchDaemons` during execution.
- Change the default public base URL in `jennifer-proxy.js` from Render to the
  branded Jennifer hostname.
- Update `render-setup-plan.md` into the Mac Mini production runbook.
- Update `secrets-ops` profiles and registry for the Jennifer runtime.
- Record the reviewed deployment commit and a SHA-256 manifest for the proxy,
  prompt, launcher, and both LaunchDaemon templates outside the chat-data
  directory.
- After burn-in, delete `render.yaml` and `start-render.sh`, remove the local
  `render-public` Git remote, and delete the Render service.
- Remove both disabled legacy service plists after the new system daemon is
  authoritative.

Do not change conversation routing, prompt content, or lead-scoring behavior in
this migration.

## Execution Plan

### Phase 0: Security and Backups

1. Rotate the exposed Render API key and restore the scoped `platform-infra`
   BWS bootstrap before using Render API operations.
2. Record the current Git commit, Render deploy, Typebot row IDs, Cloudflare
   tunnel ID, and public health results.
3. Export and hash the exact current `PublicTypebot` and `Typebot` rows.
4. Back up both disabled Jennifer service plists, the current OrbStack plist and
   failure log, the launcher, tunnel config, local history, and any existing
   Jennifer state directory.
5. Configure and restore-test the encrypted off-host state backup described in
   the Persistence Contract.
6. Record and dry-review the manual recovery path: log in through the confirmed
   console, unload the replacement OrbStack job, restore its saved plist, start
   OrbStack through the known working user-session path, and verify Typebot.

Gate: all snapshots parse, hashes are recorded, off-host restore proof and an
independent console recovery path exist, and no live chat configuration changed.

### Phase 1: Secrets and Local Runtime

1. Complete the scoped BWS changes in the Secret Delivery section.
2. Update the launcher and prepare both system LaunchDaemons.
3. Validate with `bash -n`, `plutil -lint` on both templates, and
   `cloudflared tunnel ingress validate`.
4. Run `node --test jennifer-test-harness.js` and both Node syntax checks.
5. Start an isolated instance on port 3099 with temporary state and history
   writes disabled. After BWS validates and injects the required keys, use
   child-process environment overrides to blank `TELEGRAM_BOT_TOKEN`,
   `PUSHOVER_API_TOKEN`, `PUSHOVER_TOKEN`, `PUSHOVER_USER_KEY`,
   `PUSHOVER_USER`, and `PUSHOVER_DEVICE`; also set
   `JENNIFER_CHAT_HISTORY_ENABLED=false`, `JENNIFER_NEW_CHAT_ALERTS=false`,
   `LEAD_SUMMARY_ENABLED=false`, and `ENABLE_IMESSAGE=false`.
6. Replay the July 18 cost/off-grid transcript, identity question, office-call
   request, explicit callback request, and interruption cases.
7. Commit only the reviewed migration files using the Lore Commit Protocol.
   Record the commit plus SHA-256 hashes for `jennifer-proxy.js`,
   `jennifer-system-prompt.txt`, `start-jennifer.sh`, and the LaunchDaemon
   templates. Require those tracked files to match the commit; do not require
   a globally clean worktree because the legacy untracked history file remains.

Gate: 41 tests pass, the real-model replay passes, the isolated instance does
not write production data or send alerts, and the deployment revision and file
hashes are pinned.

### Phase 2: Data Merge and Dark Launch

1. Stop the isolated instance.
2. Perform the baseline Render/local state export and merge.
3. Verify the runtime files against the recorded deployment commit and hash
   manifest, then install and bootstrap the OrbStack repair and Jennifer's
   system LaunchDaemon on port 3090 while Typebot still points to Render.
4. Verify:
   - `launchctl print system/com.infinitewatts.orbstack` shows the expected
     one-entry argv and a successful last exit
   - Docker is reachable and the viewer, builder, Redis, and Postgres containers
     are running, with Redis and Postgres healthy
   - the public Typebot chat endpoint returns HTTP 200
   - `launchctl print system/com.infinitewatts.jennifer-proxy`
   - local and public `GET /` return HTTP 200 and
     `{"status":"Solar chat proxy running"}`
   - public `POST /chat` with a labeled supplied `sessionId` returns JSON with
     the same `sessionId` and a nonempty `response`
   - the response does not equal either built-in parse/OpenRouter error fallback,
     and the matching decision log has no `error: true` event
   - protected history endpoints return HTTP 401 without the token
   - expected history and lead counts load after a service restart
5. Use the labeled `/chat` smoke as the one Telegram/Pushover test and verify
   both delivery results without sending a second alert.
6. Enter the owner-approved maintenance window and reconfirm console access plus
   the manual-login OrbStack recovery path. Do not reboot if either is missing.
7. With explicit approval, reboot the Mac while Jennifer's Typebot webhook still
   uses Render.
   Without a GUI login, verify the OrbStack job exits successfully, Docker is
   reachable, all four Typebot containers are healthy, the public Typebot and
   Cloudflare routes return, and Jennifer passes the checks above.

Gate: the branded endpoint is healthy, persistence survives restart, both
notifiers work, the entire local stack survives the no-login reboot, and Render
remains the production webhook.

### Phase 3: Typebot Cutover

Run one assertion-guarded Postgres transaction that:

1. Locks the exact two Typebot rows.
2. Asserts their IDs, current Render webhook, canonical AI greeting, and
   input-prefill state.
3. Replaces only
   `https://jennifer-proxy.onrender.com/chat` with
   `https://jennifer.affordablesolar.io/chat`.
4. Updates `updatedAt` only on those rows.
5. Asserts exactly one public row and one source row changed.

Re-export both rows and perform a structured diff. Only the webhook and
`updatedAt` may differ. Use the saved row exports only as assertion and diff
authority, never as wholesale restore payloads. Do not create a tracked
full-flow SQL file.

Then reconcile the cutover boundary:

1. Record the webhook commit time in UTC and the baseline Render export hashes.
2. Let pre-switch Render requests drain. Require Render request evidence to
   show no post-switch `/chat` starts, then take two protected Render history
   and lead exports 60 seconds apart. Their hashes must match. If Render is not
   quiescent within five minutes, reverse the webhook transaction and abort.
3. During a low-traffic, bounded maintenance pause, unload Jennifer, snapshot
   the current Mac state, and merge the stable Render delta into that snapshot
   with the Persistence Contract rules. Validate the result and atomically
   install it before restarting Jennifer. If the branded endpoint is not
   healthy again within 30 seconds, reverse the webhook transaction.
4. Prove the restarted Mac counts and hashes equal the deduplicated union of
   the baseline, post-switch Render delta, and Mac records. Recheck that no
   withdrawal was superseded.

Gate: a real website conversation passes the repaired July 18 transcript with
no outage assumption, repetition, or premature contact capture, and the
cutover-boundary reconciliation passes.

### Phase 4: Monitoring and Burn-In

1. Point the Jennifer uptime monitor at
   `https://jennifer.affordablesolar.io/` and expect HTTP 200 plus the health
   JSON. Do not monitor protected history endpoints.
2. Verify launchd restart behavior with `bootout`, `bootstrap`, and `kickstart`.
3. Confirm the public endpoint remains warm after more than 15 minutes idle.
4. Review launchd status, restart count, stderr, chat writes, notification
   delivery, and public latency daily for seven days.
5. Keep Render live but unused only as a manual rollback during this period.
6. Confirm the pre-cutover reboot evidence remains current; repeat the test only
   if the OrbStack, Docker, tunnel, or launchd configuration changed.

Gate: seven days without crash loops, lost state, failed health checks, or
conversation regression, and the controlled reboot test passes.

### Phase 5: Strict Render Retirement

1. Confirm both Typebot rows still use the branded webhook and Render has
   received no production traffic during burn-in.
2. Recheck and back up any final Render history/leads.
3. Record Render service/deploy metadata and environment key names without
   values.
4. Delete the Render service `srv-d8fdc1v40ujc738gr1cg`.
5. Delete Render-only repo files and update the production runbook.
6. Remove the local `render-public` remote and stop pushing to the Render repo.
7. Remove both disabled legacy Jennifer service plists.
8. Decide separately whether to delete the remote GitHub deployment repository;
   repository deletion is irreversible and is not implied by this spec.

Gate: no active configuration, code path, documentation, or service treats
Render as a fallback.

## Verification Matrix

| Surface | Required proof |
| --- | --- |
| Conversation | `node --test` passes all 41 cases and the production replay passes |
| Runtime | system LaunchDaemon is running as `infinitewatts` on port 3090 |
| Boot | OrbStack, four Typebot containers, Cloudflare, and Jennifer return after an approved reboot without GUI login |
| Public route | health JSON is exact; `/chat` returns the supplied session ID, non-fallback content, and no error event |
| Latency | warm health is below 1 second and no 15-minute idle cold start occurs |
| Secrets | dedicated BWS profile injects all required keys and no legacy profile is used |
| Privacy | no secret values or chat content appear in logs or tracked files |
| Persistence | history/leads survive restart with verified counts and hashes |
| Backup | encrypted off-host restore reproduces the state-file hashes |
| Typebot | only webhook and `updatedAt` change in the two authoritative rows |
| Notifications | one labeled Telegram and Pushover test succeeds |
| Monitoring | public health monitor targets the branded root endpoint |
| Retirement | Render service and Render-only runtime files are removed after burn-in |

## Rollback

### Before Typebot Cutover

Jennifer's webhook remains on Render and no Typebot row rollback is needed, but
the production Typebot frontend and database already depend on OrbStack. If the
replacement OrbStack job or reboot test fails:

1. Use the confirmed console or independent remote-management path and log in.
2. Unload the replacement OrbStack system job, restore the saved prior plist for
   exact status-quo recovery, and start OrbStack through the known working
   user-session path. Do not bootstrap the known-broken prior system job.
3. Verify Docker, all four containers, Postgres/Redis health, and the public
   Typebot route. Start the existing compose project if restart policies did not
   recover every container.
4. Stop or unload the local Jennifer daemon if it contributed to the failure.
   Leave both Typebot rows on Render and abort the migration.

### During Seven-Day Burn-In

1. If the Mac is responsive, spend no more than two minutes draining current
   requests, snapshotting its state, and importing post-cutover history into
   Render through the protected `/history/import` endpoint. Verify imported
   session counts before changing the webhook. Preserve the local lead and
   withdrawal export as the operator's do-not-call authority because Render has
   no lead-import endpoint. If the Mac is unavailable, record that active-session
   continuity could not be preserved and prioritize service restoration.
2. Run an assertion-guarded reverse transaction against the current rows. Assert
   the exact IDs, branded webhook, greeting, and input-prefill state, then change
   only the webhook back to `https://jennifer-proxy.onrender.com/chat` and update
   `updatedAt`. Never write an entire saved row back to the database.
3. Verify Render deploy `dep-d9dsubj7uimc73c5kucg` is live at Git revision
   `ffde65bf02679e0fd72730be7090ef899cca7461`.
4. Stop the local daemon if it is corrupting state; otherwise leave it dark for
   diagnosis.
5. Before repairing state, stop Jennifer and create a new timestamped snapshot
   of the current files. Merge the chosen known-good snapshot with the current
   files using the same ordering and withdrawal rules; never replace current
   JSONL files wholesale. Revalidate hashes and counts before restart.

### After Render Retirement

There is no maintained fallback. Recovery means repairing the Mac runtime or
creating a new deployment from the verified Git commit. Do not restore stale
Render files, legacy BWS profiles, or the old user LaunchAgent.

## Acceptance Criteria

- The dedicated BWS profile works headlessly and fails closed when a required
  key is absent.
- No production launcher references `platform-ops` or the personal BWS token.
- Jennifer starts through a system LaunchDaemon and survives restart/reboot.
- `jennifer.affordablesolar.io` returns HTTP 200 instead of 502.
- Both Typebot rows use the branded webhook and retain the canonical greeting
  and input-prefill setting.
- All 41 conversation regressions and the labeled production replay pass.
- Telegram and Pushover alerts work without iMessage or Ollama.
- History and leads live outside the repository, parse as JSONL, and survive a
  service restart.
- An encrypted off-host restore reproduces the state-file hashes.
- The untracked repository history file is removed only after verified backup.
- The public endpoint has no Render-style idle cold start.
- Render is fully retired after the seven-day gate with no compatibility
  fallback left behind.

## Remaining Risks

- The Mac Mini remains dependent on local power, ISP connectivity, and the
  Cloudflare tunnel. The owner confirms a UPS, but an ISP outage still affects
  both Typebot and Jennifer.
- OrbStack's current custom boot job fails with a TCC denial. The cutover stays
  blocked unless the replacement passes the approved no-login reboot test.
- JSONL is single-host persistence. Concurrent multi-instance writes are not
  supported; replacing it with a database is required before horizontal scale.
- A system LaunchDaemon cannot use GUI-only iMessage behavior; the target keeps
  iMessage disabled.
- The current notifier status is not delivery-aware, so failed delivery is not
  retried automatically.
- An emergency Render rollback can duplicate partial-lead alerts because the
  retained Render service has history import but no lead import. The local
  withdrawal ledger remains the do-not-call authority during that rollback.
- The retained business claims in the prompt still require owner verification.
