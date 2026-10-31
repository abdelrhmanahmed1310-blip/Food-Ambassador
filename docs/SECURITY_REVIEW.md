# Security review — before the pilot (M8c, 2026-10-31)

Scope: the application as of Milestone 8 (tenancy, authorization, data
handling, files, headers, dependencies, operations). Method: code search and
the automated test suites; no external penetration test yet.

## Controls in place (with their tests)

| Area                 | Control                                                                                                                                                                                                                                                                            | Evidence                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Tenant isolation     | Every tenant query runs as `fa_tenant` with row-level security on `organization_id`; ids from the client are never trusted for tenancy                                                                                                                                             | `tenancy/isolation.int.test.ts`, `pnpm db:verify`, cross-tenant cases in every module's tests |
| Authorization        | Services check permissions (scoped to branch/warehouse where the permission allows it); pages hide what services refuse                                                                                                                                                            | per-module `*.int.test.ts` permission cases                                                   |
| Separation of duties | Second person for PO approval, invoice exceptions, nutrition/allergen verification, label approval, corrective-action verification                                                                                                                                                 | integration tests per rule; database CHECKs (approver ≠ author)                               |
| Append-only records  | Ledger, audit events, declarations, profiles, settlements, labels: triggers allow only the documented transitions                                                                                                                                                                  | tests updating rows directly are refused                                                      |
| Authentication       | Better Auth sessions, rate-limited sign-in/up per IP, secure cookies when `APP_URL` is https, no self-service password reset (Q-10)                                                                                                                                                | `server/auth/auth.int.test.ts`, E2E forged-cookie test                                        |
| Input                | Zod on every action; decimals as strings; CSV formula injection neutralized; upload size limits (900 KB)                                                                                                                                                                           | unit tests (`csv`, `decimal`)                                                                 |
| SQL                  | Prisma or tagged-template raw SQL (parameterized); the only unsafe calls are constant statements                                                                                                                                                                                   | code search (below)                                                                           |
| Secrets              | No secrets in the repository; `.env*` ignored except `.env.example` with placeholders; logs redact secret-like keys                                                                                                                                                                | code search, `logger` unit test                                                               |
| Integrations         | Connector secrets encrypted (AES-256-GCM), shown once, never logged; HMAC signatures with a 5-minute window; idempotency keys; inbound acts with its creator's current permissions; outbound https-only with private addresses refused at save and at connect time (DNS rebinding) | `integrations/*.test.ts`, `integrations.int.test.ts`, E2E `integrations.spec.ts`              |
| Dependencies         | `pnpm audit --prod`: no known vulnerabilities (2026-10-31)                                                                                                                                                                                                                         | —                                                                                             |

## Findings and status

| #   | Finding                                                                                                                                        | Severity | Status                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `listRoles`, `getTaxSetup`, `getOrganizationSettings` relied on page checks only (any member could call them through another code path)        | Low      | Fixed: service checks + `access/service-guards.int.test.ts`                                                                                                                                    |
| 2   | No Content-Security-Policy; no HSTS                                                                                                            | Low      | Partly fixed: `frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` and HSTS in production. Script sources are not restricted yet (needs per-request nonces) — open |
| 3   | No restore procedure had been exercised                                                                                                        | Medium   | Fixed: backup/restore scripts with checksum and empty-target checks; drill done (docs/OPERATIONS.md)                                                                                           |
| 4   | No self-service password reset or 2FA                                                                                                          | Medium   | Open — needs the e-mail provider (Q-10) and a 2FA decision (Q-07)                                                                                                                              |
| 5   | Backups contain every tenant's data                                                                                                            | Medium   | Procedure: encrypted, access-limited storage (docs/OPERATIONS.md §3); depends on the hosting choice (Q-03)                                                                                     |
| 6   | Single-tenant restore is not possible                                                                                                          | Low      | Accepted; documented manual procedure                                                                                                                                                          |
| 7   | Outbound webhook URL check and connection resolved DNS separately; a pooled keep-alive socket also skipped the check (found while testing M10) | Medium   | Fixed before release: address checked in the connect-time lookup, connection reuse off; unit test `integrations/http.test.ts`                                                                  |

## Checks used

- Raw SQL: `grep -rn "queryRawUnsafe\|executeRawUnsafe" src` → only
  `SET LOCAL ROLE fa_tenant` and test-only statements.
- Server actions: every `"use server"` file goes through `tenantMutation`
  (resolves the tenant from the session), except sign-in/up/out.
- Route handlers: every tenant route uses `tenantForRoute`; the health
  routes expose only status.
- Exported module functions taking a tenant context were listed and each
  checked for a permission check or a guarded inner call (finding 1).

Before go-live: an external penetration test, CSP script-source nonces,
password reset and 2FA, and a hosting/data-residency decision (Q-03).
