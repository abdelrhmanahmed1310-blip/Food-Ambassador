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

### ADR-006 Tenant isolation layers — Proposed (decide during M1)

1. **Accepted**: application-layer enforcement — TenantContext required by
   every service/repository, org resolved from server-side membership.
2. **Accepted**: composite `(organization_id, id)` foreign keys so cross-tenant
   references are impossible in the database.
3. **Proposed**: PostgreSQL row-level security as a third layer. Requires the
   app to connect as a non-owner role and to set `app.organization_id` with
   `set_config(..., true)` inside each transaction (Prisma client extension).
   An M1 spike will measure complexity and performance; if it works cleanly
   we adopt it before Milestone 2 creates most tenant tables.

### ADR-007 Authentication library — Proposed (confirm before M1)

**Better Auth** (1.7.x; maintained; supports Next 16 and Prisma 7) for
email/password sign-in, database sessions in httpOnly cookies, password
hashing, rate limiting, and later SSO/2FA. We use only its authentication
features; organizations, memberships and RBAC are our own tables (its
organization plugin is not used) so tenancy rules stay under our control.
Alternative considered: Auth.js v5 — still published as beta.

### ADR-008 Background jobs — Proposed (decide when first needed)

PostgreSQL-backed job table + worker process from the same codebase before
introducing Redis/queues.

### ADR-009 Identifiers — Accepted (M0 design)

UUIDv7 primary keys; per-org human-readable document numbers.

### ADR-010 Tenant addressing in URLs — Proposed (M1)

Path-based: `/o/{orgSlug}/...`. Supports users in multiple organizations,
bookmarkable links and simple deployment (no wildcard DNS/TLS). Subdomains can
be added later as an alias.

### ADR-011 Locale handling — Proposed (M1)

`next-intl`; locale from user preference cookie/profile (not URL prefix);
Arabic RTL via `dir="rtl"` and logical CSS properties.

---

## Business assumptions (recorded, not invented rules)

| ID   | Assumption                                                                                                                                                                                                                                    | Status                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A-01 | One organization = one customer legal/commercial entity; branches and warehouses belong to exactly one organization.                                                                                                                          | Proposed               |
| A-02 | A user can belong to several organizations with different roles.                                                                                                                                                                              | Proposed               |
| A-03 | Self-service sign-up creates a new organization with the signer as Owner; joining an existing org is by invitation only.                                                                                                                      | Proposed               |
| A-04 | One base currency per organization; no multi-currency documents in the MVP.                                                                                                                                                                   | Proposed               |
| A-05 | Stock is owned at warehouse level; storage locations are optional sub-divisions.                                                                                                                                                              | Proposed               |
| A-06 | Negative stock is never allowed in the MVP.                                                                                                                                                                                                   | Accepted (requirement) |
| A-07 | Expiry is evaluated against the calendar date in the branch's time zone; stock expiring today is still usable today.                                                                                                                          | Proposed               |
| A-08 | Inventory in transit between branches is held in a per-organization transit warehouse.                                                                                                                                                        | Proposed               |
| A-09 | Nutrition values and allergen absence are never inferred; missing data is shown as unknown.                                                                                                                                                   | Accepted (requirement) |
| A-10 | Initial suggested roles (Owner, Administrator, Operations Manager, Procurement, Warehouse, Food Safety/Quality, Finance, Branch Manager, Read-only Analyst) are system templates per organization; permission sets are editable except Owner. | Proposed               |

## Open questions

| ID   | Question                                                                                                                                                                                                                                                 | Needed by             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Q-01 | **Inventory valuation method**: moving weighted average per product × warehouse, or FIFO/specific lot cost? (Affects landed cost, COGS, recipe costing.) Proposed default: moving weighted average, with each lot's receipt cost retained for reference. | M3                    |
| Q-02 | Target launch markets (e.g. Egypt, KSA, UAE)? Determines allergen lists, label rules, tax (VAT) handling, data residency, and default currency/time zone.                                                                                                | M5 (labels), M7 (tax) |
| Q-03 | Hosting provider and region / data-residency requirements.                                                                                                                                                                                               | M8 (pilot)            |
| Q-04 | Purchase approval policy: single approver above an amount threshold, or multi-level?                                                                                                                                                                     | M3                    |
| Q-05 | Are foreign-currency supplier invoices needed for the pilot?                                                                                                                                                                                             | M3                    |
| Q-06 | Which POS / accounting systems do pilot customers use (for import formats and exports)?                                                                                                                                                                  | M7                    |
| Q-07 | Is SSO (Google/Microsoft) or 2FA required for the pilot?                                                                                                                                                                                                 | M1 (nice to know)     |
| Q-08 | Attachment retention period and maximum file size.                                                                                                                                                                                                       | M6                    |
| Q-09 | Over-receipt tolerance default (e.g. 0% or 5%)?                                                                                                                                                                                                          | M3                    |
