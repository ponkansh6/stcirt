# stcirt/

## Responsibility

Stcirt is a Next.js 16 application for answering stored 4-choice questions in insertion order, with answer logging and learning statistics.

## Design

- Database persistence via Drizzle ORM + Turso (SQLite)
- Sequential question retrieval using an auto-incrementing question ID cursor
- Client-side shuffling (Fisher-Yates) and answer submission with immediate feedback
- Next.js App Router for routing and API handling

## Flow

1. User visits `/answer`; the first stored question is fetched in ascending ID order.
2. After an answer is successfully recorded, the session requests the next higher question ID.
3. Choices are shuffled, and the answer API returns correctness and explanation.
4. The session ends when no question remains after the cursor.

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
      questions/next/route.ts
      answers/route.ts
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
