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
| M2  | Inventory MVP               | M1                               | Not started  |
| M3  | Procurement & receiving     | M2                               | Not started  |
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

## M1 — Application foundation (next)

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

### Test plan

- Unit: permission resolution (scope coverage), role templates, validation schemas.
- Integration: membership resolution, cross-tenant read/update/archive attempts,
  last-owner race (two concurrent transactions), audit immutability trigger,
  idempotency key handling, composite-FK rejection of cross-tenant references.
- E2E: sign-up/sign-in journey, RTL switch, unauthorized access redirect/404.

---

## M2 — Inventory MVP

Products/SKUs, barcodes, units and conversions, lots and expiry, ledger and
balance projection, opening balances, transfers, stock counts, adjustments and
write-offs, quarantine/release, FEFO suggestions, inventory dashboard and
movement history, CSV import/export with row-level error reporting.

Acceptance criteria (summary): balances always equal the ledger sum
(reconciliation test); posting is idempotent; no negative stock under
concurrent postings; unavailable stock (quarantine/rejected/on-hold/expired)
cannot be issued; release from quarantine requires permission; incompatible
unit conversions are rejected; reversals restore balances exactly.

Required tests: duplicate postings, concurrent issues against the same lot,
partial transfers, count with movements during counting, FEFO ordering, expiry
boundary (today vs yesterday, time zones), quarantine release authorization,
reversal of reversal blocked, CSV import validation.

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

| Pri | Item                                                      | Milestone | Depends on |
| --- | --------------------------------------------------------- | --------- | ---------- |
| P0  | Confirm ADR-007 (auth library) and A-03 (sign-up model)   | M1        | —          |
| P0  | Identity & tenancy schema + migrations + composite FKs    | M1        | —          |
| P0  | Better Auth integration, sessions, protected routes       | M1        | schema     |
| P0  | TenantContext + `authorize()` + cross-tenant test harness | M1        | auth       |
| P0  | RLS spike → ADR-006 decision                              | M1        | schema     |
| P1  | Org onboarding, invitations, role management              | M1        | tenancy    |
| P1  | Branches / warehouses / locations CRUD + audit            | M1        | tenancy    |
| P1  | i18n (ar/en, RTL) + app shell                             | M1        | —          |
| P1  | Dev seed with labelled demo orgs                          | M1        | schema     |
| P2  | Answer Q-01 valuation method                              | before M3 | —          |

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
