# Stcirt Five-Question Exam Specification

## Overview

Stcirt presents a dedicated set of five Japanese IT-literacy questions in ID order as a fixed-length, exam-style answering session. The UI records each submitted choice through the existing answer API but does not present correctness, explanations, scores, accuracy, or pass/fail results within an exam session. Legacy `questions` and `answer_logs` data remain intact and are not read or written by this application. The home page shows aggregate history from the dedicated exam tables as secondary information, clearly distinguished from one exam attempt.

## Data Model

The Drizzle schema in `src/lib/db/schema.ts` contains the legacy tables and the exam-specific tables:

- `knowledge`: source text and title for stored learning material
- `questions`: one question per knowledge record, with choices and correct answer
- `answer_logs`: submitted choices, correctness, and answer time
- `exam_questions`: stable integer IDs and unique keys for the five seeded exam questions
- `exam_answer_logs`: submitted choices, correctness, and answer time, linked only to `exam_questions`

The exam session is held only in client state. It is not persisted. Reloading or remounting starts a new attempt, and repeated attempts write another set of per-question rows to `exam_answer_logs`. The initial migration seeds five questions idempotently; it does not modify or migrate legacy question or answer data.

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

### R2: Answer confirmation and recording

**WHEN** a user chooses an option and confirms it
**THEN** the existing `POST /api/answers` records that choice for the current question.

- The user may change a choice until explicit confirmation.
- A pending request locks the answer controls and prevents duplicate submission.
- The selected choice and current question remain available after a failed request so the user can retry.
- A successful POST increments the recorded-answer count before advancing to the next held question. A successful answer is never submitted again during the same attempt.
- The current question position (`第n問 / 全5問`) and successful recorded count (`回答記録済み k/5`) are separate values. The five-step list distinguishes answered, current, and not-yet-reached questions in text as well as appearance.
- The UI does not use the response's correctness, correct index, or explanation fields. It shows no per-exam correctness, explanation, score, accuracy, or pass/fail state.
- If an answer is rejected because the question changed or disappeared, keep the user on that question with the selected option and an error/home path; do not replace or skip it.
- Retrying a POST after a transport failure may create another answer log if the server recorded the first request but its response was lost. This cannot be resolved by the UI-only flow.

### R3: Completion

**WHEN** the fifth answer POST succeeds
**THEN** show `回答完了` and `全5問の回答を記録しました。` with a `もう一度受検する` action.

- Completion has no score, correctness, explanation, or pass/fail result.
- Restart starts a new attempt from the first five questions.

### R4: Home and aggregate statistics

**WHEN** the user visits `/`
**THEN** show a primary `5問検定` briefing with `全5問`, `順番に出題`, `回答を記録します`, and the `検定を開始する` CTA.

- Disable starting when fewer than five dedicated exam questions are available and explain that five questions are required.
- Show aggregate historical statistics below the briefing under `これまでの回答状況`, and identify them as not belonging to one exam attempt.
- Show total dedicated exam question count, today's dedicated exam answer count, and today's exam answer accuracy using JST day boundaries.

### R5: Accessible responsive interface

- Use a restrained exam-guide visual style with light surfaces, ink text, and a subtle gold/primary accent; do not use medals, pass/fail imagery, or certificate visuals.
- Provide readable contrast, visible keyboard focus, operable controls, live status updates, and textual state labels so color is not the sole signal.
- Keep content in a single readable column on narrow screens, avoid horizontal scrolling at 200% zoom, and respect reduced-motion preferences.

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
- Response 200: `{ isCorrect, correctIndex, explanation }` (the exam UI ignores grading fields)
- Response 400/404: invalid selection or missing question

## Components

- `/`: server-rendered exam briefing, start availability, and secondary historical statistics
- `/answer`: client-held five-question session, confirmation, per-question answer recording, and neutral completion
- `src/lib/db/repository/question-repository.ts`: next-question lookup by ID cursor and answer lookup from `exam_questions`
- `src/lib/db/repository/answer-repository.ts`: answer logging and aggregate statistics from `exam_answer_logs`

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

Runtime configuration requires `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Question generation and question-management endpoints are not part of the application.
