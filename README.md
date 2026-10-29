# Food Ambassador

Multi-tenant SaaS for end-to-end food operations: procurement, receiving,
inventory, recipes and food cost, nutrition and allergens, food safety,
traceability, sales/invoice workflows and analytics.

> **Status:** Milestone 0 (foundation) complete. No business features yet —
> see [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) and
> [PROJECT_PLAN.md](PROJECT_PLAN.md).

| Document                                             | Contents                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| [PROJECT_PLAN.md](PROJECT_PLAN.md)                   | Milestones, dependencies, acceptance criteria, backlog, risks |
| [ARCHITECTURE.md](ARCHITECTURE.md)                   | Module boundaries, security model, structure                  |
| [DATA_MODEL.md](DATA_MODEL.md)                       | Entities, constraints, inventory invariants, formulas         |
| [DECISIONS.md](DECISIONS.md)                         | ADRs, assumptions, open questions                             |
| [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) | What is done, in progress and not started                     |

## Requirements

- Node.js 22 (`.nvmrc`) and pnpm 10 (`corepack enable`)
- PostgreSQL 16 — via Docker Compose (below) or a local installation

## Getting started

```bash
corepack enable
pnpm install                 # also generates the Prisma client
cp .env.example .env         # placeholder values work with docker compose
docker compose up -d         # PostgreSQL with dev + test databases
pnpm db:deploy               # apply migrations (none until Milestone 1)
pnpm dev                     # http://localhost:3000
```

Check it is running: `curl localhost:3000/api/health` and
`curl localhost:3000/api/health/ready`.

Using a local PostgreSQL instead of Docker: create a role and the two
databases named in `.env` (`food_ambassador`, `food_ambassador_test`).

## Commands

| Command                        | Purpose                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `pnpm dev`                     | Development server                                                               |
| `pnpm build` / `start`         | Production build / serve it                                                      |
| `pnpm lint`                    | ESLint (zero warnings allowed)                                                   |
| `pnpm format` / `format:check` | Prettier write / verify                                                          |
| `pnpm typecheck`               | Next route typegen + `tsc --noEmit`                                              |
| `pnpm test`                    | Unit tests (Vitest)                                                              |
| `pnpm test:integration`        | Integration tests against `TEST_DATABASE_URL` (migrations applied automatically) |
| `pnpm test:e2e`                | Playwright tests against the production build (run `pnpm build` first)           |
| `pnpm check`                   | format:check + lint + typecheck + unit tests + build                             |
| `pnpm db:generate`             | Regenerate the Prisma client                                                     |
| `pnpm db:migrate`              | Create/apply a migration in development                                          |
| `pnpm db:deploy`               | Apply committed migrations (CI/production)                                       |

## Environment variables

See [.env.example](.env.example). Never commit `.env` files or real secrets.

| Variable            | Required | Description                                             |
| ------------------- | -------- | ------------------------------------------------------- |
| `DATABASE_URL`      | yes      | PostgreSQL connection string for the app and Prisma CLI |
| `TEST_DATABASE_URL` | tests    | Separate disposable database for integration tests      |
| `LOG_LEVEL`         | no       | `fatal` · `error` · `warn` · `info` (default) · `debug` |
| `APP_URL`           | no       | Public base URL (default `http://localhost:3000`)       |

## Deployment

The `Dockerfile` builds a standalone Next.js server running as a non-root user
with a container health check:

```bash
docker build -t food-ambassador .
docker run -p 3000:3000 -e DATABASE_URL=postgresql://... food-ambassador
```

Run `pnpm db:deploy` (with `DATABASE_URL` set) against the target database
before starting a new version. Use `/api/health` for liveness and
`/api/health/ready` for readiness probes.

## Project structure

```
prisma/            schema and migrations
src/app/           Next.js routes (thin; no business rules)
src/modules/       business domains (from Milestone 1)
src/server/        shared server infrastructure: db, env, logger, errors, health
src/lib/           pure helpers (decimal arithmetic)
test/support/      test setup
tests/e2e/         Playwright tests
```
