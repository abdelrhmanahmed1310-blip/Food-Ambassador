# Food Ambassador — Implementation Status

Last updated: 2026-10-29 (Milestone 3a — stock valuation)

## Summary

| Milestone                    | Status                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------ |
| M0 Repository & architecture | ✅ Complete                                                                    |
| M1 Application foundation    | ✅ Complete                                                                    |
| M2 Inventory MVP             | ✅ Complete                                                                    |
| M3 Procurement & receiving   | 🔄 In progress — **M3a stock valuation ✅**; suppliers, POs and receiving next |
| M4 – M10, POS1 – POS5        | Not started (POS in scope since ADR-022)                                       |

## M3a — Stock valuation (delivered)

Decision: moving weighted average per product × warehouse (Q-01 → ADR-021).

| Area          | What works                                                                                                                                                                                                                              | Where                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Costing rules | Inbound at entered cost, otherwise current/last average; outbound at average with the last unit taking the exact remaining value; transfers and status changes move value without changing it; reversals restore exactly what was taken | `src/modules/inventory/valuation.ts` (pure, unit-tested)                         |
| Posting       | Every ledger entry stores unit cost, value change and cost source; valuations locked after balances in a stable order; DB checks keep value ≥ 0 and zero at zero quantity                                                               | `src/modules/inventory/posting.ts`, migration `…_m3_valuation`                   |
| Unknown costs | Stock added without any known cost is valued at zero and flagged **cost missing**; the flag blocks the average from being reused until the stock is revalued or used up. No cost is ever guessed                                        | `valuation.ts`, stock value page                                                 |
| Revaluation   | New average cost for a product in a warehouse via a numbered `RVL-` document with an append-only record (previous/new cost and value); cannot be reversed; idempotent; own permission                                                   | `operations.ts` `revalueStock`, `/inventory/valuation/[warehouseId]/[productId]` |
| Reports       | Stock value page (filters, total, cost-missing count, per-row revalue), CSV export, dashboard value card, value + unit cost + source in movements and documents                                                                         | `src/app/o/[orgSlug]/inventory/valuation/`, `valuation-queries.ts`               |
| Access        | `inventory.valuation.view` and `inventory.valuation.revalue` (warehouse-scopable); granted to existing organizations' system roles by data migration; users without view permission see no costs anywhere (also in movements/documents) | `permissions.ts`, migration                                                      |
| History       | Existing ledger replayed with the same rules during migration; aborts if quantities disagree with balances                                                                                                                              | migration backfill                                                               |
| Integrity     | `reconcileValuations()` (quantity vs balances, value vs ledger + revaluations) asserted after every inventory integration suite                                                                                                         | `valuation-queries.ts`                                                           |
| Localization  | All new screens, reasons and messages in English and Arabic                                                                                                                                                                             | `src/i18n/messages/`                                                             |

### Check results (M3a)

| Command                                             | Result                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check` (format, lint, typecheck, unit, build) | pass — unit: 18 files, 112 tests                                                                                                                                                            |
| `pnpm test:integration`                             | 9 files, 99 tests pass (16 new valuation tests incl. concurrency, scope, RLS, idempotency)                                                                                                  |
| `pnpm test:e2e`                                     | 18 tests pass (new: stock value journey with revaluation and CSV)                                                                                                                           |
| Migration on real M2 history                        | database built by running the M2 code's integration suite twice (116 entries); migration applied; a TypeScript replay with `valuation.ts` matches all 116 entries and 16 valuations exactly |
| `pnpm db:seed` twice on a fresh database            | demo stock created once, valued (rice 250 kg × 48 = EGP 12,000 per demo org; milk and eggs flagged cost missing)                                                                            |
| Screens                                             | stock value, revaluation, movements, dashboard checked in English, Arabic and at phone width (no horizontal scroll)                                                                         |

### Defects found and fixed during M3a

- **Zero-value reversals failed**: reversing a write-off of uncosted stock
  produced a negative zero that the costing rules rejected. Found by the
  replay cross-check; fixed and covered by unit and integration tests.
- **Made-up average for uncosted stock**: stock with no known cost showed an
  average of 0, which would then have been used for later stock. The average
  is now left unknown while uncosted units are on hand. Found by an
  integration test before release.
- **Movements table too wide** once costs were added: "entered as", "by" and
  status now sit under the related column, so the table fits at 1280 px.

### Known limitations (M3a)

- No supplier receipts yet, so costs come from opening balances, entered
  costs and revaluations until purchasing lands in M3.
- One base currency; no landed cost allocation yet (M3).
- Revaluation applies to a whole product × warehouse, not to one lot.
- No COGS report yet (consumption by recipes arrives with M4/POS1); the
  ledger already records the value of every issue.

## M2 — Delivered

| Area              | What works                                                                                                                                                                                                                                                                      | Where                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Units             | 9 system units (mass, volume, count) + custom pack units; same-dimension conversion; product-specific conversions; incompatible units rejected                                                                                                                                  | `src/modules/catalog/units.ts`, `service.ts`                   |
| Products          | SKU, EN/AR names, type, base unit, lot tracking (none / lot / lot + expiry), shelf life, storage zone; barcodes with GS1 check digits; base unit and lot mode frozen after movements; archive blocked while stocked                                                             | `src/modules/catalog/`                                         |
| Ledger & balances | Append-only ledger (DB triggers), balance projection updated under ordered row locks, posting-key idempotency, no negative stock (service check + CHECK constraint), reconciliation query                                                                                       | `src/modules/inventory/posting.ts`, migration `…_m2_inventory` |
| Operations        | Opening balances (only before other movements), adjustments (± with reason), write-offs (any status, incl. expired), transfers (warehouse ↔ warehouse / location), quarantine · hold · reject · release with separate release permission, reversals (once, never of a reversal) | `src/modules/inventory/operations.ts`                          |
| Lots & expiry     | Lot creation on inbound, expiry consistency, expiry by branch/org business date, expired and recall-held stock unusable, FEFO suggestions and FEFO warning in the UI                                                                                                            | `rules.ts`, `context.ts`, `queries.ts`                         |
| Stock counts      | Count sheet from balances, items found during counting, system quantity captured per line, blind count UI, submit → approve & post with its own permission                                                                                                                      | `src/modules/inventory/counts.ts`                              |
| Views             | Inventory dashboard (real figures, expired/expiring lists, recent documents), stock list with filters, stock line page with actions, movements, documents with reversal, counts                                                                                                 | `src/app/o/[orgSlug]/inventory/`                               |
| CSV               | Import products and opening balances (validate everything, all-or-nothing, row/column errors, same file refused twice); export products and stock (UTF-8 BOM, formula-injection safe)                                                                                           | `src/modules/inventory/csv.ts`, `src/lib/csv.ts`               |
| Access            | 10 new permissions with warehouse scope for `inventory.*`; system roles updated for new and existing organizations (data migration + sync test)                                                                                                                                 | `src/modules/access/permissions.ts`                            |
| Localization      | All new screens, enums, reasons and errors in English and Arabic                                                                                                                                                                                                                | `src/i18n/messages/`                                           |
| Seed              | `[DEMO]` products and opening stock (incl. expired and expiring lots); idempotent                                                                                                                                                                                               | `prisma/seed.ts`                                               |

## Check results at end of M2 (clean install)

| Command                 | Result                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm format:check`     | pass                                                                                                  |
| `pnpm lint`             | pass (0 warnings)                                                                                     |
| `pnpm typecheck`        | pass                                                                                                  |
| `pnpm test`             | 16 files, 97 tests pass                                                                               |
| `pnpm test:integration` | 8 files, 83 tests pass (PostgreSQL 16; full suite run 3× in a row green after the ordering fix below) |
| `pnpm build`            | pass (41 routes, all dynamic)                                                                         |
| `pnpm test:e2e`         | 17 tests pass (16 desktop Chromium + 1 mobile)                                                        |
| `docker build` + run    | image serves health/readiness; unauthenticated export redirects to sign-in                            |
| `pnpm db:seed` (twice)  | demo stock created once; second run changes nothing                                                   |

### Defects found and fixed during M2

- **Line ordering** of documents depended on random sub-millisecond UUID bits
  (intermittent test failure) → monotonic UUIDv7 (ADR-019).
- **Untranslated decimal validation messages** → translation keys (ADR-020).
- **Duplicate CSV import** showed a generic "already posted" message → now
  "This file was already imported".
- **Floating-point display math** in the count sheet → differences are
  computed with exact decimals on the server.
- **Correction to the M1 report:** M1 stated that table row borders in the
  last column were fixed. That edit had silently not applied (class order
  changed by Prettier). It is fixed now, and screenshots of the new screens
  were checked in English and Arabic.

### Corrections found while preparing the demo walkthrough

Three Milestone 1 UI fixes had been reported as done but their edits had not
applied (the text replacements missed after Prettier reformatted the files).
All are now applied, verified in the files and in screenshots:

- **Invite / grant-role forms preselected the first role — Owner.** Now no
  role is preselected; submitting without one shows "Select a valid option."
  next to the field. Covered by `tests/e2e/invitation.spec.ts`. (Field errors
  in the invite form were also not displayed; the form now provides its
  state to the field components.)
- Mobile menu button showed a text label instead of an icon; "Sign out"
  wrapped on narrow screens.
- Codes (SKU, lot, warehouse) could break mid-code in narrow table cells.

## Known limitations (carried over from M2)

- ~~Valuation (Q-01)~~ — delivered in M3a (see above).
- **Transfers are immediate** (no in-transit stage; ADR-016).
- **Reservations** are modelled (`reserved_quantity`) but not yet used.
- **Counts** cover AVAILABLE stock only; counter and approver may be the same
  person (Q-12).
- **Pickers** use plain selects (up to 2,000 products); a searchable picker
  is planned for large catalogs.
- **No product categories** yet (Q-13).
- **CSV uploads** are limited to ~900 KB / 2,000 rows per file.
- From M1, still open: no email delivery or password reset (Q-10); no
  optimistic-concurrency check on master-data edits.
- **Driver deprecation warning**: Prisma's query engine (7.10) overlaps
  queries on one transaction connection for some multi-relation reads, which
  `pg` 8 reports as deprecated (removed in `pg` 9). Our own code runs
  transaction queries sequentially (`inSequence`); `pg` is pinned to 8.23.1
  until Prisma fixes this upstream.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs on every push, on pull
requests and on demand. First run: [run #1](https://github.com/abdelrhmanahmed1310-blip/Food-Ambassador/actions/runs/40839125108)
on commit `a02c39e` — all steps green (format, lint, typecheck, unit,
integration against `postgres:16-alpine`, build, Playwright E2E) in under
2 minutes. Before this the workflow only triggered on `main`, so it had never
run on the development branch.

## Not started

Rest of M3 (suppliers, purchase orders, receiving), M4–M8, proposed M9
(central kitchen & B2B) and M10 (integrations), and the point of sale
POS1–POS5 (ADR-022). See PROJECT_PLAN.md and the capability reviews in
`docs/`.
