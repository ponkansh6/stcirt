# Stcirt Five-Question Exam Specification

## Overview

Stcirt presents four multiple-choice questions and one free-response question in ID order. Participants join with a display name and the event's shared four-digit PIN; a signed HttpOnly cookie identifies them for subsequent answers. The exam UI and exam-time APIs do not disclose correctness, explanations, scores, rubric details, JEV responses, or assessment state. Legacy `questions` and `answer_logs` data remain intact and are not read or written by this application. There is no home UI; `/` redirects to `/answer`.

## Data Model

The Drizzle schema in `src/lib/db/schema.ts` contains the legacy tables and the exam-specific tables:

- `knowledge`: source text and title for stored learning material
- `questions`: one question per knowledge record, with choices and correct answer
- `answer_logs`: submitted choices, correctness, and answer time
- `exam_questions`: stable integer IDs and unique keys for the five seeded exam questions
- `exam_participants`: unique trim+NFC normalized name, display name, and creation time; no PIN data
- `exam_answer_logs`: submitted choices, correctness, answer time, and nullable participant reference; historical anonymous rows remain NULL
- `exam_answer_submissions`: participant-owned fixed five-question submissions and revision
- `exam_submission_answers`: current selected answers or free text; legacy fifth-question selections keep an explicit `legacy` kind and are never converted or regraded
- `exam_answer_assessments`: current fifth-question revision, durable retry state, raw/normalized scores, confidence, model, rubric version, attempts, and graded time
- `exam_submission_operations`: operation IDs and canonical payloads used for idempotent retries and mismatch rejection
- `participant_rate_limits`: shared database-backed failed-authentication windows keyed by HMAC fingerprints, without storing IP addresses or names
- `presentation_sessions`: singleton current presentation state, progression version, current zero-based question index, durable `projection_hidden` standby flag, and persistent `presentation_mode` (`full` or `short`, default `full`)
- `presentation_questions`: shared presentation and participant-results question/choice/correct-answer/explanation snapshot created by the first presentation start or result publication in `exam_questions.id ASC` order; a private-to-public result transition replaces its contents from the latest saved data
- `presentation_entries`: shared presentation and participant-results participant/display-name/floating-point score/standard-competition-rank and typed answer/assessment snapshot for every participant, including participants with no valid saved submission (score zero); a private-to-public result transition replaces its contents with the matching latest result snapshot
- `presentation_operations`: admin operation IDs, actions, and optional mode payload for idempotent retries and mismatch rejection
- `participant_result_settings`: singleton durable participant-results visibility (`visible`) and publication-history (`ever_published`) flags, independent of presentation stage and projection visibility. `ever_published` defaults to false, becomes true after successful publication, and remains true when results are hidden

Participant names are trimmed and normalized to Unicode NFC for case-sensitive uniqueness. They are not compatibility-normalized and internal whitespace is preserved. The shared event PIN and session signing secret are held only in server-side environment configuration.

Unconfirmed answers are held only in client state. Confirmed answer sets are persisted as participant-owned submissions and can be revised in place. The existing single-answer API continues to write `exam_answer_logs` without returning grading data; batch submissions do not append to that table. A new migration updates question 5 and marks existing fifth-question rows as legacy without guessed conversion. Migration 0011 resets the assessment dataset by deleting prior answer logs and submissions and deleting the current presentation session (which cascades to its question and participant snapshots); it also returns participant-result publication to private. It retains `presentation_operations` so delayed retries of prior administrative operations remain idempotently rejected. Migration 0012 adds `participant_result_settings.ever_published` and backfills every existing visibility-settings row to true. The UI writes a false row only when hiding results after publication; an exceptional direct/API false write before publication cannot be distinguished from that normal history, so it is conservatively treated as previously published. Earlier migrations are immutable. `/` redirects to `/answer`; no home briefing or home navigation is part of the participant experience.

## Requirements

### R1: Fixed five-question set

**WHEN** an unauthenticated user opens `/answer`, or an authenticated participant has no saved submission
**THEN** the client checks the participant session and latest submission before fetching five questions in order through the existing next-question API.

- The first request has no cursor; each following request uses the prior question ID.
- Order is `exam_questions.id ASC`.
- The client creates a new submission ID and starts fetching questions only after latest-submission lookup returns `{ submission: null }`.
- The question screen appears only after all five questions have been loaded.
- A 404 before five questions are loaded means the exam cannot start and is shown as a shortage, not a network error.
- A network/API failure is retryable. Questions already loaded remain held, and retry fetches only the missing suffix.
- A remount or reload first checks the participant's latest submission. A saved submission opens completion; no saved submission starts a fresh attempt.
- A latest-submission request failure is shown with a retry action and is never treated as an empty submission.
- If fewer than five questions exist, `/answer` shows an explanation.

### R2: Participant-authenticated answer confirmation and recording

**WHEN** a user chooses options for the five questions and confirms the set
**THEN** `POST /api/answers/batch` atomically saves the five answers for one stable submission.

- The user first joins with a display name and event-wide four-ASCII-digit PIN. A valid existing participant session may be reused without re-entry.
- Every answer POST requires a valid signed participant cookie and same-origin `Origin`; anonymous POSTs are rejected. The legacy single-answer endpoint keeps its logging behavior but returns only `{ recorded: true }`, never grading details.
- The participant ID comes only from the validated cookie. A client-supplied `participantId` is rejected.
- A batch submission is associated with the validated participant. Historical single-answer rows remain unchanged with a NULL participant ID.

- Individual choices remain in client state until explicit batch confirmation; they do not create server records.
- Choices are native radio inputs grouped by question with a fieldset and legend; show each question prompt visually only in its heading and visually hide the duplicate legend while retaining it as the radio group's accessible name. Each input has an explicit full-row label, and its submitted value remains the existing shuffled-choice index.
- A pending batch request locks all answer controls and prevents duplicate submission.
- While pending, the selected radios remain checked and the confirmation action keeps its name and focus; its disabled state is communicated to assistive technology and guarded synchronously.
- The five selected choices remain available after a failed request so the user can retry.
- Questions 1–4 accept selected indices; question 5 accepts only trimmed non-empty free text up to 1000 characters. The server validates each variant against the stored question key.
- Saving free text creates a durable pending assessment for that same submission revision in the answer transaction. After the save commits, the batch route uses Next.js `after()` to start only that submission revision's job through the atomic-claim worker, processing at most one job without delaying the response. If `TYPESAFE_API_KEY` is absent or post-response scheduling/worker startup fails, the durable job remains available for the manual retry endpoint; safe fixed-reason logs contain no key or exception details. Assessment state and results are not returned by the exam API.
- A successful batch confirmation moves to completion. The completion view can restore the saved five answers and revise the same submission.
- An authenticated revisit or reload with a saved submission remains on completion. Its correction action restores saved selected indices to the shuffled choices and restores free text.
- If the saved submission is incomplete, malformed, or does not match the current questions, completion remains visible and correction is unavailable; no new submission is started and no old answer is overwritten.
- The UI does not use the response's correctness, correct index, or explanation fields. It shows no per-exam correctness, explanation, score, accuracy, or pass/fail state.
- Retrying a batch after a transport failure reuses the operation ID and exact payload, so a committed request is returned idempotently without duplicating writes.

### R3: Completion

**WHEN** the batch answer POST succeeds, or the latest-submission lookup finds an existing submission
**THEN** show `回答完了` and offer `回答を修正する` only when the saved set can be safely restored.

- Completion has no score, correctness, explanation, or pass/fail result.
- The saved submission revision is updated in place when corrections are confirmed.
- Saved answers must match the current five-question ID set and answer types, with valid selected-choice indices or non-empty free text, before correction is enabled. If restoration fails, keep the completion screen and disable correction.
- A known legacy choice-shaped answer for the current fifth free-response question is a supported historical format, not a malformed current answer. Preserve it as legacy without converting or regrading its value, and allow completion and correction.
- When correcting a submission with that legacy fifth answer, treat the fifth question as unanswered and require a new non-empty free-text response of at most 1000 characters. Submit only the new free text; never resend the legacy selected value.
- A successful answer POST must return the requested submission ID. If the response identifies another submission, keep completion visible and disable correction.

### R4: Home and participant entry

**WHEN** the user visits `/`
**THEN** redirect to `/answer` without rendering home content or loading statistics.

- `/` remains a compatibility entry point only. Do not show a home briefing, statistics, or a link back to `/` in participant, administration, or presentation screens.
- The answer entry flow accepts a name and the organizer-provided shared four-digit PIN in one form. After authentication, the client checks latest submission and proceeds directly to quiz or completion without an intermediate ready screen.

### R5: Accessible responsive interface

- Use a restrained exam-paper visual style with light surfaces, ink text, subtle borders, and a primary accent; do not use medals, pass/fail imagery, or certificate visuals.
- Always use the light color palette regardless of the operating system's color-scheme preference.
- Provide readable contrast, visible keyboard focus, native radio semantics, live status updates, and textual progress labels so color is not the sole signal. Choice rows and the primary confirmation action have at least 44 CSS px of interaction height.
- Keep content in a single readable column on narrow screens, avoid horizontal scrolling at 320 CSS px and 200% zoom, and respect reduced-motion preferences.
- During the active answering session, show one five-question navigation in the shared sticky header. Keep its sizing and spacing, show answered state, retain answers while navigating, and move focus to each question heading below the sticky header. Do not show home navigation in any answer state.
- Show each question prompt only once visually in its heading; keep the duplicate fieldset legend visually hidden and available to assistive technology as the radio group's accessible name. Do not show per-question helper paragraphs below the radio choices or reference them with `aria-describedby`; retain native radio group semantics, overall unanswered guidance, and answer progress.
- In-page links to unanswered questions move focus to a visible question heading without it being hidden behind page chrome. Do not add exam-time correctness, explanation, score, accuracy, or pass/fail information.

### R6: Isolated administrator authentication

- Admin sign-in uses `ADMIN_PRESENTATION_PIN` and `ADMIN_PRESENTATION_SESSION_SECRET`; if either is missing or invalid, admin sign-in and protected admin endpoints fail closed.
- The admin session is a signed HttpOnly cookie with a purpose-specific HMAC key, separate cookie name and secret from the participant session. Participant cookies never grant admin access.
- `POST` and `DELETE` admin session operations and every admin state mutation require a same-origin `Origin`. Every admin presentation route requires a valid admin cookie. Admin and public presentation API responses use `Cache-Control: no-store`.
- `/admin/presentation` is the PIN entry point. Successful authentication opens `/presentation?presenter=1` in the same tab; the presentation screen verifies `/api/admin/session` and only renders its controls while that endpoint confirms an authenticated signed admin cookie. The query parameter requests the presenter interface and never grants authorization.
- A 401 from a protected admin operation immediately removes presenter controls and returns the screen to spectator behavior. Private admin responses are reduced to the minimum control metadata in client state; they are never used to render slides or written to browser storage.

### R7: Presentation snapshot and ranking

- Only one current presentation session is stored. The first presentation start or first participant-results publication snapshots all `exam_questions` in `id ASC` order, all `exam_participants`, and each participant's latest valid complete saved submission against that question set in one database transaction. First publication reuses an existing snapshot created by presentation start; otherwise it creates the snapshot and changes visibility atomically. A failed snapshot or publication leaves results private. Later presentation starts reuse the existing snapshot. After a successful publication, hiding results retains the `ever_published` marker; each later hidden-to-visible transition rebuilds the shared question and participant snapshots from current saved data in the same transaction that makes results visible. A repeated request while already public is idempotent and does not rebuild them.
- If a rebuilt snapshot has no questions while the current presentation state is `question` or `answer`, the same transaction moves the state to `podium_preview` and resets `questionIndex` to zero so the presenter cannot point at a missing question. This is the only republish exception to preserving the stage and cursor; the presentation version remains unchanged.
- Questions 1–4 award one point for a correct selection. Question 5 awards `JEV score / 2` points (0–1), with no correctness threshold; confidence is ignored. Stored scores and rank comparisons retain floating-point precision, and display rounds only to two decimals. Legacy question-5 selections contribute no question-5 point and are labeled legacy without regrading. Unanswered or invalid/incomplete submissions score zero. Every participant is included. Ties use exact score equality and standard competition ranking (1, 1, 3).
- Whenever a snapshot is created or rebuilt from current submissions, creation fails atomically while any latest free-text assessment is absent, pending, failed, or stale for its answer revision.
- The presentation labels the existing correct-answer count as `ポイント` in the projection and authenticated admin list/preview; this is display wording only and does not change scoring.
- In the public projection and authenticated admin preview, each winner presents rank first, then points, then name. Rank and points have stronger visual size and hierarchy than the name, while each card keeps its score paired with the correct participant. All participants tied at the announced rank appear together.
- The score, rank, participant display name, selected-answer snapshot, question text, choices, correct answer, and explanation stay fixed until a later republish after a successful publication rebuilds the shared snapshot. Later answer revisions and question edits do not change the announcement before that republish.
- State progression is manual: each question advances `question` then `answer`; after the last answer, `podium_preview` announces no winners; ranks with no winners are skipped while announcing rank 3, then 2, then 1; the process ends at `finished`.
- An `operationId` retry for the same action is idempotent. Reusing it for a different action, or advancing from an invalid state, returns 409. Version-checked updates reject concurrent state changes.
- `advance` moves one stage forward. `previous` moves the persistent stage cursor back one stage without changing any snapshotted question, answer, score, or rank. From `finished`, it returns to the last existing announced rank in the 3rd → 2nd → 1st sequence, or `podium_preview` if there were no winners. `previous` at the initial state returns 409.
- Admin actions `hide` and `show` durably set `projectionHidden`; this can be set before `start`. While hidden, the public API returns only `{ state: 'standby' }`. Showing restores the current projection stage without changing it.
- Presentation mode defaults to `full` and persists in SQLite. `setMode` can select `full` or `short` before or after start without moving the current stage. A retried operation ID with a different mode returns 409.
- `short` changes only the disclosed answer-screen content: the question and answer stages remain separate manual stages; ranking stages remain manual in 3rd → 2nd → 1st order. Hiding the projection and moving backward work in both modes; score/rank snapshots remain fixed until refreshed by republishing after results have previously been published.
- A brief, silent rank entrance motion plays when an authenticated presenter's forward operation enters a rank state. Poll updates, initial loads, reloads, and same-state responses do not play it. Returning to a rank with the previous-stage operation is immediate; advancing into it again plays the motion again. It settles within 1.2 seconds, never advances the presentation, and is disabled under `prefers-reduced-motion` without leaving a timer. No session marker or public API announcement ID is used.
- Presentation progression remains manual and uses the existing authenticated admin API actions and operation IDs. The presenter screen exposes only the start button before the presentation and the participant-results publication button after `finished`; it has no persistent operation footer, hide/show controls, full/short controls, or fullscreen toggle. Mutations remain single-flight; success re-fetches public projection, and 401/409 recovery synchronizes projection without automatically retrying a mutation. Existing admin API contracts and authorization checks are unchanged.
- Stage progression is available to a confirmed presenter through slide-surface click, Space, Enter, ArrowRight, and ArrowLeft for previous. Controls are enabled only while both `presenter=1` and a valid admin session are confirmed. Repeated keys, modified keys, and interactive, input, editable, or dialog targets do not trigger progression; button activation is handled natively without a duplicate operation. Public spectators have no controls and cannot progress the presentation.
- The viewport projection uses the full viewport without reserving footer height or causing page scroll. The 16:9 slide canvas and safe area remain within that viewport. Starting from the presenter start button requests browser fullscreen synchronously inside that user gesture before the start API request. Unsupported or rejected fullscreen, and exiting fullscreen with Escape, leave the viewport projection and manual progression usable; polling, idle time, reload, and results publication never request fullscreen.

### R8: Staged result disclosure

- The admin projection includes the complete current question and ranking snapshot at every state plus `projectionHidden: boolean`. It is available only through authenticated admin APIs. Its snapshot changes on initial creation or republishing after results have previously been published.
- The public projection contains no score, rank, result, correct answer, or explanation before the appropriate state. A `question` state includes only that question and its choices. Multiple-choice answer stages include the correct answer and index. The answer stage for the source question whose current `exam_questions.key` is exactly `it-literacy-005` includes its model answer and omits the optional `responses` property; it never includes participant names, answers, raw similarity, or normalized point contribution. Its answer-stage timing and snapshot-based scoring, ranks, and participant results are unchanged. Other free-text questions keep their response data. The projection resolves question identity through `sourceQuestionId`; it does not infer the fifth question from position or answer type. If the source row is missing, it also omits `responses` as a fail-closed fallback because the projection cannot establish question identity. A changed key that still has a source row is matched by its current key; snapshots do not retain historical keys, so a rename or reused source ID cannot be identified as a former fifth question. Legacy selections are explicitly labeled and not regraded. Confidence, rubric, raw JEV response, and assessment lifecycle state are never public.
- In the P0 answer screen, show the existing explanation text as stored, limited to at most four visible lines in `full` mode; the authenticated admin screen keeps the full explanation available. In `short` mode, the answer projection includes `correctAnswer`, `correctIndex`, and `choices`, and omits the `explanation` property entirely. Separate approved projection summaries and host notes are P1 and are not required for P0.
- `podium_preview` includes no winner names or scores. A `third`, `second`, or `first` state includes only the display name, score, and rank of everyone tied at that announced rank. Other states include no winners.
- At each rank state, the projection displays rank, `ポイント`, then name, with rank and points visually larger than the name. Brief entrance motion plays only for a presenter forward operation entering a rank state, as defined in R7.
- The projection fills the viewport (`100vw` × `100dvh`, with a `100vh` fallback) without a footer reservation or page scrolling. The slide keeps its 16:9 canvas and safe area inside that space; long names and tied winners remain paired with their rank and score. The page itself does not scroll to accommodate content.
- Slide content is rendered only from `GET /api/presentation`. Fullscreen is requested from the explicit presenter start gesture before the start API request. Browser refusal, lack of support, or Escape exit does not interrupt the viewport projection or manual progression. There is no persistent presenter footer or manual fullscreen toggle.
- Existing participant session, answer, and batch APIs do not return presentation ranking or answer keys.

### R9: Participant result visibility

- Participant result visibility is stored independently from `presentation_sessions.projection_hidden`, presentation mode, stage, and operation version. It defaults to false. The participant-results view shares the `presentation_questions` and `presentation_entries` snapshot with the presentation.
- An administrator can hide results at any time. First publication reuses a snapshot already created by presentation start, or creates one if none exists, and makes results visible atomically. After a successful publication, hiding retains `ever_published`; each later hidden-to-visible transition rebuilds the shared question, answer, score, and rank snapshot from current saved data and makes results visible in the same database transaction. This also updates the announcement data shown by the presentation while preserving its stage and question cursor, except that a rebuilt empty question snapshot moves a `question` or `answer` stage to `podium_preview` and resets its cursor to zero. A preparation or publication failure leaves results private. A repeated publish request while already public and later presentation starts reuse the existing snapshot. Visibility operations do not change projection visibility, presentation mode, or presentation operation version. A hide operation does not rebuild the snapshot.
- While results are private, `/results` displays exactly `回答中`; its API returns only `{ state: 'waiting' }`, with no score, rank, answer text, participant name, or other participant data.
- Published results expose only the authenticated participant's own `rank`, `score`, and per-question answer details, selected from the current shared `presentation_entries` and `presentation_questions` snapshots using the ID in the signed participant cookie. Client-provided participant IDs are ignored; no overall ranking or other participant data is returned. Selected answers include the chosen label and `correct`/`incorrect`/`unavailable` correctness, never the correct choice. Free-text answers include the saved response and its normalized score (0..1), without a binary correctness label. Legacy and unanswered answers remain distinct.
- `/answer` keeps the existing completion text and correction CTA. It adds a results CTA linking to `/results` only while that participant's result API reports a published result. The client checks once when completion becomes ready, then checks again when the tab becomes visible.
- The dynamic Server Component for `/results` checks the participant cookie, participant record, and current publication state before rendering. It passes only an unauthenticated/neutral state or that participant's own rank, score, and answer details to a narrow client panel. The panel initially uses this server-provided state and refreshes the no-store API when the tab becomes visible; when a successful refresh observes that results have become private, it removes all published details and displays `回答中`.
- Hiding results removes the published view; republishing exposes the newly rebuilt rank, score, and question-level answer details after reloading the page or returning to its tab. No short-interval refresh is guaranteed.
- Missing or invalid participant sessions return 401. A valid participant with no snapshot entry receives an unavailable state; the application does not invent a zero score or return another participant's result.
- Participant result responses and the result page's data access use `no-store`. Publication changes do not alter projection hiding, mode, or operation version. First publication reuses the snapshot created at presentation start when one exists; a later republish after hiding updates the shared snapshot used by `/api/presentation` and participant results, as described above. If that refresh removes every question while the presentation is in `question` or `answer`, the state moves to `podium_preview` and the cursor resets to zero; otherwise the stage and cursor stay unchanged.

## API

### `GET /api/questions/next`

- Optional query parameter: `afterId`, a positive integer question ID.
- Without `afterId`, returns the lowest dedicated exam question ID.
- With `afterId`, returns the lowest dedicated exam question ID greater than the cursor.
- Response 200: `{ id, question, choices, answerType }`; `answerType` is `selected` for questions 1–4 and `freeText` for question 5.
- Response 400: invalid cursor
- Response 404: no next question

### `POST /api/answers`

- Request: `{ questionId: number, selectedIndex: number }`
- Requires same-origin `Origin` and a valid signed participant cookie whose participant still exists.
- Rejects anonymous calls and any body containing `participantId`; associates the answer with the cookie's participant.
- Response 200: `{ recorded: true }`; grading details are not returned.
- Response 400/401/403/404: invalid selection, missing/invalid participant session, origin failure, or missing question

### `/api/answers/batch`

`POST` creates or revises a five-answer submission; `GET` restores a confirmed submission.

#### `POST`

- Request: `{ submissionId: UUID, operationId: UUID, expectedRevision: integer, answers: [{ questionId, selectedIndex } | { questionId, freeText }] }`
- `answers` must contain exactly five distinct questions in the current fixed exam set for initial submission; revisions must use the same saved question set.
- A correction of a historical choice-shaped fifth answer must replace that value with a valid new `freeText` answer; the legacy selected value is never accepted or resent as the fifth answer.
- Requires same-origin `Origin` and a valid signed participant cookie whose participant still exists. Participant identity is taken only from that cookie.
- Answer APIs currently have no rate limit; failed sign-in attempts are rate-limited only on `POST /api/participants/session`. The batch route keeps the existing single-answer API's rate-limit behavior unchanged.
- `expectedRevision` is `0` for initial save and the current saved revision for a correction. A successful write advances the revision by one.
- Initial creation and correction are each one transaction. Corrections update the same submission answer rows and do not append to `exam_answer_logs`.
- `operationId` is unique per deliberate save. Repeating it with the same submission ID and canonical payload returns the original revision; reusing it with a different payload is rejected. Revision mismatches return 409.
- After a newly committed free-text answer, assessment starts asynchronously after the response and is scoped to the saved `submissionId` and revision. An idempotent operation replay does not start another assessment. Missing JEV configuration leaves the durable pending assessment for the retry worker.
- Response 200: `{ submissionId, revision }`; no correctness, correct index, explanation, score, or pass/fail data is returned.
- Response 400/401/403/404/409: invalid request/question set, missing participant, origin failure, missing submission, or operation/revision conflict.
- If a save conflicts because its `expectedRevision` is stale, the client can use GET to reload the saved revision while retaining its local draft. Apply that draft only when the GET returns the same submission ID and a complete, valid answer set; otherwise remain on completion with correction disabled.

### `GET /api/answers/latest`

- Requires a valid signed participant cookie whose participant still exists. The participant ID is never accepted from the client.
- All responses are `Cache-Control: private, no-store` because the payload contains saved participant answers.
- Returns `{ submission: null }` when the participant has no saved submission.
- Returns the participant's latest submission using `updatedAt DESC, revision DESC, createdAt DESC, id DESC`; the payload uses the same answer shape as `GET /api/answers/batch`.
- Returns 401 for a missing or invalid participant session. Database and API failures remain errors and must not be converted to an empty submission.

#### `GET /api/answers/batch?submissionId={UUID}`

- Requires a valid signed participant cookie. A submission is visible only to its owning participant; missing and other-participant submissions both return 404.
- Response 200: `{ submissionId, revision, answers: [{ questionId, answerKind, selectedIndex, freeText }] }`. Legacy answers have `answerKind: legacy`; no grading fields are returned.
- A legacy fifth answer is identified as its known historical choice-shaped form. It remains unconverted and ungraded during restore; correction requires a newly entered free-text answer.
- Used to restore confirmed answers or reload the saved revision after a conflict while preserving the local draft.
- Response 400/401/404: invalid submission ID, missing participant session, or unavailable submission.

### `POST /api/internal/jev/retry`

- Requires `Authorization: Bearer <JEV_RETRY_SECRET>`; accepts no answer text from callers.
- Processes up to five due durable assessment jobs with a 45-second lease and compare-and-set claim. Transient failures use bounded exponential backoff. A privileged call with `?retryFailed=1` requeues terminal failures.
- Response contains aggregate processed, graded, retried, and failed counts only. Configure an external scheduler to call periodically; there is no scheduler configuration in this repository.
- JEV uses `TYPESAFE_API_KEY`, optional `TYPESAFE_MODEL` (default `jev-latest`), and optional `TYPESAFE_BASE_URL`. Responses are strictly checked; scores must be finite and within 0–2. The point contribution is raw score divided by two, and confidence is ignored.

### `/api/participants/session`

- `POST` request: `{ name: string, pin: string }`; PIN must be four ASCII digits, including leading zeroes. The configured `PARTICIPANT_PIN` is validated the same way and compared in constant time.
- On success, reuses or creates the case-sensitive trim+NFC participant and returns `{ participant: { id, name }, expiresAt }` with a signed HttpOnly, SameSite=Lax cookie (`Path=/`, Secure in production; default lifetime 30 days).
- Failed authentication is rate-limited in the shared database to 5 attempts per normalized name per 15 minutes by default, shared across all request sources. `PARTICIPANT_RATE_LIMIT_NAME` configures this limit. Failure records contain HMAC fingerprints only and expired records are opportunistically deleted after 24 hours.
- `GET` returns `{ participant: { id, name } | null }` after cookie signature, expiry, and database checks.
- `DELETE` clears the cookie. Both mutating methods require a same-origin `Origin` header.
- PIN, session secret, or shared database configuration failures fail closed. PINs and secrets are never returned.

### `/api/admin/session`

- `GET` returns `{ authenticated: boolean }` and is always `no-store`.
- `POST` requires same-origin `Origin` and `{ pin }`; on success, it sets the separate signed HttpOnly admin cookie and returns `{ authenticated: true }`. Missing admin environment configuration fails closed with 503; invalid PIN returns 401.
- `DELETE` requires same-origin `Origin`, clears only the admin cookie, and returns `{ authenticated: false }`.

### `/api/admin/presentation`

- `GET` requires a valid admin cookie and returns the complete current snapshot: `{ state, version, questionIndex, questionCount, projectionHidden, presentationMode, questions: [{ id, question, choices, correctIndex, correctAnswer, explanation, answerType }], entries: [{ displayName, score, rank, answers: [{ questionId, answerKind, selectedIndex, freeText, rawScore, normalizedScore }] }] }`. `answerKind` is `unanswered` for missing answers; legacy answers remain distinct.
- `POST` requires admin cookie, same-origin `Origin`, and `{ operationId, action: 'start' | 'advance' | 'previous' | 'hide' | 'show' }` or `{ operationId, action: 'setMode', mode: 'full' | 'short' }`. It returns the current complete admin projection. Replayed operations do not progress state again; ID/action/payload conflicts and state/version conflicts return 409.
- Both methods are `no-store`; unauthenticated access returns 401.

The presenter screen may consume only the minimal state, cursor, hidden flag, and presentation mode needed by its controls from these existing responses. It does not add an API or alter these response contracts.

### `GET /api/presentation`

- Returns the server's current public projection and is `no-store`; the DTO shape is unchanged.
- In `question` / `answer`, response is `{ state, question: ... }`. `ordinal` is one-based. The `question` state omits all answer keys and explanation. Multiple-choice answer states include `correctAnswer` and `correctIndex`; an answer stage whose source question key is exactly `it-literacy-005` includes `expectedAnswer` and omits the optional `responses` property. Other free-text answer stages include `expectedAnswer` and participant responses with raw similarity and normalized point contribution. The repository looks up source question keys in one batch using snapshot `sourceQuestionId` values. If a source row is missing, `responses` is omitted; if its current key differs from `it-literacy-005`, responses are retained. Identity is never inferred from position or `freeText` type. Because snapshots do not store the historical key, a source-key rename or source-ID reuse cannot be recognized as a former fifth question. Confidence, rubric, raw JEV response, and assessment state are omitted.
- In a rank announcement, response is `{ state, winners: [{ displayName, score, rank }] }`, containing every tied participant for only the announced rank. `podium_preview` has no `winners` property. Other states return only `{ state }`.
- When the durable projection standby flag is on, the sole response is `{ state: 'standby' }`, independent of the private presentation stage.

### `/api/admin/participant-results`

- `POST` requires a valid admin cookie, same-origin `Origin`, and `{ visible: boolean }`.
- Response 200: `{ visible: boolean }`; responses are `Cache-Control: private, no-store`.
- Results can be hidden regardless of presentation session existence or state. First publication reuses a presentation snapshot already created by start or creates it from current saved answers when none exists, then makes it visible atomically; snapshot preparation failure leaves visibility private. Initial publication with no questions fails as results not ready. Starting a presentation with no questions still creates an empty snapshot and enters `podium_preview`; first publication reuses that empty snapshot. After publication, the persisted `ever_published` marker remains true when hidden, so each later hidden-to-visible transition replaces the shared question and participant snapshots atomically; an already-public request does not. Migration 0012 backfills every existing settings row as previously published. This treats an exceptional direct/API false write before initial publication as a republish because its history is indistinguishable from the normal hide-after-publish path. Published results are available only to participants with a valid snapshot entry; participants without a snapshot entry or with a malformed snapshot receive `{ state: 'unavailable' }`.
- Visibility operations do not mutate projection visibility, mode, or presentation version. Each republish after hiding recalculates scores and rankings from current saved answers; stage and question cursor stay unchanged except that a republished snapshot with no questions moves a `question` or `answer` stage to `podium_preview` and resets `questionIndex` to zero. Hiding and repeated already-public requests do not rebuild the snapshot.

### `GET /api/participants/results`

- Requires a valid signed participant cookie whose participant still exists; identity comes only from that cookie.
- Response 200 while private: `{ state: 'waiting' }`. Response 200 when published and the participant has a valid snapshot entry: `{ state: 'visible', rank, score, questions }`, where each question is `{ position, question, answer }` and `answer` is `{ kind: 'selected', value, correctness: 'correct' | 'incorrect' | 'unavailable' }`, `{ kind: 'freeText', value, score: number | null }`, `{ kind: 'unanswered' }`, or `{ kind: 'legacy' }`. Data comes only from the authenticated participant's current shared presentation question and entry snapshots; current question data is not consulted outside the snapshot. A participant without a snapshot entry or with a malformed snapshot receives `{ state: 'unavailable' }` (or the existing unavailable server error). No correct choice, raw answers JSON, raw score, JEV data, internal assessment data, names, or other participants' information is returned. First publication uses the first-start snapshot when one exists; each later publication after hiding atomically refreshes it. Migration 0012's `ever_published` marker backfills all existing visibility-settings rows true; an exceptional prior false write before initial publication is therefore treated as a republish.
- Invalid or missing sessions return 401. All responses are `Cache-Control: private, no-store`.

## Components

- `/`: server-side redirect to `/answer`
- `/answer`: participant entry/session reuse, latest-submission check, client-held five-question session, four native radio choice groups and one free-response textarea, legacy fifth-answer guidance and replacement during correction, sticky-header question navigation while answering, atomic batch confirmation, same-submission correction, and neutral persistent completion
- `src/app/GlobalHeader.tsx` and `src/app/answer/header-portal.tsx`: shared sticky header and answer-route navigation slot, with RootLayout remaining a Server Component
- `src/components/ChoiceButton.tsx`: labeled native radio row with circular choice mark and selected-state styling
- `src/lib/db/repository/question-repository.ts`: next-question lookup by ID cursor and answer lookup from `exam_questions`
- `src/app/api/answers/batch/route.ts` and `/api/answers/latest`: authenticated atomic five-answer create/correction endpoint and participant-scoped latest-submission lookup
- `src/lib/db/repository/answer-repository.ts`: preserves legacy single-answer logging and provides atomic submission persistence, owner-scoped restore, deterministic latest-submission selection, revision checks, and idempotent operation replay
- `src/lib/jev/adapter.ts` and `/api/internal/jev/retry`: strict JEV score adapter and secret-protected durable retry worker
- `src/lib/presentation/admin-auth.ts`: separate admin PIN verification, HMAC session cookie, and origin-checked authorization
- `src/lib/db/repository/presentation-repository.ts`: shared answer/question snapshot, scoring, standard competition ranks, state machine, operation idempotency, and source-key-filtered public projection
- `/api/admin/session`, `/api/admin/presentation`, `/api/presentation`: isolated sign-in, private conductor API, and staged public projection
- `/admin/presentation`: same-tab PIN authentication entry for presenter mode
- `/presentation`: spectator projection screen by default; `?presenter=1` requests a signed-session-gated presenter interface and fullscreen wrapper
- `/results`: dynamic Server Component that checks session and publication state before rendering; a narrow client panel refreshes on tab visibility and exposes only the authenticated participant's own rank, score, and question-level answer/correctness details
- `/api/admin/participant-results`, `/api/participants/results`: authenticated admin visibility control and participant-scoped result API

## Coverage tiers

`scripts/check-coverage-tiers.mjs` validates these statement coverage targets:

- Tier 1: core logic (`shuffle`, `choice-label`, JST date helpers), 90%
- Tier 2: API routes, 80%
- Tier 2b: API client and utilities, 85%
- Tier 3: repositories, 75%
- Tier 4: answer UI state management, 90% statements and 75% branches
- Tier 5: shared UI components, 70%

`pnpm test:coverage` produces the Vitest coverage report under `coverage/`. Statements, branches, functions, and lines must each reach 100% globally and for every instrumented file; Vitest enforces this threshold with per-file checking and automatic threshold updates disabled. CI and the pre-push hook run the suite once, then validate both these thresholds, the existing tier targets, and report completeness with `scripts/check-coverage-completeness.mjs` using that same report. The completeness check reconciles instrumented source files with the coverage report and rejects missing reports, missing source entries, or executable source files with no coverage data; intentionally non-executable files are excluded. CI uploads the report as the `coverage` artifact.

## Testing

Vitest covers core logic, API/client behavior, the sequential question repository, answer session state, shared components, and statistics repositories. Playwright covers the home, answer, and answer submission flows.

## Environment

JEV grading uses server-only `TYPESAFE_API_KEY`, optional `TYPESAFE_MODEL` (default `jev-latest`), and optional `TYPESAFE_BASE_URL`. Newly saved free-text answers trigger one asynchronous assessment attempt after the answer response. The durable retry worker requires `JEV_RETRY_SECRET`; configure an external deployment scheduler to call `POST /api/internal/jev/retry` periodically for pending jobs, including jobs left pending when JEV configuration or post-response execution is unavailable. The repository has no scheduler configuration. An authenticated `?retryFailed=1` call requeues terminal failures.

Runtime configuration requires `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `PARTICIPANT_PIN`, and `PARTICIPANT_SESSION_SECRET` for participant authentication. `PARTICIPANT_PIN` is exactly four ASCII digits, including possible leading zeroes. The secret must have at least 32 bytes. The cookie payload is `{ id, exp }`; its HMAC-SHA256 signing key is derived as `HMAC-SHA256(PARTICIPANT_SESSION_SECRET, "stcirt-participant-session-v1" + NUL + PARTICIPANT_PIN)`. The `stcirt-participant-session-v1` purpose label and NUL delimiter are fixed. PIN or secret changes invalidate existing cookies. Rate-limit HMAC key derivation uses a separate fixed purpose label and does not include the PIN, so PIN rotation does not reset rate limits. Old cookies are rejected and participants must sign in again. `PARTICIPANT_PIN_HASH`, `PARTICIPANT_PIN_PEPPER`, and `PARTICIPANT_EVENT_VERSION` are retired.

Admin presentation authentication separately requires `ADMIN_PRESENTATION_PIN` and `ADMIN_PRESENTATION_SESSION_SECRET`; the PIN must be nonempty and at most 128 characters, and the secret must have at least 32 bytes. Missing configuration fails closed. The admin cookie is `stcirt_admin_presentation`, HttpOnly, SameSite=Strict, Secure in production, and expires after eight hours. Its HMAC-SHA256 key is derived from the admin secret and fixed `stcirt-admin-presentation-session-v1` purpose label. Admin secrets/cookies are not shared with participant authentication.

Use `pnpm participant-auth generate` to create the participant pair in `.env.local`. It prompts twice for a user-selected four-digit ASCII PIN using hidden terminal input, preserving leading zeroes, and generates the session secret automatically. Non-interactive runs fail. It preserves other settings, refuses to overwrite either selected profile key, and writes atomically with mode 0600. Use `--rotate` only for intentional replacement. The default profile is `participant`; use `--profile admin` to create the separate `ADMIN_PRESENTATION_PIN` and `ADMIN_PRESENTATION_SESSION_SECRET` pair. Admin PIN input is hidden and accepts 1–128 characters; its session secret is generated automatically from 32 random bytes and encoded as base64url.

To also sync the newly saved pair to Production in the same command, link the repository to the intended Vercel project, authenticate with Vercel CLI, and run `pnpm participant-auth generate --sync-production` (or add `--profile admin` for admin credentials). This sync does not start a deployment; start a new deployment separately for the changes to take effect. If sync fails, `.env.local` retains the generated pair and the command exits nonzero with instructions to rerun the matching profile's `pnpm participant-auth sync --target production` command. Alternatively, sync a saved pair with `pnpm participant-auth sync --target production` or `--target preview`, adding `--profile admin` when syncing admin values. Sync requires Vercel CLI authentication, upserts only the selected profile's two values through stdin using `--force --sensitive`, never deploys, and exits nonzero if either upsert fails. Preview applies to all branches; inspect branch-specific overrides in Vercel separately. Development is excluded because Vercel sensitive variables are supported only for Production and Preview. The Vercel CLI dependency is pinned to version `58.4.4`.

Optional `PARTICIPANT_SESSION_DAYS` accepts 1–90 (default 30); `PARTICIPANT_RATE_LIMIT_NAME` defaults to 5 failed attempts per normalized name per 15 minutes. Question generation and question-management endpoints are not part of the application.
