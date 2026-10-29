# Food Ambassador — Project Plan

Supplier → Procurement → Receiving & Quality → Inventory → Recipes & Production
→ Sales → Invoices & Settlements → Food Safety → Traceability → Analytics.

Delivery is one milestone at a time. A milestone is done only when its
acceptance criteria pass as automated tests and `pnpm check`,
`pnpm test:integration` and `pnpm test:e2e` are green.

## Milestone overview and dependencies

```
M0 Foundation repo ─► M1 Identity, tenancy, RBAC, i18n shell
                          │
                          ▼
                    M2 Inventory MVP ──────────────┐
                          │                        │
                          ▼                        ▼
                    M3 Procurement & receiving   M4 Recipes & food cost
                          │                        │
                          │                        ▼
                          │                  M5 Nutrition & allergens
                          ▼                        │
                    M6 Food safety & traceability ◄┘ (needs receipts + production links)
                          │
                          ▼
                    M7 Sales & finance (needs M3 receipts, M4 recipes)
                          │
                          ▼
                    M8 Analytics & pilot readiness
```

| #   | Milestone                   | Depends on                       | Status       |
| --- | --------------------------- | -------------------------------- | ------------ |
| M0  | Repository & architecture   | —                                | **Complete** |
| M1  | Application foundation      | M0                               | Next         |
| M2  | Inventory MVP               | M1                               | **Complete** |
| M3  | Procurement & receiving     | M2                               | Next         |
| M4  | Recipes & food cost         | M2 (M3 for purchase-based costs) | Not started  |
| M5  | Nutrition & allergens       | M4                               | Not started  |
| M6  | Food safety & traceability  | M2, M3, M4                       | Not started  |
| M7  | Sales & financial workflows | M3, M4                           | Not started  |
| M8  | Analytics & pilot readiness | M2–M7                            | Not started  |

---

## M0 — Repository and architecture ✅

Acceptance criteria (all met — see IMPLEMENTATION_STATUS.md):

- [x] Reproducible setup: `pnpm install`, PostgreSQL via `docker compose up -d`, `.env.example`.
- [x] Next.js + TypeScript strict + Tailwind app builds for production.
- [x] Prisma 7 configured against PostgreSQL; client generation in `postinstall`.
- [x] Lint, format, typecheck, unit, integration (real DB) and E2E commands exist and pass.
- [x] Health endpoints: liveness and DB readiness (503 on failure, no detail leakage).
- [x] Shared infrastructure: validated env, redacting structured logger, typed errors, decimal math.
- [x] CI workflow running all checks against a PostgreSQL service.
- [x] Production Docker image builds and serves health endpoints.
- [x] Architecture, data model, decisions, plan and status documents.

---

## M1 — Application foundation ✅

### Scope

1. Database: `users` + auth tables, `organizations`, `organization_memberships`,
   `roles`, `role_permissions`, `membership_roles`, `branches`, `warehouses`,
   `storage_locations`, `audit_events`, `idempotency_keys`; composite tenant FKs;
   audit-table immutability trigger.
2. Authentication (Better Auth, ADR-007): sign-up, sign-in, sign-out, session
   expiry, password rules, rate limiting on auth endpoints.
3. Organization onboarding: sign-up creates org + Owner membership + system
   roles (A-03); invitation flow (create invite, accept as new/existing user).
4. Access control: permission catalogue in code, `authorize(ctx, permission, scope?)`,
   role management UI for Owner/Admin, last-owner protection.
5. Tenancy: `requireTenant(orgSlug)` resolving TenantContext from session +
   membership; tenant-scoped repositories; RLS spike (ADR-006) with a decision.
6. Branches, warehouses, storage locations: CRUD with archive (no delete once
   referenced), scoped permissions.
7. Localization: `ar`/`en`, RTL/LTR, language switcher persisted to profile,
   localized validation messages, dates and numbers.
8. Application shell: responsive navigation (desktop sidebar, mobile drawer),
   org switcher, user menu, loading/empty/error states, `error.tsx`/`not-found.tsx`.
9. Audit: writer used by membership, role and branch/warehouse changes; audit
   log list for admins.
10. Request ID propagation into logs.
11. Development seed: two clearly labelled **demo** organizations with users in
    different roles (for manual cross-tenant checks).

### Acceptance criteria

- **AC1.1** A new user can sign up, which creates their organization, Owner
  membership and the system roles; they land on that organization's home page.
- **AC1.2** A user can sign in and out; protected pages redirect to sign-in
  when there is no valid session; expired sessions are rejected server-side.
- **AC1.3** A user who belongs to organizations A and B can switch between
  them; a user who belongs only to A receives **404** for any `/o/{B}/…` page
  and any API/action targeting B's resources by ID — verified by automated
  cross-tenant tests for every M1 entity (branch, warehouse, location,
  membership, role, audit event).
- **AC1.4** Permission checks are enforced in services: a Read-only Analyst
  cannot create a warehouse even by calling the server action directly; a
  Branch Manager scoped to branch X cannot modify branch Y's warehouses.
- **AC1.5** The last Owner cannot be removed or demoted (including concurrent
  attempts).
- **AC1.6** Creating/updating/archiving branches, warehouses, locations,
  memberships and roles writes an audit event with actor, action and changes,
  in the same transaction; audit rows cannot be updated or deleted (DB test).
- **AC1.7** Switching to Arabic renders `dir="rtl"`, Arabic navigation and
  validation messages; English renders `dir="ltr"`; the choice persists.
- **AC1.8** All inputs are validated server-side with Zod; invalid input
  returns field errors, never a 500.
- **AC1.9** Duplicate form submission of "create warehouse" with the same
  idempotency key creates one warehouse.
- **AC1.10** CI green: format, lint, typecheck, unit, integration, build, E2E
  (sign-up → create branch → create warehouse → switch language → sign out).

### Acceptance results

| AC     | Status     | Verified by                                                                                                                      |
| ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| AC1.1  | ✅         | `organizations` via `createTenant` in every integration test; E2E `journey.spec.ts`                                              |
| AC1.2  | ✅         | `auth.int.test.ts` (password, expired session); E2E sign-out → redirect → sign-in returns to `next`; forged cookie test          |
| AC1.3  | ✅         | `tenancy/isolation.int.test.ts` (every M1 entity, RLS, composite FKs); E2E `tenancy.spec.ts` (404s, org switching)               |
| AC1.4  | ✅         | `access/access.int.test.ts` (analyst, branch- and warehouse-scoped users); E2E invitation test (analyst gets 404 on admin pages) |
| AC1.5  | ✅         | `access.int.test.ts` incl. concurrent mutual revocation (3 rounds)                                                               |
| AC1.6  | ✅         | `sites.int.test.ts` (audit rows per change, none on failure; UPDATE/DELETE/TRUNCATE rejected)                                    |
| AC1.7  | ✅         | E2E journey (dir/lang, Arabic nav, persists across reload); `i18n/messages.test.ts` (catalog parity)                             |
| AC1.8  | ✅         | Service tests (`VALIDATION_FAILED` with field keys); E2E field errors with values preserved                                      |
| AC1.9  | ✅         | `sites.int.test.ts` (sequential, 5 concurrent, key reuse rejected)                                                               |
| AC1.10 | ✅ locally | All suites pass locally; CI workflow runs on the first push/PR to `main`                                                         |

AC1.4 note: server actions only resolve the context and call the service, so
the service-level tests cover direct action calls.

---

## M2 — Inventory MVP ✅

Delivered: products/SKUs with barcodes (GS1 check digits), system and custom
units with product-specific conversions, lots with expiry/best-before, the
append-only ledger with a locked balance projection, opening balances,
adjustments, write-offs, transfers, quarantine/hold/reject/release, reversals,
stock counts, FEFO suggestions, inventory dashboard, stock and movement views,
CSV import (products, opening balances) and export (products, stock).
Scope refinements are recorded in DATA_MODEL.md §4 "Milestone 2
implementation notes" and ADR-016/017.

### Acceptance results

| Criterion                             | Status | Verified by (`src/modules/inventory/*.int.test.ts` unless noted)                                                                                         |
| ------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Balances always equal the ledger      | ✅     | `reconcileBalances()` asserted empty after every inventory and CSV suite                                                                                 |
| Posting is idempotent                 | ✅     | concurrent same-key submissions → one document; duplicate posting key → CONFLICT; same CSV file twice → refused                                          |
| No negative stock under concurrency   | ✅     | 12 concurrent write-offs against 5 units → exactly 5 succeed; DB CHECK rejects a direct negative update                                                  |
| No deadlocks                          | ✅     | concurrent transfers in opposite directions all succeed                                                                                                  |
| Unavailable stock cannot be issued    | ✅     | quarantined stock cannot be transferred; expired lot transfer → LOT_EXPIRED; available excludes quarantine                                               |
| Expiry boundary                       | ✅     | stock expiring today is usable, yesterday is expired (`rules.test.ts`, business date per time zone)                                                      |
| Release needs permission              | ✅     | warehouse role → FORBIDDEN; food-safety role releases; expired stock cannot be released                                                                  |
| Incompatible units rejected           | ✅     | `units.test.ts` + integration (litres for a kg product → INCOMPATIBLE_UNITS)                                                                             |
| Reversals restore exactly, once       | ✅     | reverse → balance restored; second reversal → CONFLICT; reversal of reversal → refused; concurrent reversals → one wins; used stock → INSUFFICIENT_STOCK |
| Counts with movements during counting | ✅     | movement between sheet creation and counting is not double-counted                                                                                       |
| FEFO ordering                         | ✅     | `rules.test.ts` (expiry → best-before → receipt; expired skipped) + suggestions query                                                                    |
| CSV import validation                 | ✅     | `csv.int.test.ts`: per-row errors, all-or-nothing (lots rolled back), duplicates, malformed/oversize files                                               |
| Scope and tenant isolation            | ✅     | warehouse-scoped user sees/posts only its warehouse; analyst read-only; other tenant gets NOT_FOUND; RLS hides ledger rows                               |
| End-to-end                            | ✅     | `tests/e2e/inventory.spec.ts`: full journey, CSV import/export, tenant-scoped export                                                                     |

## M3 — Procurement and receiving

Suppliers, requisitions + approvals, POs, partial/complete receiving, lot and
expiry capture, rejected/quarantined receipts, discrepancies, supplier
performance, landed cost allocation. Key AC: receiving creates correct ledger
entries exactly once, including partial receipts and rejected quantities.
Blocked on Q-01 (valuation), Q-04 (approvals), Q-09 (tolerance) — defaults
proposed in DECISIONS.md.

## M4 — Recipes and food cost

Recipe versions, ingredients linked to products/sub-recipes, yields, waste,
portion cost, cost source + effective date, cost history. Key AC: costs are
reproducible from stored snapshots and recalculate correctly on cost or
version changes.

## M5 — Nutrition and allergens

Sourced nutrition data, recipe calculation only with sufficient data,
allergen declarations with explicit unknown, cross-contact distinguished from
presence, versioned calculations, label approval workflow. Blocked on Q-02 for
market-specific label rules.

## M6 — Food safety and traceability

Temperature/hygiene records, checklists, non-conformance + CAPA, backward and
forward lot trace with explicit gap reporting, recall simulation and report.

## M7 — Sales and financial workflows

Sales records/imports (idempotent), recipe-based consumption, supplier invoice
capture, 3-way match, supplier balances and settlements, accounting export
files. No live POS/ERP integration is claimed without testing against a real
interface.

## M8 — Analytics and pilot readiness

Stock/expiry, waste, supplier performance, food cost trends, branch
comparisons, exports, notifications; backups, restore drill, runbooks,
security review, pilot onboarding.

---

## Prioritized backlog (next items)

| Pri | Item                                                                    | Milestone | Depends on |
| --- | ----------------------------------------------------------------------- | --------- | ---------- |
| P0  | Decide Q-01 valuation method (needed for receipt costs and landed cost) | M3        | decision   |
| P0  | Suppliers and supplier products                                         | M3        | —          |
| P0  | Purchase orders (+ optional requisitions/approvals, Q-04)               | M3        | suppliers  |
| P0  | Goods receipts: partial, rejected, quarantined; posting via ledger      | M3        | POs        |
| P1  | In-transit transfers (ADR-016) and lot supplier key                     | M3        | receipts   |
| P1  | Discrepancies, supplier performance, landed cost allocation             | M3        | receipts   |
| P1  | Email provider for invitations and password reset (Q-10)                | M3        | decision   |
| P2  | Searchable product picker for large catalogs                            | M3        | —          |

## Top risks

| Risk                                                         | Mitigation                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Cross-tenant data leak                                       | 3 isolation layers (ADR-006), cross-tenant tests per entity, no shared caching (ADR-004)     |
| Inventory drift / double posting under concurrency           | Ledger + locked projection + posting-key UQ + CK constraints + reconciliation test (ADR-005) |
| Wrong valuation method chosen late                           | Decide Q-01 before M3; ledger stores unit cost per entry so revaluation is possible          |
| Floating-point errors in cost/money                          | Decimal-only policy enforced in helpers and schema types (ADR-003)                           |
| Regulatory liability for nutrition/allergen labels           | Explicit unknown status, human approval gate, market rules per Q-02                          |
| Framework churn (Next 16 conventions differ from older docs) | Pin versions; consult bundled docs in `node_modules/next/dist/docs`                          |
| Scope creep from many modules                                | Strict milestone gating; acceptance criteria before implementation                           |
