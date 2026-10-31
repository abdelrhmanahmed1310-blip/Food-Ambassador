# Food Ambassador — Operations runbook

For whoever runs a pilot or production instance. Commands run from the
repository root unless noted. Rules behind them: DECISIONS.md ADR-044.

## 1. Deploy

1. CI must be green on the commit (format, lint, typecheck, unit,
   integration, E2E, build).
2. **Back up first** (§3). Never migrate without a fresh, checked backup.
3. Apply migrations: `DATABASE_URL=… pnpm db:deploy` (forward only; Prisma
   records each in `_prisma_migrations`).
4. Start the new image (`Dockerfile`, `node server.js`). Required
   environment: `DATABASE_URL`, `APP_URL` (https in production — it turns on
   secure cookies), `AUTH_SECRET` (≥ 32 random characters, stable across
   instances), `TRUSTED_PROXY_HOPS`, `LOG_LEVEL`. Optional
   `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` for more than one instance.
5. Check `GET /api/health` (process up) and `GET /api/health/ready`
   (database reachable; 503 otherwise).
6. Run `pnpm db:verify` against the database (§4).

Rollback: the previous image keeps working only if no migration ran. If one
did, restore the pre-deploy backup into a new database (§3) and point the
previous image at it — schema changes are not undone in place.

## 2. Monitoring

- Liveness `/api/health`, readiness `/api/health/ready` (the Docker image
  has a HEALTHCHECK on liveness).
- Logs are JSON lines on stdout with `requestId` (also returned as the
  `x-request-id` response header); secrets and passwords are redacted.
  Ask users for the time and page of a failure and search by request id.
- Run `pnpm db:verify` daily (cron) and alert on a non-zero exit.

## 3. Backup and restore

**Backup:** `pnpm db:backup [directory]` writes
`food-ambassador-<UTC time>.dump` (pg_dump custom format, compressed, no
owner) and a `.sha256` next to it. Schedule it at least daily and before
every deploy; copy both files off the database host; keep 30 daily and 12
monthly. Backups contain all tenants' data: store them encrypted with access
limited like the database itself.

**Restore** (into a new database, never over a live one):

```bash
createdb food_ambassador_restore              # or create it in your provider
pnpm db:restore backups/food-ambassador-….dump postgresql://…/food_ambassador_restore
```

The script refuses a dump without a matching checksum and a target that
already has tables, recreates the `fa_tenant` role the grants need, restores
in one transaction (all or nothing) and runs `pnpm db:verify`. Then point the
app at the restored database.

A single organization cannot be restored on its own (all tenants share the
tables); restore to a side database and copy what is needed by hand, with a
second person checking.

**Drill** (do it before the pilot and quarterly): back up, restore into a
new database, compare row counts per table, drop it. Last drill:

| Date (UTC) | Source                                | Size   | Backup | Restore + verify | Result                                                                                                                   |
| ---------- | ------------------------------------- | ------ | ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-31 | test database (1,651 orgs, 79 tables) | 6.3 MB | 2.6 s  | 4.9 s            | All checks passed; row counts identical in all 79 tables; wrong checksum, bad checksum file and non-empty target refused |

## 4. Integrity check

`pnpm db:verify` checks that every tenant table has row-level security and
its policy, stock balances equal the ledger, stock values equal ledger +
revaluations + landed costs, no stock is negative or over-reserved, and
every migration is applied. It prints counts only, never data.

If it fails: stop posting for the affected organization (tell its users),
keep the database as is, take a backup, and investigate from the ledger —
it is append-only, so balances and values can be recomputed from it. Never
edit balances by hand (AGENTS.md).

## 5. Incidents

| Situation                             | Do                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/health/ready` returns 503       | Check database reachability and credentials; the app recovers by itself when the database is back.                                                            |
| A migration failed                    | Do not retry blindly. Read the error; fix forward with a new migration, or restore the pre-deploy backup (§3).                                                |
| Suspected account compromise          | Remove the member's roles (Settings → Members) or the membership; delete their sessions: `DELETE FROM sessions WHERE user_id = '<id>';`                       |
| Suspected secret leak (`AUTH_SECRET`) | Rotate it (all sessions end; users sign in again), rotate the database password, review `audit_events` for the period.                                        |
| Data shown to the wrong organization  | Treat as a security incident: take the instance offline, keep logs and a backup, find the request ids; the isolation tests and RLS should make it impossible. |
| Someone asks for their data           | Audit events and records are per organization; export through the app's CSV exports; personal data of users is name and e-mail only.                          |

## 6. Ingredient library downloads

See README → Ingredient library downloads (`pnpm library:import`). Large
imports run in parts and can be re-run safely.

## 7. Webhook worker

Outbound webhooks wait in the outbox until `pnpm integrations:deliver`
sends them (docs/INTEGRATIONS.md). Run it every minute from the scheduler,
or as a long-running process with `--watch`; several instances are safe.
It prints counts only. Set `INTEGRATION_ENCRYPTION_KEY` in production and
keep it with the other secrets: losing it makes every connector secret
unreadable (rotate them all after restoring with a new key). Failed
deliveries are listed on each connector's page and can be retried there.
