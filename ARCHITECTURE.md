# Food Ambassador — Architecture

## 1. Shape of the system

A **modular monolith**: one Next.js application and one PostgreSQL database,
with business logic split into domain modules that have explicit public
interfaces. No microservices until a measured need exists (ADR-001).

```
Browser ──HTTPS──> Next.js (App Router, Node runtime)
                    ├─ app/            routes: pages, layouts, server actions, /api/v1 route handlers
                    │    (thin: parse input → call module service → render/serialize)
                    ├─ modules/<domain>/   business rules, services, repositories, schemas
                    ├─ server/         shared infrastructure (db, env, logger, errors, auth, tenancy, audit)
                    └─ lib/            pure, framework-free helpers (decimal, dates, units)
                              │
                              ▼
                        PostgreSQL 16 (Prisma 7 + node-postgres driver adapter)
```

## 2. Directory structure

```
.
├─ prisma/
│  ├─ schema.prisma            # models, added milestone by milestone
│  ├─ migrations/              # committed SQL migrations (incl. triggers, CK, partial indexes)
│  └─ seed.ts                  # development-only demo seed (Milestone 1)
├─ src/
│  ├─ app/                     # Next.js routes only — no business rules here
│  │  ├─ (auth)/               # sign-in, sign-up, invitation acceptance           [M1]
│  │  ├─ o/[orgSlug]/          # tenant-scoped application shell and pages          [M1]
│  │  └─ api/
│  │     ├─ health/            # liveness + readiness                               [M0]
│  │     └─ v1/                # versioned REST API for integrations                [M2+]
│  ├─ modules/                 # one folder per business domain                     [M1+]
│  │  ├─ organizations/  access/  branches/  warehouses/
│  │  ├─ catalog/  units/  inventory/  suppliers/  procurement/  receiving/
│  │  ├─ recipes/  food-costing/  nutrition/  food-safety/  traceability/
│  │  ├─ sales/  invoicing/  analytics/  notifications/  audit/
│  │  └─ <domain>/
│  │     ├─ index.ts           # the module's public API (only import from here)
│  │     ├─ service.ts         # use cases; transactions; authorization calls
│  │     ├─ repository.ts      # tenant-scoped data access
│  │     ├─ schemas.ts         # Zod input schemas
│  │     ├─ rules.ts           # pure business rules (unit-tested without a DB)
│  │     └─ *.test.ts / *.int.test.ts
│  ├─ server/                  # shared server infrastructure
│  │  ├─ db/                   # Prisma client, probes, transaction helpers          [M0]
│  │  ├─ env.ts  logger.ts  errors.ts  health.ts                                     [M0]
│  │  ├─ auth/                 # session → identity                                  [M1]
│  │  ├─ tenancy/              # TenantContext resolution, scoped db access          [M1]
│  │  └─ audit/                # audit event writer                                  [M1]
│  ├─ lib/                     # pure helpers safe for client and server (decimal)   [M0]
│  ├─ components/              # shared UI components                               [M1]
│  ├─ i18n/                    # messages/ar.json, messages/en.json, config          [M1]
│  └─ generated/prisma/        # generated client (git-ignored)
├─ test/support/               # test setup helpers
└─ tests/e2e/                  # Playwright journeys
```

### Module boundary rules

1. Routes and UI call **module services**, never Prisma directly.
2. A module imports another module only through its `index.ts`.
   No cycles; a module that needs to react to another's events gets an
   explicit function call from the owner (e.g. receiving calls
   `inventory.post(...)`), not a hidden coupling.
3. **Only the `inventory` module writes ledger entries and balances.**
   Receiving, transfers, production and sales post stock by calling it.
4. Pure rules (`rules.ts`, `src/lib`) have no I/O and are unit-tested exhaustively;
   services orchestrate I/O and are integration-tested against PostgreSQL.

## 3. Request lifecycle and security

```
request
  → proxy.ts            coarse gate: unauthenticated users redirected from /o/* (UX only, not security)
  → route / action      parse & validate input with Zod (server-side, always)
  → requireTenant()     session → user → ACTIVE membership in org resolved from URL slug
  → authorize()         permission + scope check against the TenantContext
  → service             business rules, single DB transaction, audit event
  → response            typed result or AppError → localized message
```

- **Tenant resolution**: the org is identified by the URL slug, but access is
  granted only by looking up the authenticated user's active membership in that
  org on the server. A client-supplied organization ID is never trusted by itself.
- **TenantContext** `{ organizationId, userId, membershipId, grants }` is an
  explicit argument to every service function. Repositories require it and add
  `organization_id` to every `where`, `create` and `update`.
- **Lookups by ID** always include the tenant (`where: { organizationId, id }`);
  a miss returns `NOT_FOUND` whether the record is absent or belongs to another
  tenant (no existence disclosure / IDOR).
- **Defence in depth** at the database: composite tenant foreign keys
  (DATA_MODEL.md §1.2) and, pending the M1 spike, PostgreSQL row-level
  security (ADR-006).
- **Authorization is server-side**. UI hides actions the user cannot perform
  for usability only.
- **Mutations** are protected against duplicate submission by idempotency keys
  and conditional status transitions (DATA_MODEL.md §4).
- **Audit**: important actions write an `audit_events` row in the same
  transaction as the change.
- **Secrets** only via environment variables, validated by `server/env.ts`,
  never logged (logger redacts sensitive keys), never committed.
- **Errors** returned to clients carry a stable code and safe message; internal
  details go to server logs only (`toErrorBody`).

## 4. Rendering and caching

- Server Components by default; Client Components only for interactivity.
- Next.js Cache Components is **disabled** (ADR-004). Authenticated pages are
  rendered dynamically per request. Any future caching of tenant data must key
  on `organizationId` explicitly and be reviewed for leakage.
- Mutations use Server Actions for the web UI and `/api/v1` route handlers for
  integrations; both call the same services.

## 5. Localization

- Arabic (`ar`, RTL) and English (`en`, LTR), using `next-intl` (compatible with
  Next 16). Locale comes from the user's preference (cookie/profile), not the
  URL, to keep tenant URLs stable.
- `<html lang dir>` set from the active locale; layouts use logical CSS
  properties (`ms-*`, `pe-*`, `start/end`) so RTL works without forks.
- Numbers, currency and dates formatted with `Intl` in the active locale;
  stored values are locale-independent.
- Bilingual master data (`name_en`, `name_ar`) where users see it.

## 6. Observability and operations

- Structured JSON logs (`server/logger.ts`) with redaction; a request ID is
  bound per request from M1.
- `/api/health` (liveness, no dependencies) and `/api/health/ready`
  (readiness, checks PostgreSQL; returns 503 without leaking error details).
- Docker image built from `Dockerfile` (standalone Next.js server, non-root
  user, container HEALTHCHECK).
- CI (`.github/workflows/ci.yml`): format, lint, typecheck, unit tests,
  integration tests against PostgreSQL, production build, Playwright E2E.

## 7. Background work

None in M0–M1. When needed (CSV imports, notifications, scheduled expiry
alerts) the first choice is a PostgreSQL-backed job table processed by a
worker process from the same codebase, avoiding new infrastructure (ADR-008,
proposed).

## 8. Testing strategy

| Layer       | Tool       | Location               | Runs against                          |
| ----------- | ---------- | ---------------------- | ------------------------------------- |
| Unit        | Vitest     | `src/**/*.test.ts`     | pure functions                        |
| Integration | Vitest     | `src/**/*.int.test.ts` | real PostgreSQL (`TEST_DATABASE_URL`) |
| End-to-end  | Playwright | `tests/e2e/*.spec.ts`  | production build                      |

Every module that touches tenant data ships cross-tenant tests: a user of org A
attempting to read/modify org B's resource by ID must get `NOT_FOUND`/`FORBIDDEN`
and no data change.
