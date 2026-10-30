# Food Ambassador

Multi-tenant SaaS for end-to-end food operations: procurement, receiving,
inventory, recipes and food cost, nutrition and allergens, food safety,
traceability, point of sale, sales/invoice workflows and analytics.

> **Status:** Milestones 0–4 and 6 complete, M7 in progress — on top of the M1
> foundation (sign-in, organizations, roles, sites, audit, Arabic/English):
> products, units and conversions, lots and expiry, an append-only stock
> ledger, opening balances, adjustments, write-offs, transfers, quarantine and
> release, reversals, stock counts, FEFO, dashboard, CSV import/export.
> Milestone 3 added **stock valuation** (moving weighted average) and
> **purchasing**: suppliers, branch requisitions, purchase orders with an
> optional approval limit, receiving with rejections, quarantine, lots and
> temperatures, landed cost, reorder levels with suggested orders, and
> shipments between warehouses with an in-transit stage. Recipes and food
> cost (M4): recipes and sub-recipes with versions, waste, yields and costs
> from stock averages, purchase prices or standard costs with stored cost
> history; selling prices, food cost targets and report, price simulator,
> bulk ingredient replacement and printable recipe cards. Milestone 6 adds
> lot traceability with gap reporting and recalls (simulation, live hold in
> every warehouse, disposal or release), temperature and hygiene records
> against limits, checklists, and non-conformances with corrective actions
> verified by a second person. Milestone 7 adds sales import from CSV that
> uses up stock through recipes (first-expiring lots first, cost of sales)
> and a VAT setup for Saudi Arabia, Egypt and the GCC (dated rates, VAT per
> sale line, net prices in food cost). See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

| Document                                                   | Contents                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| [PROJECT_PLAN.md](PROJECT_PLAN.md)                         | Milestones, dependencies, acceptance criteria, backlog, risks |
| [ARCHITECTURE.md](ARCHITECTURE.md)                         | Module boundaries, security model, structure                  |
| [DATA_MODEL.md](DATA_MODEL.md)                             | Entities, constraints, inventory invariants, formulas         |
| [DECISIONS.md](DECISIONS.md)                               | ADRs, assumptions, open questions                             |
| [docs/SUPY_FEATURE_MAP.md](docs/SUPY_FEATURE_MAP.md)       | Supy capability review and gap analysis                       |
| [docs/FOODICS_FEATURE_MAP.md](docs/FOODICS_FEATURE_MAP.md) | Foodics capability review and POS scope                       |
| [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)       | What is done, in progress and not started                     |

## Requirements

- Node.js 22 (`.nvmrc`) and pnpm 10 (`corepack enable`)
- PostgreSQL 16 — via Docker Compose (below) or a local installation

## Getting started

```bash
corepack enable
pnpm install                 # also generates the Prisma client
cp .env.example .env         # then set AUTH_SECRET (openssl rand -base64 48)
docker compose up -d         # PostgreSQL with dev + test databases
pnpm db:deploy               # apply migrations
pnpm db:seed                 # optional: [DEMO] organizations and users
pnpm dev                     # http://localhost:3000
```

Sign up at `/sign-up` to create your own organization, or sign in with a seeded
demo account. All demo accounts use the password `demo-password-123` (override
with `SEED_PASSWORD` when seeding):

| Email                    | Organization         | Role                                 |
| ------------------------ | -------------------- | ------------------------------------ |
| `owner@nile.demo.test`   | [DEMO] Nile Kitchens | Owner                                |
| `manager@nile.demo.test` | [DEMO] Nile Kitchens | Branch Manager (Cairo Downtown only) |
| `analyst@nile.demo.test` | [DEMO] Nile Kitchens | Read-only Analyst                    |
| `owner@gulf.demo.test`   | [DEMO] Gulf Catering | Owner                                |
| `admin@gulf.demo.test`   | [DEMO] Gulf Catering | Administrator                        |

Each demo organization also gets three `[DEMO]` products and opening stock,
including an expired and a soon-expiring milk lot. The seed is idempotent and
refuses to run with `NODE_ENV=production`.

**Invitations** produce a one-time link that the inviter copies and shares; no
email is sent yet (DECISIONS.md ADR-012).

### Database role requirements

The first migration creates the `fa_tenant` role used for row-level security
and grants it to the role running the migration. Run migrations with **the
same database role the app connects with** (`DATABASE_URL`), and give that
role `CREATEROLE` for the first run (ADR-013). A local superuser works as is.

## Commands

| Command                        | Purpose                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `pnpm dev`                     | Development server                                                                       |
| `pnpm build` / `start`         | Production build / serve it                                                              |
| `pnpm lint`                    | ESLint (zero warnings allowed)                                                           |
| `pnpm format` / `format:check` | Prettier write / verify                                                                  |
| `pnpm typecheck`               | Next route typegen + `tsc --noEmit`                                                      |
| `pnpm test`                    | Unit tests (Vitest)                                                                      |
| `pnpm test:integration`        | Integration tests against `TEST_DATABASE_URL` (applies migrations first)                 |
| `pnpm test:e2e`                | Playwright against the production build and `TEST_DATABASE_URL` (run `pnpm build` first) |
| `pnpm check`                   | format:check + lint + typecheck + unit tests + build                                     |
| `pnpm db:generate`             | Regenerate the Prisma client                                                             |
| `pnpm db:migrate`              | Create/apply a migration in development                                                  |
| `pnpm db:deploy`               | Apply committed migrations (CI/production)                                               |
| `pnpm db:seed`                 | Insert [DEMO] data (development only, idempotent)                                        |

Integration and E2E tests create uniquely named data and never reset the
database, so they can be re-run against the same test database.

## Environment variables

See [.env.example](.env.example). Never commit `.env` files or real secrets.

| Variable             | Required | Description                                                                                         |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | yes      | PostgreSQL connection for the app and the Prisma CLI                                                |
| `AUTH_SECRET`        | yes      | 32+ character secret for session signing                                                            |
| `APP_URL`            | prod     | Public base URL (default `http://localhost:3000`); used for auth origin checks and invitation links |
| `TRUSTED_PROXY_HOPS` | no       | Reverse proxies in front of the app (default `1`; `0` if exposed directly) — see ADR-014            |
| `TEST_DATABASE_URL`  | tests    | Separate database for integration/E2E tests                                                         |
| `LOG_LEVEL`          | no       | `fatal` · `error` · `warn` · `info` (default) · `debug`                                             |
| `SEED_PASSWORD`      | no       | Password for seeded demo users                                                                      |

## Deployment

The `Dockerfile` builds a standalone Next.js server running as a non-root user
with a container health check:

```bash
docker build -t food-ambassador .
docker run -p 3000:3000 \
  -e DATABASE_URL=postgresql://... -e AUTH_SECRET=... -e APP_URL=https://app.example.com \
  food-ambassador
```

Before starting a new version, run `pnpm db:deploy` from a checkout of the same
commit against the target database (the runtime image does not contain the
Prisma CLI). Serve over HTTPS so session cookies are marked `Secure`
(enabled automatically when `APP_URL` starts with `https://`). Use
`/api/health` for liveness and `/api/health/ready` for readiness probes.
