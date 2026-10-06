# Stcirt Five-Question Exam Specification

## Overview

Stcirt presents a dedicated set of five Japanese IT-literacy questions in ID order as a fixed-length, exam-style answering session. Participants join with a display name and the event's shared four-digit PIN; a signed HttpOnly cookie identifies them for subsequent answers. The UI records each submitted choice but does not present correctness, explanations, scores, accuracy, or pass/fail results within an exam session. Legacy `questions` and `answer_logs` data remain intact and are not read or written by this application. The home page does not show answer history statistics.

## Data Model

The Drizzle schema in `src/lib/db/schema.ts` contains the legacy tables and the exam-specific tables:

- `knowledge`: source text and title for stored learning material
- `questions`: one question per knowledge record, with choices and correct answer
- `answer_logs`: submitted choices, correctness, and answer time
- `exam_questions`: stable integer IDs and unique keys for the five seeded exam questions
- `exam_participants`: unique trim+NFC normalized name, display name, and creation time; no PIN data
- `exam_answer_logs`: submitted choices, correctness, answer time, and nullable participant reference; historical anonymous rows remain NULL
- `exam_answer_submissions`: participant-owned fixed five-question submissions and revision
- `exam_submission_answers`: current selected indices for a submission; revisions replace these rows atomically
- `exam_submission_operations`: operation IDs and canonical payloads used for idempotent retries and mismatch rejection
- `participant_rate_limits`: shared database-backed failed-authentication windows keyed by HMAC fingerprints, without storing IP addresses or names
- `presentation_sessions`: singleton current presentation state, progression version, current zero-based question index, durable `projection_hidden` standby flag, and persistent `presentation_mode` (`full` or `short`, default `full`)
- `presentation_questions`: immutable question/choice/correct-answer/explanation snapshot taken at presentation start in `exam_questions.id ASC` order
- `presentation_entries`: immutable participant/display-name/score/standard-competition-rank and answer snapshot for every participant, including participants with no valid saved submission (score zero)
- `presentation_operations`: admin operation IDs, actions, and optional mode payload for idempotent retries and mismatch rejection

Participant names are trimmed and normalized to Unicode NFC for case-sensitive uniqueness. They are not compatibility-normalized and internal whitespace is preserved. The shared event PIN and session signing secret are held only in server-side environment configuration.

Unconfirmed selections are held only in client state. Confirmed answer sets are persisted as participant-owned submissions and can be revised in place. The existing single-answer API continues to write `exam_answer_logs`; batch submissions do not append to that table. The initial migration seeds five questions idempotently; it does not modify or migrate legacy question or answer data.

## Requirements

### R1: Fixed five-question set

**WHEN** a user opens `/answer` or starts/restarts the exam
**THEN** the client fetches five questions in order through the existing next-question API and holds that set for the attempt.

- The first request has no cursor; each following request uses the prior question ID.
- Order is `exam_questions.id ASC`.
- The question screen appears only after all five questions have been loaded.
- A 404 before five questions are loaded means the exam cannot start and is shown as a shortage, not a network error.
- A network/API failure is retryable. Questions already loaded remain held, and retry fetches only the missing suffix.
- A remount or reload starts a fresh attempt. Restart clears the held set and all session state, then fetches the first five again.
- If fewer than five questions exist, the home CTA is disabled and the `/answer` route shows an explanation and a home link.

### R2: Participant-authenticated answer confirmation and recording

**WHEN** a user chooses options for the five questions and confirms the set
**THEN** `POST /api/answers/batch` atomically saves the five answers for one stable submission.

- The user first joins with a display name and event-wide four-ASCII-digit PIN. A valid existing participant session may be reused without re-entry.
- Every answer POST requires a valid signed participant cookie and same-origin `Origin`; anonymous POSTs are rejected. The legacy single-answer endpoint retains its existing behavior.
- The participant ID comes only from the validated cookie. A client-supplied `participantId` is rejected.
- A batch submission is associated with the validated participant. Historical single-answer rows remain unchanged with a NULL participant ID.

- Individual choices remain in client state until explicit batch confirmation; they do not create server records.
- Choices are native radio inputs grouped by question with a fieldset and legend; show each question prompt visually only in its heading and visually hide the duplicate legend while retaining it as the radio group's accessible name. Each input has an explicit full-row label, and its submitted value remains the existing shuffled-choice index.
- A pending batch request locks all answer controls and prevents duplicate submission.
- While pending, the selected radios remain checked and the confirmation action keeps its name and focus; its disabled state is communicated to assistive technology and guarded synchronously.
- The five selected choices remain available after a failed request so the user can retry.
- A successful batch confirmation moves to completion. The completion view can restore the saved five answers and revise the same submission.
- The UI does not use the response's correctness, correct index, or explanation fields. It shows no per-exam correctness, explanation, score, accuracy, or pass/fail state.
- Retrying a batch after a transport failure reuses the operation ID and exact payload, so a committed request is returned idempotently without duplicating writes.

### R3: Completion

**WHEN** the batch answer POST succeeds
**THEN** show `回答完了` with a `回答を修正する` action for the same saved set.

- Completion has no score, correctness, explanation, or pass/fail result.
- The saved submission revision is updated in place when corrections are confirmed.

### R4: Home and participant entry

**WHEN** the user visits `/`
**THEN** show a primary `5問検定` briefing with `全5問`, `順番に出題`, `回答を記録します`, and the `検定を開始する` CTA.

- Disable starting when fewer than five dedicated exam questions are available and explain that five questions are required.
- Do not show the `これまでの回答状況` section or aggregate statistic cards. Keep answer logs and repository data intact.
- The answer entry flow accepts a name and the organizer-provided shared four-digit PIN in one form. A valid cookie displays the participant name and requires an explicit start action.

### R5: Accessible responsive interface

- Use a restrained exam-paper visual style with light surfaces, ink text, subtle borders, and a primary accent; do not use medals, pass/fail imagery, or certificate visuals.
- Always use the light color palette regardless of the operating system's color-scheme preference.
- Provide readable contrast, visible keyboard focus, native radio semantics, live status updates, and textual progress labels so color is not the sole signal. Choice rows and the primary confirmation action have at least 44 CSS px of interaction height.
- Keep content in a single readable column on narrow screens, avoid horizontal scrolling at 320 CSS px and 200% zoom, and respect reduced-motion preferences.
- During the active answering session, replace the shared sticky header's home link with one five-question navigation. Keep the sticky header's sizing and spacing, show answered state, retain answers while navigating, and move focus to each question heading below the sticky header. At all other answer states, including login, ready, loading, switching, shortage, error, and completion, keep a home link in the shared header and do not show question navigation.
- Show each question prompt only once visually in its heading; keep the duplicate fieldset legend visually hidden and available to assistive technology as the radio group's accessible name. Do not show per-question helper paragraphs below the radio choices or reference them with `aria-describedby`; retain native radio group semantics, overall unanswered guidance, and answer progress.
- In-page links to unanswered questions move focus to a visible question heading without it being hidden behind page chrome. Do not add exam-time correctness, explanation, score, accuracy, or pass/fail information.

### R6: Isolated administrator authentication

- Admin sign-in uses `ADMIN_PRESENTATION_PIN` and `ADMIN_PRESENTATION_SESSION_SECRET`; if either is missing or invalid, admin sign-in and protected admin endpoints fail closed.
- The admin session is a signed HttpOnly cookie with a purpose-specific HMAC key, separate cookie name and secret from the participant session. Participant cookies never grant admin access.
- `POST` and `DELETE` admin session operations and every admin state mutation require a same-origin `Origin`. Every admin presentation route requires a valid admin cookie. Admin and public presentation API responses use `Cache-Control: no-store`.

### R7: Immutable presentation snapshot and ranking

- Only one current presentation session is stored. Starting it snapshots all `exam_questions` in `id ASC` order, all `exam_participants`, and each participant's latest valid complete saved submission against that question set in one database transaction.
- Each correct answer is one point; unanswered or invalid/incomplete submissions score zero. Every participant is included. Ties use standard competition ranking (1, 1, 3); all people with a rank are announced together.
- The score, rank, participant display name, selected-answer snapshot, question text, choices, correct answer, and explanation are immutable for the lifetime of the session. Later answer revisions and question edits do not change the announcement.
- State progression is manual: each question advances `question` then `answer`; after the last answer, `podium_preview` announces no winners; ranks with no winners are skipped while announcing rank 3, then 2, then 1; the process ends at `finished`.
- An `operationId` retry for the same action is idempotent. Reusing it for a different action, or advancing from an invalid state, returns 409. Version-checked updates reject concurrent state changes.
- `advance` moves one stage forward. `previous` moves the persistent stage cursor back one stage without changing any snapshotted question, answer, score, or rank. From `finished`, it returns to the last existing announced rank in the 3rd → 2nd → 1st sequence, or `podium_preview` if there were no winners. `previous` at the initial state returns 409.
- Admin actions `hide` and `show` durably set `projectionHidden`; this can be set before `start`. While hidden, the public API returns only `{ state: 'standby' }`. Showing restores the current projection stage without changing it.
- Presentation mode defaults to `full` and persists in SQLite. `setMode` can select `full` or `short` before or after start without moving the current stage. A retried operation ID with a different mode returns 409.
- `short` changes only the disclosed answer-screen content: the question and answer stages remain separate manual stages; ranking stages remain manual in 3rd → 2nd → 1st order. Hiding the projection and moving backward work in both modes; score/rank snapshots remain immutable.

### R8: Staged result disclosure

- The admin projection includes the complete immutable question and ranking snapshot at every state plus `projectionHidden: boolean`. It is available only through authenticated admin APIs.
- The public projection contains no score, rank, result, correct answer, or explanation before the appropriate state. A `question` state includes only that question and its choices. The matching `answer` state first includes its correct answer and correct choice index; its explanation follows the selected presentation mode.
- In the P0 answer screen, show the existing explanation text as stored, limited to at most four visible lines in `full` mode; the authenticated admin screen keeps the full explanation available. In `short` mode, the answer projection includes `correctAnswer`, `correctIndex`, and `choices`, and omits the `explanation` property entirely. Separate approved projection summaries and host notes are P1 and are not required for P0.
- `podium_preview` includes no winner names or scores. A `third`, `second`, or `first` state includes only the display name, score, and rank of everyone tied at that announced rank. Other states include no winners.
- Existing participant session, answer, and batch APIs do not return presentation ranking or answer keys.

## API

### `GET /api/questions/next`

- Optional query parameter: `afterId`, a positive integer question ID.
- Without `afterId`, returns the lowest dedicated exam question ID.
- With `afterId`, returns the lowest dedicated exam question ID greater than the cursor.
- Response 200: `{ id, question, choices }`
- Response 400: invalid cursor
- Response 404: no next question

### `POST /api/answers`

- Request: `{ questionId: number, selectedIndex: number }`
- Requires same-origin `Origin` and a valid signed participant cookie whose participant still exists.
- Rejects anonymous calls and any body containing `participantId`; associates the answer with the cookie's participant.
- Response 200: `{ isCorrect, correctIndex, explanation }` (the exam UI ignores grading fields)
- Response 400/401/403/404: invalid selection, missing/invalid participant session, origin failure, or missing question

### `/api/answers/batch`

`POST` creates or revises a five-answer submission; `GET` restores a confirmed submission.

#### `POST`

- Request: `{ submissionId: UUID, operationId: UUID, expectedRevision: integer, answers: [{ questionId, selectedIndex }] }`
- `answers` must contain exactly five distinct questions in the current fixed exam set for initial submission; revisions must use the same saved question set.
- Requires same-origin `Origin` and a valid signed participant cookie whose participant still exists. Participant identity is taken only from that cookie.
- Answer APIs currently have no rate limit; failed sign-in attempts are rate-limited only on `POST /api/participants/session`. The batch route keeps the existing single-answer API's rate-limit behavior unchanged.
- `expectedRevision` is `0` for initial save and the current saved revision for a correction. A successful write advances the revision by one.
- Initial creation and correction are each one transaction. Corrections update the same submission answer rows and do not append to `exam_answer_logs`.
- `operationId` is unique per deliberate save. Repeating it with the same submission ID and canonical payload returns the original revision; reusing it with a different payload is rejected. Revision mismatches return 409.
- Response 200: `{ submissionId, revision }`; no correctness, correct index, explanation, score, or pass/fail data is returned.
- Response 400/401/403/404/409: invalid request/question set, missing participant, origin failure, missing submission, or operation/revision conflict.
- If a save conflicts because its `expectedRevision` is stale, the client can use GET to reload the saved revision while retaining its local draft.

#### `GET /api/answers/batch?submissionId={UUID}`

- Requires a valid signed participant cookie. A submission is visible only to its owning participant; missing and other-participant submissions both return 404.
- Response 200: `{ submissionId, revision, answers: [{ questionId, selectedIndex }] }`. No grading fields are returned.
- Used to restore confirmed answers or reload the saved revision after a conflict while preserving the local draft.
- Response 400/401/404: invalid submission ID, missing participant session, or unavailable submission.

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

- `GET` requires a valid admin cookie and returns the complete current snapshot: `{ state, version, questionIndex, questionCount, projectionHidden, presentationMode, questions: [{ id, question, choices, correctIndex, correctAnswer, explanation }], entries: [{ displayName, score, rank }] }`.
- `POST` requires admin cookie, same-origin `Origin`, and `{ operationId, action: 'start' | 'advance' | 'previous' | 'hide' | 'show' }` or `{ operationId, action: 'setMode', mode: 'full' | 'short' }`. It returns the current complete admin projection. Replayed operations do not progress state again; ID/action/payload conflicts and state/version conflicts return 409.
- Both methods are `no-store`; unauthenticated access returns 401.

### `GET /api/presentation`

- Returns the server's current public projection and is `no-store`.
- In `question` / `answer`, response is `{ state, question: { id, ordinal, total, question, choices, correctAnswer?, correctIndex?, explanation? } }`. `ordinal` is one-based. The `question` state omits all answer keys and explanation. In `answer`, `correctAnswer` and `correctIndex` are included; `explanation` is included only in `full` mode and omitted entirely in `short` mode.
- In a rank announcement, response is `{ state, winners: [{ displayName, score, rank }] }`, containing every tied participant for only the announced rank. `podium_preview` has no `winners` property. Other states return only `{ state }`.
- When the durable projection standby flag is on, the sole response is `{ state: 'standby' }`, independent of the private presentation stage.

## Components

- `/`: server-rendered exam briefing and start availability
- `/answer`: participant entry/session reuse, client-held five-question session, native radio choice groups, sticky-header question navigation while answering and home navigation in other states, atomic batch confirmation, same-submission correction, and neutral completion
- `src/app/GlobalHeader.tsx` and `src/app/answer/header-portal.tsx`: shared sticky header and answer-route navigation slot, with RootLayout remaining a Server Component
- `src/components/ChoiceButton.tsx`: labeled native radio row with circular choice mark and selected-state styling
- `src/lib/db/repository/question-repository.ts`: next-question lookup by ID cursor and answer lookup from `exam_questions`
- `src/app/api/answers/batch/route.ts`: authenticated atomic five-answer create/correction endpoint
- `src/lib/db/repository/answer-repository.ts`: preserves legacy single-answer logging and provides atomic submission persistence, owner-scoped restore, revision checks, and idempotent operation replay
- `src/lib/presentation/admin-auth.ts`: separate admin PIN verification, HMAC session cookie, and origin-checked authorization
- `src/lib/db/repository/presentation-repository.ts`: immutable answer/question snapshot, scoring, standard competition ranks, state machine, operation idempotency, and strict public projection
- `/api/admin/session`, `/api/admin/presentation`, `/api/presentation`: isolated sign-in, private conductor API, and staged public projection

## Coverage tiers

`scripts/check-coverage-tiers.mjs` validates these statement coverage targets:

- Tier 1: core logic (`shuffle`, `choice-label`, JST date helpers), 90%
- Tier 2: API routes, 80%
- Tier 2b: API client and utilities, 85%
- Tier 3: repositories, 75%
- Tier 4: answer UI state management, 90% statements and 75% branches
- Tier 5: shared UI components, 70%

## Testing

Vitest covers core logic, API/client behavior, the sequential question repository, answer session state, shared components, and statistics repositories. Playwright covers the home, answer, and answer submission flows.

## Environment

Runtime configuration requires `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `PARTICIPANT_PIN`, and `PARTICIPANT_SESSION_SECRET` for participant authentication. `PARTICIPANT_PIN` is exactly four ASCII digits, including possible leading zeroes. The secret must have at least 32 bytes. The cookie payload is `{ id, exp }`; its HMAC-SHA256 signing key is derived as `HMAC-SHA256(PARTICIPANT_SESSION_SECRET, "stcirt-participant-session-v1" + NUL + PARTICIPANT_PIN)`. The `stcirt-participant-session-v1` purpose label and NUL delimiter are fixed. PIN or secret changes invalidate existing cookies. Rate-limit HMAC key derivation uses a separate fixed purpose label and does not include the PIN, so PIN rotation does not reset rate limits. Old cookies are rejected and participants must sign in again. `PARTICIPANT_PIN_HASH`, `PARTICIPANT_PIN_PEPPER`, and `PARTICIPANT_EVENT_VERSION` are retired.

Admin presentation authentication separately requires `ADMIN_PRESENTATION_PIN` and `ADMIN_PRESENTATION_SESSION_SECRET`; the PIN must be nonempty and at most 128 characters, and the secret must have at least 32 bytes. Missing configuration fails closed. The admin cookie is `stcirt_admin_presentation`, HttpOnly, SameSite=Strict, Secure in production, and expires after eight hours. Its HMAC-SHA256 key is derived from the admin secret and fixed `stcirt-admin-presentation-session-v1` purpose label. Admin secrets/cookies are not shared with participant authentication.

Use `pnpm participant-auth generate` to create the participant pair in `.env.local`. It prompts twice for a user-selected four-digit ASCII PIN using hidden terminal input, preserving leading zeroes, and generates the session secret automatically. Non-interactive runs fail. It preserves other settings, refuses to overwrite either selected profile key, and writes atomically with mode 0600. Use `--rotate` only for intentional replacement. The default profile is `participant`; use `--profile admin` to create the separate `ADMIN_PRESENTATION_PIN` and `ADMIN_PRESENTATION_SESSION_SECRET` pair. Admin PIN input is hidden and accepts 1–128 characters; its session secret is generated automatically from 32 random bytes and encoded as base64url.

To also sync the newly saved pair to Production in the same command, link the repository to the intended Vercel project, authenticate with Vercel CLI, and run `pnpm participant-auth generate --sync-production` (or add `--profile admin` for admin credentials). This sync does not start a deployment; start a new deployment separately for the changes to take effect. If sync fails, `.env.local` retains the generated pair and the command exits nonzero with instructions to rerun the matching profile's `pnpm participant-auth sync --target production` command. Alternatively, sync a saved pair with `pnpm participant-auth sync --target production` or `--target preview`, adding `--profile admin` when syncing admin values. Sync requires Vercel CLI authentication, upserts only the selected profile's two values through stdin using `--force --sensitive`, never deploys, and exits nonzero if either upsert fails. Preview applies to all branches; inspect branch-specific overrides in Vercel separately. Development is excluded because Vercel sensitive variables are supported only for Production and Preview. The Vercel CLI dependency is pinned to version `58.4.4`.

Optional `PARTICIPANT_SESSION_DAYS` accepts 1–90 (default 30); `PARTICIPANT_RATE_LIMIT_NAME` defaults to 5 failed attempts per normalized name per 15 minutes. Question generation and question-management endpoints are not part of the application.
