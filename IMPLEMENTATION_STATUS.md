# Food Ambassador — Implementation Status

Last updated: 2026-10-29 (end of Milestone 1)

## Summary

| Milestone                    | Status                                    |
| ---------------------------- | ----------------------------------------- |
| M0 Repository & architecture | ✅ Complete                               |
| M1 Application foundation    | ✅ Complete (all acceptance criteria met) |
| M2 Inventory MVP             | ⏭ Next                                    |
| M3 – M8                      | Not started                               |

## M1 — Delivered

| Area                | What works                                                                                                                                                                                                                        | Where                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Database            | Identity, tenancy, RBAC, sites, invitations, audit, idempotency, rate-limit tables; composite tenant FKs; CHECK constraints; append-only audit trigger; row-level security on all tenant tables                                   | `prisma/schema.prisma`, `prisma/migrations/`                      |
| Authentication      | Email/password sign-up and sign-in (Better Auth, scrypt hashes), DB sessions (7 days), sign-out, disabled users blocked, safe `next` redirects, rate limits (sign-in 5/min per IP+email, sign-up 10/h per IP, all auth endpoints) | `src/server/auth/`, `src/app/(auth)/`                             |
| Organizations       | Sign-up creates org + 9 system roles + Owner membership; additional orgs; org switcher; settings (name, time zone, default language; base currency fixed)                                                                         | `src/modules/organizations/`                                      |
| Members             | Invitations by single-use link (hashed token, 7-day expiry, email must match); grant/revoke roles at org/branch/warehouse scope; remove members; last-owner protection under concurrency; only owners manage ownership            | `src/modules/members/`                                            |
| Roles & permissions | Permission catalogue in code; system role templates; custom roles; Owner immutable; scope-aware `hasPermission` / list filtering                                                                                                  | `src/modules/access/`                                             |
| Tenant isolation    | `requireTenant` (404 for non-members), tenant-filtered services, RLS via `withTenantTx`, composite FKs                                                                                                                            | `src/modules/tenancy/`, `src/server/db/transactions.ts`           |
| Sites               | Branches, warehouses, storage locations: create/edit/archive/restore, search, status filter, pagination, scope-aware visibility, archive rules, idempotent creation                                                               | `src/modules/sites/`, `src/app/o/[orgSlug]/{branches,warehouses}` |
| Audit               | Events written in the same transaction for org, branch, warehouse, location, role, membership and invitation changes; filterable audit log page                                                                                   | `src/modules/audit/`                                              |
| Localization        | Arabic/English, RTL/LTR, persisted per user, localized validation and errors, catalog parity test                                                                                                                                 | `src/i18n/`                                                       |
| UI shell            | Responsive layout (sidebar / mobile menu), permission-aware navigation, empty/error/404 states, accessible forms (labels, `aria-invalid`, focus styles), pending-disabled submit buttons, confirmations for destructive actions   | `src/components/`, `src/app/o/[orgSlug]/layout.tsx`               |
| Operations          | Request IDs (proxy) in logs; trusted client-IP derivation; health checks; Docker image; dev seed with `[DEMO]` data                                                                                                               | `src/proxy.ts`, `prisma/seed.ts`                                  |

## Check results at end of M1 (clean install)

| Command                 | Result                                                         |
| ----------------------- | -------------------------------------------------------------- |
| `pnpm format:check`     | pass                                                           |
| `pnpm lint`             | pass (0 warnings)                                              |
| `pnpm typecheck`        | pass                                                           |
| `pnpm test`             | 11 files, 67 tests pass                                        |
| `pnpm test:integration` | 6 files, 49 tests pass (PostgreSQL 16)                         |
| `pnpm build`            | pass (23 routes, all dynamic)                                  |
| `pnpm test:e2e`         | 14 tests pass (13 desktop Chromium + 1 mobile viewport)        |
| `docker build` + run    | image serves health (200), sign-in (200), Arabic RTL rendering |
| `pnpm db:seed`          | creates two `[DEMO]` orgs; re-running skips them               |

Screens were also checked visually in English and Arabic (desktop and
mobile). That review found and fixed:

- table row borders missing in the last column;
- Latin codes aligned to the wrong side in RTL;
- the invite form preselecting the Owner role (now requires an explicit choice);
- a wrapping mobile menu label.

## Known limitations

- **No email delivery** (Q-10): invitations are shared as links; there is no
  self-service password reset yet. An owner cannot reset another user's
  password either.
- **No email verification** at sign-up (depends on Q-10).
- The CI workflow has not yet run on GitHub (it runs on pushes/PRs to `main`).
- `docker compose` itself was not exercised in the build sandbox (PostgreSQL
  ran natively); the Docker image was verified with a sandbox-only CA
  certificate added to a scratch copy of the Dockerfile.
- `idempotency_keys` and `rate_limit_buckets` are not yet cleaned up
  automatically (planned with background jobs, ADR-008).
- Editing has no optimistic-concurrency check yet: of two simultaneous edits
  to the same branch, the last one wins (each is audited). An `updatedAt`
  version check should be added before M2 documents with posting workflows.
- Prisma blocks `migrate reset` when run by an AI agent without the user's
  consent, so the test suites are written to need no resets. Local
  `prisma migrate dev` may wait on an interactive prompt in non-interactive
  shells; use `migrate dev --create-only` + `migrate deploy` there.

## Not started

M2–M8 (see PROJECT_PLAN.md).
