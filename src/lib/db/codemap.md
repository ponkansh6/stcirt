# src/lib/db/

## Responsibility

Database layer: Drizzle ORM setup with lazy connection initialization, legacy study schema preservation, fixed exam questions, participant-owned submissions, durable assessment jobs, assisted participants, presentation snapshots, and participant-result visibility. See `openspec/specs/stcirt/spec.md` for the product data contract; this codemap describes code locations only.

## Modules

- `index.ts` — Drizzle instance creation + Turso client lazy initialization proxy
- `schema.ts` — SQLite table definitions for legacy study data, exam questions/submissions/assessments, participants, rate limits, assisted links, presentation snapshots, and result settings
- `migrations/0001_brainy_lizard.sql` — creates dedicated exam tables and seeds five stable-key IT-literacy sample questions; leaves legacy rows untouched
- `migrations/0002_nifty_eddie_brock.sql` — adds participants, shared rate-limit storage, and a nullable participant reference to answer logs without rewriting historical rows
- `repository/` — exam reads and writes, atomic batch submissions, durable JEV retry, assisted-participant links, aggregation, and staged result projections
- `../participants/rate-limit.ts` — Turso-backed failed sign-in windows keyed by HMAC fingerprints
