# stcirt/

## Responsibility

Stcirt is a Next.js 16 application for answering a fixed five-question exam and viewing participant results.

## Design

- Database persistence via Drizzle ORM + Turso (SQLite)
- Five-question retrieval and atomic, participant-owned answer submission
- Next.js App Router for routing and API handling

## Flow

1. User visits `/answer` and loads the fixed five-question set from `/api/questions/batch`.
2. Choices stay in client state until explicit confirmation submits the full set to `/api/answers/batch`.
3. A confirmed submission can be restored or revised through the batch answer API.

## Technology Stack

- Next.js 16, React 19, TypeScript 6, Tailwind CSS v4
- Drizzle ORM + Turso (libSQL)
- Zod, Vitest, Playwright, pnpm

## File Structure

```
src/
  app/
    page.tsx
    answer/
      page.tsx
      quiz-runner.tsx
      use-quiz-session.ts
    api/
      questions/batch/route.ts
      answers/batch/route.ts
      answers/latest/route.ts
  components/
  lib/
    api/
    db/
      schema.ts
      repository/
        question-repository.ts
        answer-repository.ts
    shuffle.ts
  types/quiz.ts

tests/                     # Vitest and Playwright test suites
openspec/                  # Application specification
```
