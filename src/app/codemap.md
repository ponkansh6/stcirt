# src/app/

## Responsibility

Next.js App Router pages and REST API routes for the fixed five-question exam, administrator presentation, public projection, and participant results. Product behavior is specified in `openspec/specs/stcirt/spec.md`.

## Structure

- `layout.tsx` — Root layout and global styling
- `page.tsx` — Compatibility redirect from `/` to `/answer`
- `answer/` — Participant entry, fixed exam, completion/correction, and assisted-answer flow
- `admin/presentation/` — Administrator console and authenticated presenter UI
- `presentation/` — Public projection and signed-session-gated presenter view
- `results/` — Authenticated participant's own published result view
- `api/questions/batch/route.ts` — GET the fixed five-question payload without answer keys
- `api/answers/batch/route.ts` — Authenticated atomic save/correction endpoint
- `api/participants/` — Participant session, assisted answer, and result APIs
- `api/admin/` — Separate admin authentication, snapshot, deck, and result visibility APIs
- `api/presentation/route.ts` — Stage-specific public projection API
