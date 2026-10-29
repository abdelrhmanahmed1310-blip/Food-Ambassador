# Food Ambassador — Decisions and Assumptions

Status values: **Accepted** (in effect), **Proposed** (default we will use
unless the product owner says otherwise), **Open** (needs an answer before the
milestone listed).

---

## Architecture decision records

### ADR-001 Modular monolith — Accepted (M0)

One Next.js app + one PostgreSQL database, organized by business domain with
enforced module boundaries (ARCHITECTURE.md §2). Rationale: strong
transactional consistency across inventory, procurement and finance is far
easier in one database; team size and load do not justify distributed systems.
Revisit if a module needs independent scaling or deployment.

### ADR-002 Stack and versions — Accepted (M0)

Node 22, pnpm 10, Next.js 16.4 (App Router, TypeScript strict), React 19.3,
Tailwind CSS 4, PostgreSQL 16, Prisma ORM **7.10** with `@prisma/adapter-pg`,
Zod 4, decimal.js, Vitest 5, Playwright 1.63. Exact versions are pinned in
`package.json` and the lockfile.

- Prisma 8 exists only as release candidates at the time of writing, so the
  latest stable major (7) was chosen. Upgrade when 8 is GA.
- Playwright is pinned to the version of the browsers available in the
  development/CI image.

### ADR-003 Decimal-only numerics — Accepted (M0)

`NUMERIC` columns and `decimal.js` for quantities, costs and money; JS numbers
are rejected for non-integers (`toDecimal`). Scales in DATA_MODEL.md §1.4.
Rounding: half-up, once, at persistence boundaries.

### ADR-004 Next.js Cache Components disabled — Accepted (M0)

The scaffold enabled `cacheComponents` and `partialPrefetching`. Both were
turned off: almost every page is per-tenant/per-user, and a mis-keyed shared
cache entry would be a cross-tenant leak. Dynamic rendering per request is the
safe default. Re-enable only with a documented caching policy and tests.

### ADR-005 Inventory as an append-only ledger with a locked projection — Accepted (M0 design, implemented M2)

Stock is never edited; it is the sum of immutable ledger entries. A
`stock_balances` projection is updated in the same transaction under row locks,
with CHECK constraints preventing negative stock and a deterministic
`posting_key` unique constraint preventing double posting. Corrections are
reversals/adjustments. Full rules in DATA_MODEL.md §4.

### ADR-006 Tenant isolation layers — Accepted (implemented M1)

1. **Application layer**: a `TenantContext` (resolved server-side from the
   session + an `ACTIVE` membership in the org named by the URL slug) is
   required by every service; every query filters by `organizationId`; lookups
   by ID that miss — including other tenants' IDs — return `NOT_FOUND`.
2. **Composite foreign keys** `(organization_id, x_id)` make cross-tenant
   references impossible even for code that bypasses RLS.
3. **PostgreSQL row-level security**: `withTenantTx` sets
   `app.organization_id` and `SET LOCAL ROLE fa_tenant` for the transaction;
   policies on all tenant tables restrict reads and writes to that org, and
   `fa_tenant` has no access to credentials/sessions. The M1 spike worked
   cleanly (one extra round-trip per transaction), so it was adopted.
   System operations (sign-up, invitation acceptance, membership lookup) use
   `withSystemTx` explicitly and filter by the authenticated user.

### ADR-007 Authentication library — Accepted (M1)

**Better Auth 1.7** for email/password sign-in, scrypt password hashing,
database sessions (7-day expiry, refreshed daily) in httpOnly cookies, and
rate limiting. Only its authentication features are used; organizations,
memberships and RBAC are our own tables. Sign-in/sign-up run as server actions
that call `auth.api` directly and apply the same rate limits as the HTTP
endpoints.

### ADR-008 Background jobs — Proposed (decide when first needed)

PostgreSQL-backed job table + worker process from the same codebase before
introducing Redis/queues.

### ADR-009 Identifiers — Accepted (M0 design)

UUIDv7 primary keys; per-org human-readable document numbers.

### ADR-010 Tenant addressing in URLs — Accepted (M1)

Path-based: `/o/{orgSlug}/...`. The slug only selects the organization; access
is granted by membership lookup on the server.

### ADR-011 Locale handling — Accepted (M1)

`next-intl` without locale routing. Locale = `fa_locale` cookie (set at
sign-in from the user profile and by the language switcher, which also saves
it to the profile), else the browser's Accept-Language, else English.
`<html lang dir>` follows the locale; layouts use logical CSS properties;
Latin values (codes, emails) are wrapped in `.ltr-value` inside Arabic text.

### ADR-012 Invitations by link, no email yet — Accepted (M1)

No email provider is configured, so an invitation produces a single-use link
(256-bit token, stored only as a SHA-256 hash, 7-day expiry) shown once to the
inviter to share. The accepting account's email must match the invitation.
Email delivery is Q-10.

### ADR-013 Database roles — Accepted (M1)

The app connects with one role that owns the schema and runs migrations
(`DATABASE_URL`). The first migration creates the NOLOGIN role `fa_tenant`
and grants it to the migrating role, which is what allows `SET LOCAL ROLE`.
Therefore **the role that runs migrations must be the role the app connects
with** (or be granted `fa_tenant` manually). The migrating role needs
`CREATEROLE` the first time (managed PostgreSQL services allow this).

### ADR-014 Client IP for rate limiting — Accepted (M1)

`X-Forwarded-For` is client-controlled except for entries appended by your
own proxies. `proxy.ts` takes the entry `TRUSTED_PROXY_HOPS` from the end,
overwrites the internal `x-client-ip` header with it, and both the auth
actions and Better Auth read only that header. Set `TRUSTED_PROXY_HOPS=0`
when the app is exposed directly (all clients then share one bucket — safe
but strict).

### ADR-015 Next.js server actions for UI mutations — Accepted (M1)

Forms post to server actions (CSRF-protected by Next's Origin check). Every
action re-resolves the TenantContext from the session and the URL slug —
never from hidden form fields — then calls the same service functions the
future `/api/v1` handlers will use. Creation forms send an idempotency key
generated per logical submission (reused on retry, discarded on success).

### ADR-016 Immediate transfers, no in-transit stage — Accepted (M2)

Transfers post TRANSFER_OUT and TRANSFER_IN in one transaction. This fits
transfers within a site and short same-day moves. Inter-branch transfers with
a dispatch/receive gap (stock "on the truck") need a transit stage — a
per-organization transit warehouse (A-08) with DISPATCHED → RECEIVED
documents — planned with M3 receiving. Until then, stock is never "lost"
between sites, but a transfer is assumed to arrive when posted.

### ADR-017 Stock count method — Accepted (M2)

Counts cover AVAILABLE stock. The system quantity is captured per line at the
moment it is counted and the adjustment is counted − that quantity, so
movements during a multi-hour count neither get lost nor double-counted, and
the warehouse need not be frozen. The UI shows the system quantity only after
a line is counted (blind count). Posting requires `inventory.count.approve`;
separation of counter and approver is supported by permissions but not
enforced as a rule.

### ADR-018 Permissions added by data migrations — Accepted (M2)

New permissions reach existing organizations through SQL data migrations,
while new organizations get them from `SYSTEM_ROLE_TEMPLATES`. A unit test
(`permission-migrations.test.ts`) fails if the two disagree. Customized
system roles keep their customizations; migrations only add.

### ADR-019 Monotonic UUIDv7 — Accepted (M2)

`uuidv7()` uses RFC 9562's 12-bit counter so IDs created in one process are
strictly increasing even within a millisecond. Document lines are ordered by
ID; random sub-millisecond ordering previously made a transfer's OUT/IN lines
appear in random order (caught by an intermittent test failure).

### ADR-020 Translation keys in validation — Accepted (M2)

All validation and business-rule errors (including decimal parsing and CSV
row errors) carry translation keys, never English sentences, so every message
is localized. Messages may use values from the error details (e.g.
`{available}` for INSUFFICIENT_STOCK).

---

## Business assumptions (recorded, not invented rules)

| ID   | Assumption                                                                                                                                                                                                                                    | Status                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A-01 | One organization = one customer legal/commercial entity; branches and warehouses belong to exactly one organization.                                                                                                                          | Proposed               |
| A-02 | A user can belong to several organizations with different roles.                                                                                                                                                                              | Accepted (M1)          |
| A-03 | Self-service sign-up creates a new organization with the signer as Owner; joining an existing org is by invitation only.                                                                                                                      | Accepted (M1)          |
| A-04 | One base currency per organization; no multi-currency documents in the MVP.                                                                                                                                                                   | Proposed               |
| A-05 | Stock is owned at warehouse level; storage locations are optional sub-divisions.                                                                                                                                                              | Proposed               |
| A-06 | Negative stock is never allowed in the MVP.                                                                                                                                                                                                   | Accepted (requirement) |
| A-07 | Expiry is evaluated against the calendar date in the branch's time zone; stock expiring today is still usable today.                                                                                                                          | Proposed               |
| A-08 | Inventory in transit between branches is held in a per-organization transit warehouse.                                                                                                                                                        | Proposed               |
| A-09 | Nutrition values and allergen absence are never inferred; missing data is shown as unknown.                                                                                                                                                   | Accepted (requirement) |
| A-10 | Initial suggested roles (Owner, Administrator, Operations Manager, Procurement, Warehouse, Food Safety/Quality, Finance, Branch Manager, Read-only Analyst) are system templates per organization; permission sets are editable except Owner. | Proposed               |

## Open questions

| ID   | Question                                                                                                                                                                                                                                                                                                                           | Needed by             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Q-01 | **Inventory valuation method** (still open after M2 — unit costs are recorded, no valuation is computed): moving weighted average per product × warehouse, or FIFO/specific lot cost? (Affects landed cost, COGS, recipe costing.) Proposed default: moving weighted average, with each lot's receipt cost retained for reference. | M3                    |
| Q-02 | Target launch markets (e.g. Egypt, KSA, UAE)? Determines allergen lists, label rules, tax (VAT) handling, data residency, and default currency/time zone.                                                                                                                                                                          | M5 (labels), M7 (tax) |
| Q-03 | Hosting provider and region / data-residency requirements.                                                                                                                                                                                                                                                                         | M8 (pilot)            |
| Q-04 | Purchase approval policy: single approver above an amount threshold, or multi-level?                                                                                                                                                                                                                                               | M3                    |
| Q-05 | Are foreign-currency supplier invoices needed for the pilot?                                                                                                                                                                                                                                                                       | M3                    |
| Q-06 | Which POS / accounting systems do pilot customers use (for import formats and exports)?                                                                                                                                                                                                                                            | M7                    |
| Q-07 | Is SSO (Google/Microsoft) or 2FA required for the pilot?                                                                                                                                                                                                                                                                           | M1 (nice to know)     |
| Q-08 | Attachment retention period and maximum file size.                                                                                                                                                                                                                                                                                 | M6                    |
| Q-09 | Over-receipt tolerance default (e.g. 0% or 5%)?                                                                                                                                                                                                                                                                                    | M3                    |
| Q-10 | Which email provider should send invitations, password resets and notifications? Until then there is **no self-service password reset**.                                                                                                                                                                                           | M2 (before pilot)     |
| Q-11 | Should base currency ever be changeable before any transactions exist? Currently fixed at creation.                                                                                                                                                                                                                                | M2                    |
| Q-12 | Should counting and approving a stock count require two different people (segregation of duties)? Currently allowed to be the same user.                                                                                                                                                                                           | M8 (pilot)            |
| Q-13 | Product categories: flat list or hierarchy, and are they needed for reporting in the pilot?                                                                                                                                                                                                                                        | M4                    |
| Q-14 | Scope versus Foodics: (A) back office that takes sales from existing POS systems — recommended; (B) A now, POS later; (C) build a full POS (cashier, payments, kitchen screen, online ordering, loyalty, ZATCA e-invoicing) now. See `docs/FOODICS_FEATURE_MAP.md`.                                                                | M4 (before menu work) |
