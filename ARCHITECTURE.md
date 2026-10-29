# Food Ambassador — Architecture

## 1. Shape of the system

A **modular monolith**: one Next.js application and one PostgreSQL database,
with business logic split into domain modules that have explicit public
functions. No microservices until a measured need exists (ADR-001).

```
Browser ──HTTPS──> Next.js 16 (App Router, Node runtime)
                    ├─ proxy.ts           request ID, trusted client IP, early sign-in redirect (UX only)
                    ├─ app/               routes: pages, layouts, server actions, route handlers
                    │    (thin: resolve TenantContext → call module service → render / map errors)
                    ├─ modules/<domain>/  business rules, services, Zod schemas
                    ├─ server/            shared infrastructure (db, auth, env, logger, errors, actions)
                    ├─ components/        UI (server components + small client components)
                    └─ lib/               pure helpers (decimal, uuid, client-ip, reference data)
                              │
                              ▼
                        PostgreSQL 16 (Prisma 7 + node-postgres adapter; RLS for tenant tables)
```

## 2. Directory structure (as of Milestone 1)

```
.
├─ prisma/
│  ├─ schema.prisma            # models (see DATA_MODEL.md)
│  ├─ migrations/              # SQL migrations incl. CHECKs, triggers, RLS policies
│  └─ seed.ts                  # development-only [DEMO] data
├─ src/
│  ├─ proxy.ts                 # Next.js proxy (formerly "middleware")
│  ├─ app/
│  │  ├─ (auth)/               # sign-in, sign-up + auth server actions
│  │  ├─ invite/[token]/       # invitation acceptance
│  │  ├─ organizations/new/    # create another organization
│  │  ├─ o/[orgSlug]/          # tenant shell + pages (overview, branches, warehouses, settings/*)
│  │  │  └─ **/actions.ts      # server actions per area
│  │  └─ api/
│  │     ├─ auth/[...all]/     # Better Auth HTTP endpoints
│  │     └─ health/            # liveness + readiness
│  ├─ modules/
│  │  ├─ access/               # permission catalogue, role templates, authorize(), roles service
│  │  ├─ audit/                # recordAudit(), audit log queries
│  │  ├─ members/              # memberships, invitations, role grants, last-owner rule
│  │  ├─ organizations/        # organization onboarding, settings, overview counts
│  │  ├─ sites/                # branches, warehouses, storage locations
│  │  ├─ tenancy/              # TenantContext resolution, requireTenant()
│  │  └─ shared/               # shared Zod schemas, idempotency helper
│  ├─ server/
│  │  ├─ db/                   # Prisma client, withTenantTx / withSystemTx, error helpers, probe
│  │  ├─ auth/                 # Better Auth config, session helpers
│  │  ├─ actions/              # form-action plumbing: error → localized state, tenantMutation()
│  │  ├─ env.ts  logger.ts  errors.ts  health.ts  rate-limit.ts  request.ts
│  ├─ components/              # ui/ primitives, forms/ (ActionForm & fields), shell/, sites/, settings/
│  ├─ i18n/                    # next-intl request config, messages/en.json, messages/ar.json
│  ├─ lib/                     # decimal, uuid, client-ip, reference data
│  └─ generated/prisma/        # generated client (git-ignored)
├─ test/support/               # Vitest setup and data factories
└─ tests/e2e/                  # Playwright journeys
```

Future domains (catalog, inventory, procurement, …) are added as new folders
under `src/modules/`.

### Module boundary rules

1. Routes, pages and actions call **module services**, never Prisma directly.
2. Services take a `TenantContext` as their first argument and do their own
   authorization; a page hiding a button is never the control.
3. Cross-module calls go through exported service functions; no cycles.
4. **Only the `inventory` module (M2) will write ledger entries and balances.**
5. Pure rules (`authorize.ts`, `src/lib/*`) are unit-tested; services are
   integration-tested against PostgreSQL.

## 3. Request lifecycle and security

```
request
  → proxy.ts         sets x-request-id and x-client-ip (from trusted XFF hops, ADR-014);
                     no session cookie on /o/* → redirect to /sign-in (UX only)
  → page / action    requireTenant(slug): session (Better Auth, DB-validated) → ACTIVE user
                     → ACTIVE membership in ACTIVE org → TenantContext with grants; else 404
  → service          Zod validation → authorize (permission + scope) → withTenantTx:
                       set_config('app.organization_id') + SET LOCAL ROLE fa_tenant (RLS)
                       → tenant-filtered queries → business rules → audit event → commit
  → action result    AppError → stable code → localized message / field errors (no internals)
```

Key properties (details in DECISIONS.md ADR-006, ADR-013 – ADR-015):

- **Tenant resolution** never trusts client input: the org comes from the URL
  slug, access from the user's membership; actions re-resolve it per request.
- **Lookups by ID** always include the tenant and the user's visible scope; a
  miss is `NOT_FOUND`, so other tenants' IDs reveal nothing (no IDOR).
- **Defence in depth**: application filters + composite tenant FKs + RLS.
- **System transactions** (`withSystemTx`) are reserved for sign-up,
  invitation lookup/acceptance and membership resolution.
- **Duplicate submissions**: idempotency keys on create forms and conditional
  state transitions (invitation acceptance).
- **Audit**: important changes write `audit_events` in the same transaction;
  the table is append-only at the database level.
- **Secrets**: environment only, validated by `server/env.ts`, redacted from
  logs, never committed. Passwords are never echoed back into forms.
- **Rate limiting**: sign-in (5/min per IP + email), sign-up (10/h per IP) and
  all Better Auth endpoints, via one atomic PostgreSQL counter table.

## 4. Rendering and caching

- Server Components by default; client components only for interactivity
  (forms, mobile menu, copy button).
- Next.js Cache Components is **disabled** (ADR-004). All tenant pages render
  dynamically per request; nothing tenant-specific is cached on the server.
- Mutations: server actions → `tenantMutation()` → service →
  `revalidatePath('/o/{slug}', 'layout')`.

## 5. Localization

- Arabic (`ar`, RTL) and English (`en`, LTR) with `next-intl`; locale from the
  user preference cookie/profile, not the URL (ADR-011).
- Messages live in `src/i18n/messages/*.json`; a unit test enforces identical
  keys and placeholders in both languages.
- Validation messages are translation keys in Zod schemas, translated when an
  action returns its state.
- Dates use `Intl` via next-intl, in the organization's time zone.

## 6. Observability and operations

- Structured JSON logs with redaction; failed actions log the request ID.
- `/api/health` (liveness) and `/api/health/ready` (database readiness, 503
  without leaking details).
- Docker image (standalone server, non-root, HEALTHCHECK). Migrations are run
  separately with `pnpm db:deploy` using the same database role as the app
  (ADR-013).
- CI: format, lint, typecheck, unit, integration (PostgreSQL), build, E2E.

## 7. Background work

None yet. First candidates: idempotency-key cleanup, email delivery (Q-10).
Plan: PostgreSQL-backed job table + worker process (ADR-008, proposed).

## 8. Testing strategy

| Layer       | Tool       | Location               | Runs against                          |
| ----------- | ---------- | ---------------------- | ------------------------------------- |
| Unit        | Vitest     | `src/**/*.test.ts`     | pure functions, message catalogs      |
| Integration | Vitest     | `src/**/*.int.test.ts` | real PostgreSQL (`TEST_DATABASE_URL`) |
| End-to-end  | Playwright | `tests/e2e/*.spec.ts`  | production build + test database      |

Integration and E2E tests never assume an empty database: each test creates
uniquely named data, so the suites can run repeatedly without resets.
Every entity that holds tenant data has cross-tenant tests
(`src/modules/tenancy/isolation.int.test.ts`), and a schema test fails if a
table with `organization_id` lacks an RLS policy.
