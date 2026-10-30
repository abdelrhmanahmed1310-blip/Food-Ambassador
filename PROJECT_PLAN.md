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

Point of sale (ADR-022), after M4:

```
M4 Recipes ─► POS1 Core ─► POS2 Floor & kitchen ─► POS4 Tax e-invoicing ─► POS3 Payments ─► POS5 Customer channels
```

A market goes live on the POS only after its e-invoicing work (POS4) passes.

| #    | Milestone                   | Depends on                       | Status       |
| ---- | --------------------------- | -------------------------------- | ------------ |
| M0   | Repository & architecture   | —                                | **Complete** |
| M1   | Application foundation      | M0                               | **Complete** |
| M2   | Inventory MVP               | M1                               | **Complete** |
| M3   | Procurement & receiving     | M2                               | **Complete** |
| M4   | Recipes & food cost         | M2 (M3 for purchase-based costs) | Not started  |
| M5   | Nutrition & allergens       | M4                               | Not started  |
| M6   | Food safety & traceability  | M2, M3, M4                       | Not started  |
| M7   | Sales & financial workflows | M3, M4                           | Not started  |
| M8   | Analytics & pilot readiness | M2–M7                            | Not started  |
| M9   | Central kitchen & B2B       | M4, M6                           | Proposed     |
| M10  | Integrations                | M7                               | Proposed     |
| POS1 | Core                        | M4                               | Planned      |
| POS2 | Floor & kitchen             | POS1                             | Planned      |
| POS3 | Payments                    | POS1, Q-15                       | Planned      |
| POS4 | Tax & e-invoicing           | POS1, Q-17                       | Planned      |
| POS5 | Customer channels           | POS1–POS4                        | Planned      |

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

| AC     | Status | Verified by                                                                                                                      |
| ------ | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| AC1.1  | ✅     | `organizations` via `createTenant` in every integration test; E2E `journey.spec.ts`                                              |
| AC1.2  | ✅     | `auth.int.test.ts` (password, expired session); E2E sign-out → redirect → sign-in returns to `next`; forged cookie test          |
| AC1.3  | ✅     | `tenancy/isolation.int.test.ts` (every M1 entity, RLS, composite FKs); E2E `tenancy.spec.ts` (404s, org switching)               |
| AC1.4  | ✅     | `access/access.int.test.ts` (analyst, branch- and warehouse-scoped users); E2E invitation test (analyst gets 404 on admin pages) |
| AC1.5  | ✅     | `access.int.test.ts` incl. concurrent mutual revocation (3 rounds)                                                               |
| AC1.6  | ✅     | `sites.int.test.ts` (audit rows per change, none on failure; UPDATE/DELETE/TRUNCATE rejected)                                    |
| AC1.7  | ✅     | E2E journey (dir/lang, Arabic nav, persists across reload); `i18n/messages.test.ts` (catalog parity)                             |
| AC1.8  | ✅     | Service tests (`VALIDATION_FAILED` with field keys); E2E field errors with values preserved                                      |
| AC1.9  | ✅     | `sites.int.test.ts` (sequential, 5 concurrent, key reuse rejected)                                                               |
| AC1.10 | ✅     | GitHub Actions run #1 green on all steps (commit `a02c39e`)                                                                      |

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
Q-04 (approvals) and Q-09 (tolerance) are still open — defaults proposed in
DECISIONS.md.

**M3a — Stock valuation ✅ (delivered first, ADR-021):** moving weighted
average per product × warehouse on every ledger entry, cost-missing flag
(costs never guessed), revaluation documents, stock value report + CSV,
value on the dashboard, costs in movements and documents for users with
`inventory.valuation.view`, backfill of existing history.

**M3b — Suppliers, purchase orders, receiving ✅ (ADR-023):** suppliers and
supplier products with last price; purchase orders with optional approval
limit (author cannot approve); receiving with partial deliveries,
rejections with reasons, quarantine, lots/expiry, temperature for chilled
and frozen goods, over-receipt tolerance; receipt reversal; short close and
cancel; supplier scorecard; purchasing settings.

**M3c — ✅ complete:**

- ✅ Product categories (ADR-025), reorder levels with suggested draft
  orders, supplier price history, printable purchase order.
- ✅ Shipments with an in-transit stage (ADR-026): dispatch, receive with
  shortages, recall.
- ✅ Landed cost on receipts (ADR-028): by value or quantity, only stock still
  on hand is revalued, the rest shown as expensed.
- ✅ Purchase requisitions from branches (ADR-029): request, submit, order
  from a supplier in steps, reject, close, cancel.
- Moved out: PO email (needs Q-10); stock count templates (backlog).

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

## M9 — Central kitchen and B2B (proposed)

Production planning from branch demand, production orders that consume
ingredients and produce lot-tracked batches, internal branch orders, and
external B2B customers with orders, delivery notes and sales invoices. Added
after the Supy capability review (`docs/SUPY_FEATURE_MAP.md`).

## M10 — Integrations (proposed)

Connector framework (encrypted credentials, webhook verification, idempotent
sync, retries, audit), then one connector at a time: POS sales, accounting
bills (e.g. Xero), PO delivery by WhatsApp Business, invoice OCR with
mandatory human confirmation. A connector is listed as available only after
testing against the provider's real sandbox.

---

## POS1 — POS core

Sellable menu (categories, items, modifiers, combos) linked to recipes;
prices per branch and channel; order engine (dine-in, takeaway, delivery);
cashier app as an installable web app with an offline order queue and
idempotent sync; shifts, cash drawer open/close and cash counts; receipts;
voids and refunds with permissions and reasons; each paid order consumes
stock through its recipes via the ledger. Payments recorded as cash or
"external card terminal" until POS3.

## POS2 — Floor and kitchen

Floor plans and tables, waiter app, course and seat handling, split and
merge bills, kitchen display with station routing and bump times, order
status to the cashier.

## POS3 — Payments

Payment provider integration (Q-15): card terminals, wallets, refunds,
tips, settlement reports and reconciliation against orders. No card data
stored by Food Ambassador.

## POS4 — Tax and e-invoicing

VAT rules per item and branch, tax-inclusive/exclusive prices, simplified
and standard tax invoices, credit notes, and the e-invoicing integration of
the first market (Q-17): for Saudi Arabia, ZATCA Phase 2 (device onboarding,
signed invoices, QR codes, reporting/clearance). Tested against the
authority's sandbox before any live use.

## POS5 — Customer channels

Customers and consent, loyalty points, coupons, discounts and timed
promotions, gift cards (as a stored-value liability), online ordering
website, self-order kiosk, and delivery-platform order intake (Q-18).

---

Competitor reviews: `docs/SUPY_FEATURE_MAP.md` and `docs/FOODICS_FEATURE_MAP.md`.

## Prioritized backlog (next items)

| Pri | Item                                                                   | Milestone | Depends on |
| --- | ---------------------------------------------------------------------- | --------- | ---------- |
| ✅  | Stock valuation — moving weighted average (ADR-021)                    | M3a       | done       |
| ✅  | Suppliers and supplier products                                        | M3b       | done       |
| ✅  | Purchase orders with approval limit (Q-04 default); requisitions → M3c | M3b       | done       |
| ✅  | Goods receipts: partial, rejected, quarantined; posting via ledger     | M3b       | done       |
| ✅  | In-transit transfers (ADR-026)                                         | M3c       | done       |
| ✅  | Purchase requisitions from branches (ADR-029)                          | M3c       | done       |
| ✅  | Landed cost allocation (ADR-028)                                       | M3c       | done       |
| P1  | Email provider for invitations and password reset (Q-10)               | M3        | decision   |
| P2  | Searchable product picker for large catalogs                           | M3        | —          |
| ✅  | Product categories (Q-13 default, ADR-025)                             | M3c       | done       |
| ✅  | Par levels + suggested order quantities                                | M3c       | done       |
| ✅  | Supplier item price history                                            | M3c       | done       |
| P2  | Stock count templates                                                  | M3        | —          |
| P2  | Margin alerts, price simulator, bulk ingredient replace                | M4        | recipes    |
| P2  | Credit notes for short/rejected deliveries                             | M7        | invoices   |
| P3  | Installable PWA with offline counting; native apps                     | backlog   | —          |

## Top risks

| Risk                                                         | Mitigation                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Cross-tenant data leak                                       | 3 isolation layers (ADR-006), cross-tenant tests per entity, no shared caching (ADR-004)     |
| Inventory drift / double posting under concurrency           | Ledger + locked projection + posting-key UQ + CK constraints + reconciliation test (ADR-005) |
| Wrong valuation method chosen late                           | Decided (ADR-021); every ledger entry stores unit cost and value change                      |
| Floating-point errors in cost/money                          | Decimal-only policy enforced in helpers and schema types (ADR-003)                           |
| Regulatory liability for nutrition/allergen labels           | Explicit unknown status, human approval gate, market rules per Q-02                          |
| Framework churn (Next 16 conventions differ from older docs) | Pin versions; consult bundled docs in `node_modules/next/dist/docs`                          |
| Scope creep from many modules                                | Strict milestone gating; acceptance criteria before implementation                           |
