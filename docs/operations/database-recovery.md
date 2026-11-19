# Database migrations and recovery notes

## Migration behavior

The SQLite/Turso schema and immutable checked-in migrations are under `src/lib/db/`. `pnpm db:migrate` applies pending checked-in migrations. `pnpm db:push` is available for schema development, but is not a substitute for reviewed, checked-in migrations when changing an existing deployment. Review migration SQL and its effects before applying it to a shared or production database.

Migration 0011 is a one-time dataset reset: it deletes prior answer logs and submissions, removes the current presentation session and its cascaded snapshots, and hides participant results, while retaining presentation operation records for idempotent delayed retries. This is not a normal retention or deletion policy. Later migrations include compatibility backfills; for example, 0012 marks existing result visibility rows as previously published, while 0013 distinguishes existing valid snapshots from sessions without snapshots.

Every non-deletion push runs `scripts/check-prod-migrations.mjs` in pre-push Phase 0. It reads the migration journal and SQL files from each pushed commit and checks that every journal timestamp and SQL hash exists in the production `__drizzle_migrations` history. Two audit-confirmed historical checksum differences are accepted only for the exact migration tag, timestamp, current SQL hash, and production hash pairs recorded in the checker: 0011 and 0025. The 0025 production hash matches commit `0f862f0`; the origin of the 0011 difference is unverified. These exceptions validate the existing history only. Do not reapply migration 0011, which deletes prior submissions and presentation snapshots, or rewrite production migration history to match. All other missing migrations or checksum differences, missing credentials, and connection or inspection errors block the push. The check uses `.env.local` and read-only database queries and never applies migrations. CI does not check production migration history, and the actual read-only privilege level of the configured Turso token has not been verified.

The repository also includes `scripts/check-prod-schema.sh` for read-only schema drift inspection. The pre-push Phase 3 gate runs it when `src/lib/db/schema.ts` or migration files change. Drift, missing credentials, and connection or inspection failures block the push. The checker distinguishes match (exit 0), drift (exit 1), missing credentials (exit 2), and inspection failures (exit 3), and does not perform database writes. CI does not run production schema drift inspection.

These checks do not back up, migrate, repair, or restore a database. To apply reviewed pending migrations to an existing deployment, use `pnpm db:migrate` as a separate operator action after reviewing their SQL and effects. Do not describe a passing migration-history or schema drift check as proof that data is recoverable.

## Recovery limits and unresolved ownership

This repository defines no backup schedule, backup retention, restore procedure, restore permissions, point-in-time recovery mechanism, or recovery objective. RPO and RTO are unresolved. The deployment/operator role must establish those details with the database provider and record the actual procedure before recovery can be promised. See [open decisions](../decisions/open-items.md).

### External recovery evidence status

Local repository evidence reviewed 2026-10-19: no provider or deployment evidence was available here to verify the deployed database scope, retention/deletion policy, backup frequency or retention, assigned owner, approved RPO/RTO, restore procedure/authority, or an isolated restore drill and its result. These items are **unverified**, not findings that the service has no such configuration or capability. No backup or restore was performed for this review, and no external confirmation date or approver is recorded.

The actual privilege level of the credential used by the read-only drift checker remains unverified. Credential issuance, storage, rotation, revocation, and responsible role are also unverified. No credential value was inspected or recorded. Track decisions and ownership through [open decisions](../decisions/open-items.md).

For a migration or suspected schema problem, preserve the observed error and migration identifier, stop any unreviewed schema mutation, and involve the deployment/operator role. Do not run `db:push` against production as an improvised repair. No destructive rollback or restore command is specified here because the repository does not establish a safe source of backup or recovery authority.

Accidental publication is also not covered by a recovery guarantee. The admin can hide participant results through the existing visibility endpoint, but this does not erase data or rebuild snapshots. Confirm the resulting visibility state through the authorized admin interface and use the deployment's incident process; that process and its owner remain to be assigned.

Useful references: `src/lib/db/migrations/`, `src/lib/db/schema.ts`, `scripts/check-prod-schema.sh`, and `.husky/pre-push`. See the [product data contract](../../openspec/specs/stcirt/spec.md) and [data lifecycle guide](../data-governance.md).
