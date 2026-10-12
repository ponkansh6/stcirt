# src/lib/

## Responsibility

Core utilities, authentication, assessment integration, database repositories, API clients, and helper functions. Product requirements are maintained in `openspec/specs/stcirt/spec.md`; this file is only an implementation navigation aid.

## Modules

- `sleep.ts` — Asynchronous sleep helper
- `choice-label.ts` — Choice label formatter (A/B/C/D)
- `date.ts` — JST date boundary helper (`jstDayStart`)
- `api/` — API helpers (`client.ts`, `response.ts`, `schemas.ts`)
- `participants/` — participant authentication rate limiting and session support
- `jev/` — versioned fifth-question assessment adapter
- `db/` — Drizzle ORM + Turso database; preserves legacy study tables while the app reads/writes dedicated exam tables and their migration-seeded questions
