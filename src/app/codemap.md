# src/app/

## Responsibility

Next.js App Router pages and REST API routes for sequential quiz answering.

## Structure

- `layout.tsx` — Root layout with shared navigation and global styling
- `page.tsx` — Home page displaying learning statistics
- `answer/` — Quiz page, state machine, and answer UI
- `api/questions/next/route.ts` — GET the next stored question after an ID cursor
- `api/answers/route.ts` — POST an answer, record it, and return feedback
