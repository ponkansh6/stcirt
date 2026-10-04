# src/lib/

## Responsibility

Core utilities, database repositories, API clients, and helper functions.

## Modules

- `sleep.ts` — Asynchronous sleep helper
- `choice-label.ts` — Choice label formatter (A/B/C/D)
- `date.ts` — JST date boundary helper (`jstDayStart`)
- `api/` — API helpers (`client.ts`, `response.ts`, `schemas.ts`)
- `db/` — Drizzle ORM + Turso database; preserves legacy study tables while the app reads/writes dedicated exam tables and their migration-seeded questions
