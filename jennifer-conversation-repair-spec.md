# Jennifer Conversation Repair Spec

Date: 2026-07-18
Status: Approved for execution by user request
Owner: Codex

## Goal

Make Jennifer answer the visitor's current question, preserve the visitor's
actual reason across turns, recover naturally from corrections and topic
changes, and collect lead details without turning the conversation into a
forward-only form.

The repair is complete when the July 18 failure and the related false-name,
false-time, repetition, identity, and premature-handoff failures are protected
by runnable tests and no longer reproduce.

## Evidence

The canonical audit is:

`/Users/infinitewatts/typebot/.omx/evidence/chatbot-conversation-audit-2026-07-18.md`

Target proxy session: `l9xutpodr5z400eseng088a3`.

The visitor asked about the cost of an off-grid home system. Jennifer asked how
long they had been without power, ignored the stated energy-independence reason,
then repeated the same outage question. Both webhooks returned HTTP 200. The
first response took 14.974 seconds.

## Constraints

- No new dependencies.
- Use built-in `node:test`.
- Prefer deletion over more regex patches.
- Keep factual, privacy, safety, and notification behavior intact.
- Do not weaken exact-price, savings, incentive, or unsupported-claim controls.
- Do not make a model change until deterministic application defects are fixed.
- Do not use a compatibility fallback for retired Typebot flow definitions.
- Back up the live Typebot flow before any database write.
- Production deployment requires all automated gates and a bounded smoke test.

## Non-Goals

- Replacing Typebot or Render.
- Adding a CRM, vector database, or conversation framework.
- Rebuilding notifications or chat-history persistence.
- Producing a statistically valid conversion-rate study from the current small
  sample.
- Making Jennifer pretend to be human.

## Behavioral Invariants

1. An explicit visitor question is answered before discovery or contact capture.
2. The current visitor turn is the primary intent signal. Older turns provide
   context but cannot permanently lock the intent.
3. Mixed price and off-grid language preserves both concerns; price questions
   are not converted into outage questions.
4. Jennifer never assumes an outage, quote, bill problem, ownership state, or
   other event the visitor did not state.
5. Post-processing may enforce safety and formatting, but may not replace the
   semantic answer or choose the next sales question.
6. A name is captured only from explicit self-identification or a plausible
   direct answer to an immediately preceding name question.
7. A call time is captured only from a recognized time expression after a
   timing question. Arbitrary short text is never a call time.
8. Any new question, correction, objection, hesitation, or identity question
   interrupts lead collection and receives a direct response. Collection can
   resume later.
9. Confirmation is one response, not a permanent terminal mode.
10. Exact assistant repetition is detected. The application must not recreate a
    duplicate or re-ask a normalized prior question after detecting it.
11. Jennifer identifies herself honestly as Affordable Solar's AI
    assistant when introduced or asked.
12. Contact collection starts only after explicit callback acceptance and stops
    when the visitor withdraws it.
13. The live Typebot rows are the flow authority. No hand-maintained full-flow
    SQL snapshot is kept as a deployment or rollback fallback.

## Implementation

### 1. Testability and Regression Suite

- Gate server startup behind `require.main === module`.
- Move the cleanup timer into startup so importing the module does not keep the
  test process alive.
- Export only the pure helpers required by tests.
- Convert the existing `jennifer-test-harness.js` from a print-only scenario
  runner into an offline suite using `node:test` and `node:assert/strict`.
- Do not add a second test file or any package.

Required tests:

- `cost + off grid` is not classified as a past outage.
- The July 18 two-turn state uses the visitor's latest stated reason and does
  not deterministically recreate the outage line.
- A useful raw answer survives post-processing semantically intact.
- `just curious`, `my fridge`, `solar panels`, and `maybe later` are not names.
- `my name is Josh` and `Josh` after an explicit name ask are names.
- `what about batteries?`, `hold on`, and `not sure yet` are not call times.
- `afternoons`, `after lunch`, and `3 pm` after a timing ask are call times.
- A side question interrupts name, phone, time, and confirmation stages.
- Callback withdrawal stops contact collection without discarding the chat.
- A question after completed contact capture is still answered normally.
- `are you a real person or AI` is an identity question, not a direct-call
  request.
- Exact repeated responses and normalized repeated questions are rejected.
- Reconstructed sessions derive repeat history from stored assistant turns.
- The detach/reset transcript does not jump from `Solar panels` to phone
  collection.
- Tests exit nonzero on failure.

### 2. Intent and Reason Handling

- Detect intent from the latest visitor turn first.
- Fall back through earlier visitor turns only when the latest turn has no
  recognizable intent.
- Separate off-grid/energy-independence intent from outage/battery intent.
- Give explicit cost language priority when the current message asks about
  cost, even when it also mentions off-grid equipment.
- Extract the visitor reason newest-first.
- Exclude questions, greetings, vague fillers, contact fields, utility-only
  answers, bill-only answers, and timing answers from reason extraction.
- Remove forced `next discovery question` and `lead heat` prompt injection.

### 3. Semantic Post-Processing

Delete deterministic semantic rewrites, including:

- generic electric-bill redirects for repeated responses;
- category-choice replacement;
- utility-to-motivation replacement;
- forced battery, quote, and hail follow-ups;
- `askedQuestions` whole-response tracking and its follow-up map.

Retain narrow output cleanup for:

- emoji and disallowed formatting;
- accidental reintroduction;
- unsupported address, scheduling-link, incentive, sizing, and hail claims;
- maximum response length and question count.

The cleanup layer must never invent a new premise or replace a useful answer
with a sales question.

Run repeat detection after cleanup. Compare the normalized final response and
its question clauses with prior assistant turns. If repeated, retry the model
once with a short corrective instruction. If the retry still repeats, return a
brief non-semantic recovery message rather than a topic-specific canned answer.

### 4. Lead Fields and Interruptions

- Delete the broad fourth name-extraction pass.
- Add explicit self-identification extraction.
- For direct name answers, require an immediately preceding name ask and reject
  questions and solar-domain phrases.
- Delete the arbitrary under-40-character time fallback.
- Recognize only explicit time-of-day phrases or clock times after a timing ask.
- Add a small pure interruption check for questions, corrections, hesitation,
  disinterest, and AI-identity messages.
- Require explicit callback acceptance before asking for or extracting contact
  fields. A withdrawal clears the callback request while preserving the chat.
- Use DISCOVER instructions for an interrupting turn without erasing captured
  lead fields. Resume the next missing field only on a later non-interrupting
  turn.
- Do not persist CONFIRM as a terminal stage after the confirmation response.

### 5. Prompt and Identity

Reduce the prompt to a short contract:

- Jennifer is Affordable Solar's AI assistant.
- Answer the current question first with one useful, grounded response.
- Ask at most one relevant follow-up only when it helps.
- Never invent a premise or repeat a question already answered.
- Acknowledge and repair misunderstandings directly.
- Let visitor questions interrupt qualification.
- Offer Eric only after usefulness and real interest are established.
- Keep existing factual and promise guardrails.

Remove mandatory lowercase, canned acknowledgments, adaptive opener scripts,
and the prohibition on a brief repair apology.

The canonical widget introduction becomes:

`Hi, I'm Jennifer, Affordable Solar's AI assistant. What are you trying to figure out about solar?`

### 6. Flow and Documentation Cutover

- Delete stale `rebuild-flow.sql` and `revert-flow.sql`; do not replace them
  with another hand-authored full-flow snapshot.
- Verify that the input-prefill repair is already present in both live rows,
  then delete `fix-prefill.sql` as a retired one-time migration.
- Update `render-setup-plan.md` with the answer-first contract, test command,
  live-flow invariants, and deployment/rollback gates.
- Before any write, export the exact current `PublicTypebot` and `Typebot` rows
  to timestamped files and record their hashes.
- Apply only an assertion-guarded transaction that changes the welcome text and
  canonical Render webhook URL. Assert that exactly the intended public and
  source row changed, then re-export and diff them.
- Do not retain the direct-Qwen or old branded-webhook definitions as fallbacks.

### 7. Observability and Latency

- Log structured decision metadata without adding new visitor content:
  session ID, current intent, active stage, whether cleanup changed output,
  exact-repeat detection, retry count, model latency, total request latency,
  and process uptime.
- Do not claim a close rate until the widget records an explicit close or an
  agreed abandonment event.
- Measure the isolated first-turn delay before changing the model or hosting.

## Acceptance Criteria

- `node --test jennifer-test-harness.js` passes and exits nonzero when a
  regression assertion is inverted.
- `node --check jennifer-proxy.js` passes.
- `node --check jennifer-test-harness.js` passes.
- The recovered July 18 input no longer produces or forces the outage question.
- No regression case misclassifies ordinary conversation as name or call time.
- AI identity questions receive an honest answer path.
- An explicit side question is answerable from every lead-collection stage.
- Prompt length and contradictions are materially reduced.
- No runnable tracked full-flow SQL definition remains.
- Local isolated smoke uses alerts/history disabled and does not write live data.
- Production health returns HTTP 200 after deployment.
- One labeled production QA conversation passes without repetition or premature
  contact capture.

## Verification Sequence

1. Run the new regression suite before implementation and confirm the targeted
   tests fail for the current defects.
2. Implement the smallest production changes that make them pass.
3. Run syntax checks and the full regression suite.
4. Start an isolated local proxy with history, lead summary, and new-chat alerts
   disabled; replay the July 18 and detach/reset conversations.
5. Review the diff for semantic rewrites, stale fallbacks, secrets, and unrelated
   changes.
6. Export and hash the exact live Typebot source and public rows.
7. Deploy the verified Render revision.
8. Verify health and one labeled QA chat.
9. Apply the canonical widget introduction only after the Render response path
   passes.
10. Preserve the prior commit and database backup as rollback points.

## Rollback

- Render: redeploy the previous known-good revision.
- Typebot: restore the timestamped `PublicTypebot` and `Typebot` JSON backup.
- Do not reintroduce the retired SQL files; rollback uses the exact saved live
  state, not a stale compatibility flow.

## Remaining Risk

- Model variability can still produce weak prose after deterministic rewrites
  are removed. The regression suite protects invariants, not exact wording.
- The recent genuine-visitor sample is too small for conversion conclusions.
- Render idle latency may remain after conversation logic is fixed.
- Exact close behavior remains unmeasured until widget telemetry is added.
- The retained knowledge block contains operational claims that need a separate
  business-owner verification pass; this repair does not expand those claims.
