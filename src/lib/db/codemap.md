# src/lib/db/

## Responsibility

Database layer: Drizzle ORM setup with lazy connection initialization, legacy study schema preservation, dedicated exam questions, sequential exam retrieval, and exam answer logging/stats.

## Modules

- `index.ts` — Drizzle instance creation + Turso client lazy initialization proxy
- `schema.ts` — SQLite table definitions for legacy study data and dedicated `examQuestions` / `examAnswerLogs`
- `migrations/0001_brainy_lizard.sql` — creates dedicated exam tables and seeds five stable-key IT-literacy sample questions; leaves legacy rows untouched
- `repository/`
  - `question-repository.ts` — `getNextQuestion(afterId)` returns dedicated exam questions in ID order, and `getQuestionById()` supports answer lookup
  - `answer-repository.ts` — Answer recording (`examAnswerLogs`) and today's JST aggregate stats from exam data (`getStats()`)
