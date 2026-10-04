# Stcirt - 1-Knowledge-1-Question Endless Learning App

A Next.js 16 application for answering a shared set of stored 4-choice questions in insertion order.

## Features

- 📚 **Fixed Exam Experience**: Answer the same five-question exam in order.
- 📝 **Shared Exam Set**: Participants answer the same fixed set of five questions in order.
- 👤 **Participant Answers**: Participants sign in with their name and the shared four-digit event PIN; their answers are saved in the database under their participant record.

## Stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript 6
- **Database**: Drizzle ORM + Turso (libSQL)
- **UI**: React 19, Tailwind CSS v4
- **Testing**: Vitest, Playwright
- **Tooling**: pnpm, Oxlint, Prettier

## Getting Started

### Prerequisites

- Node 24+
- pnpm 11.9.0
- Turso database (https://turso.tech)

### Setup

1. **Clone and install**:

   ```bash
   pnpm install
   ```

2. **Configure environment**:

   ```bash
   cp .env.local.example .env.local
   ```

   Edit `.env.local`:

   ```env
   TURSO_DATABASE_URL=libsql://your-db.turso.io
   TURSO_AUTH_TOKEN=your-token-here
   ```

3. **Initialize database**:

   ```bash
   pnpm db:push
   ```

   For an existing deployment, apply checked-in migrations with `pnpm db:migrate`.

4. **Configure participant access**:

   Choose the shared event PIN and generate its scrypt hash and pepper. The script asks for the PIN twice without displaying what you type; it accepts exactly four ASCII digits, including a leading zero, and requires an interactive terminal:

   ```bash
   node scripts/generate-participant-pin-hash.mjs
   ```

   Put the printed `PARTICIPANT_PIN_HASH` and `PARTICIPANT_PIN_PEPPER` into the server's secret environment. The script does not print the PIN. Generate `PARTICIPANT_SESSION_SECRET` separately with `openssl rand -hex 32`, and set `PARTICIPANT_EVENT_VERSION=1`. Share the PIN you entered with participants using a secure channel; do not put the plain PIN in the repository or application logs. Keep the PIN hash, pepper, and session secret in deployment secrets, not in source control.

   Rotating the event PIN requires generating and configuring a new hash and pepper and incrementing `PARTICIPANT_EVENT_VERSION`. This invalidates all previously issued participant cookies. The cookie lifetime defaults to 30 days and can be set with `PARTICIPANT_SESSION_DAYS` (1–90). Failed authentication attempts are reserved transactionally in Turso before PIN verification: the default limit is 5 attempts per normalized name in 15 minutes, shared across all request sources. Set `PARTICIPANT_RATE_LIMIT_NAME` to change that limit. A successful PIN verification releases its reservation in a Turso transaction, so successful sign-ins do not count against the limit. If that release fails, sign-in fails closed with a temporary-unavailable response and no session cookie; the reservation may remain counted until its 15-minute window expires, so the participant may need to retry later. Database errors while reserving or finalizing an authentication attempt also fail closed. Old rate-limit records are cleaned during failed sign-in requests once they are more than 24 hours old.

5. **Run development server**:

   ```bash
   pnpm dev
   ```

   Open http://localhost:3000

## Available Scripts

```bash
pnpm dev              # Start dev server
pnpm build            # Build for production
pnpm start            # Start production server
pnpm test             # Run unit tests
pnpm test:e2e         # Run E2E tests
pnpm type-check       # TypeScript type check
pnpm db:push          # Push schema to database
pnpm db:studio        # Open Drizzle Studio
```

## Project Structure

```
src/
  app/              # Next.js App Router pages and API routes
  components/       # Shared UI components
  lib/              # Core utilities (db repositories, api clients, shuffle)
tests/              # Test suites (Vitest & Playwright)
openspec/           # Specification documents (openspec/specs/stcirt/spec.md)
```

> **Note on Design Documents**: Historical design records (`IMPLEMENTATION.md`, `PLAN.md`, `shared_plan/01-IMPLEMENTATION_PLAN.md`) represent past planning phases. The authoritative specification for the current implementation is located at `openspec/specs/stcirt/spec.md`.

## License

Private project. All rights reserved.
