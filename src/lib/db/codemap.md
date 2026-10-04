# src/lib/db/

## Responsibility

Database layer: Drizzle ORM setup with lazy connection initialization, legacy study schema preservation, dedicated exam questions, participants, shared participant sign-in rate limits, sequential exam retrieval, and exam answer logging/stats.

## Modules

- `index.ts` — Drizzle instance creation + Turso client lazy initialization proxy
- `schema.ts` — SQLite table definitions for legacy study data and dedicated exam question, participant, rate-limit, and answer-log tables
- `migrations/0001_brainy_lizard.sql` — creates dedicated exam tables and seeds five stable-key IT-literacy sample questions; leaves legacy rows untouched
- `migrations/0002_nifty_eddie_brock.sql` — adds participants, shared rate-limit storage, and a nullable participant reference to answer logs without rewriting historical rows
- `repository/`
  - `question-repository.ts` — `getNextQuestion(afterId)` returns dedicated exam questions in ID order, and `getQuestionById()` supports answer lookup
  - `answer-repository.ts` — records exam answers, associating newly authenticated submissions with participants while retaining optional aggregate statistics
  - `participant-repository.ts` — NFC name normalization, name-based participant reuse, and participant lookup for sessions
- `src/lib/participants/rate-limit.ts` — Turso-backed failed sign-in windows keyed by HMAC fingerprints
