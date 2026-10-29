# Food Ambassador — Implementation Status

Last updated: 2026-10-29 (end of Milestone 0)

## Summary

| Milestone                    | Status                                           |
| ---------------------------- | ------------------------------------------------ |
| M0 Repository & architecture | ✅ Complete                                      |
| M1 Application foundation    | ⏭ Next (awaiting confirmation of ADR-007 / A-03) |
| M2 – M8                      | Not started                                      |

No business features exist yet. The application serves a placeholder home
page and health endpoints only.

## M0 — Completed

| Item                                                                            | Where                                                      | Verified by                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| Next.js 16.4 + React 19.3 + TS strict + Tailwind 4 scaffold                     | `src/app`, `next.config.ts`                                | `pnpm build`                                 |
| Security headers, `X-Powered-By` removed                                        | `next.config.ts`                                           | E2E `security headers are set`               |
| Cache Components disabled (ADR-004)                                             | `next.config.ts`                                           | review                                       |
| Prisma 7 + pg driver adapter, singleton client                                  | `prisma/`, `prisma.config.ts`, `src/server/db/client.ts`   | integration tests                            |
| Validated, lazily-parsed environment                                            | `src/server/env.ts`                                        | `env.test.ts`                                |
| Structured JSON logger with secret redaction                                    | `src/server/logger.ts`                                     | `logger.test.ts`                             |
| Typed application errors, safe error bodies                                     | `src/server/errors.ts`                                     | `errors.test.ts`                             |
| Decimal arithmetic, rounding, proportional allocation, Zod decimal schema       | `src/lib/decimal.ts`                                       | `decimal.test.ts`                            |
| Liveness `/api/health`, readiness `/api/health/ready` (503 on failure, no leak) | `src/app/api/health`, `src/server/health.ts`               | unit + integration + E2E + Docker run        |
| Test harness: unit, integration (real PostgreSQL, auto-migrate), E2E            | `vitest.config.ts`, `playwright.config.ts`, `test/support` | all suites pass                              |
| Docker Compose for PostgreSQL (dev + test DBs)                                  | `docker-compose.yml`                                       | — (see limitations)                          |
| Production Dockerfile (standalone, non-root, HEALTHCHECK)                       | `Dockerfile`                                               | image built and run locally                  |
| CI workflow                                                                     | `.github/workflows/ci.yml`                                 | not yet executed on GitHub (see limitations) |
| Planning and design docs                                                        | `*.md`                                                     | —                                            |

## Check results at end of M0

| Command                 | Result                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm format:check`     | pass                                                                                      |
| `pnpm lint`             | pass (0 warnings)                                                                         |
| `pnpm typecheck`        | pass                                                                                      |
| `pnpm test`             | 5 files, 33 tests pass                                                                    |
| `pnpm test:integration` | 1 file, 3 tests pass (PostgreSQL 16)                                                      |
| `pnpm build`            | pass                                                                                      |
| `pnpm test:e2e`         | 4 tests pass (Chromium)                                                                   |
| `docker build` + run    | image serves `/api/health` 200; `/api/health/ready` 200 with DB, 503 with bad credentials |

## Known limitations

- The CI workflow has not run on GitHub yet; it will run on the first push/PR.
- `docker compose` was not exercised in the build environment (PostgreSQL was
  run natively there); the compose file uses the official `postgres:16-alpine`
  image and an init script for the test database.
- The Docker image was verified with an added CA certificate required by the
  build sandbox's network proxy; the committed `Dockerfile` does not include it
  and needs no changes for normal networks.
- No migrations exist yet; the first arrives with Milestone 1.
- UI is English-only until Milestone 1 delivers localization.

## Not started

Everything in M1–M8 (see PROJECT_PLAN.md).
