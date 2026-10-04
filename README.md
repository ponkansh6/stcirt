# Stcirt - 1-Knowledge-1-Question Endless Learning App

A Next.js 16 application for answering stored 4-choice questions in insertion order, with instant feedback.

## Features

- 📚 **Sequential Learning**: Answer existing questions from earliest to latest.
- ⚡ **Instant Feedback**: Immediate correct/incorrect grading, highlighting correct answers and your selections.
- 📊 **Dashboard Stats**: Real-time tracking of total questions, answers, and overall accuracy.

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

4. **Run development server**:

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
