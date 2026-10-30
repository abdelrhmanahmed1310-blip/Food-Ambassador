# Food Ambassador — Implementation Status

Last updated: 2026-10-30 (Milestone 3c, part 1 — categories, reorder, price history, PO print)

## Summary

| Milestone                    | Status                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| M0 Repository & architecture | ✅ Complete                                                                                                                         |
| M1 Application foundation    | ✅ Complete                                                                                                                         |
| M2 Inventory MVP             | ✅ Complete                                                                                                                         |
| M3 Procurement & receiving   | 🔄 In progress — M3a ✅, M3b ✅, M3c part 1 ✅, **M3c part 2 ✅** (shipments with in-transit stage); landed cost, requisitions next |
| M4 – M10, POS1 – POS5        | Not started (POS in scope since ADR-022)                                                                                            |

## M3c part 2 — Shipments with an in-transit stage (delivered)

Rules: DECISIONS.md ADR-026 (extends ADR-016, replaces assumption A-08) and
ADR-027.

| Area        | What works                                                                                                                                       | Where                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Drafts      | `SHP-` numbered shipment between two warehouses; lines pick a stock line (product, lot, location) in any convertible unit; add/remove lines      | `src/modules/inventory/shipments.ts` |
| Dispatch    | `DSP-` document moves stock AVAILABLE → IN_TRANSIT at the source; value stays with the source; expired/recalled lots and missing stock refused   | `dispatchShipment`                   |
| Receive     | `TRR-` document: received stock to AVAILABLE at the destination (optional location) with its value; shortages written off with a required reason | `receiveShipment`, receive form      |
| Recall      | Cancelling a shipment in transit returns its stock to AVAILABLE at the source; drafts are simply cancelled                                       | `cancelShipment`                     |
| Safeguards  | No over-receipt; IN_TRANSIT stock cannot be adjusted, written off, transferred or status-changed by hand; shipment documents cannot be reversed  | schemas, `reverseDocumentInTx`       |
| Access      | Source needs `inventory.transfer` to edit/dispatch/cancel, destination to receive; visible to users who see stock at either end; audited         | `shipments.ts`                       |
| Master data | Scoped roles read products and suppliers organization-wide (ADR-027) — fixes postings by branch-scoped users                                     | `src/modules/access/authorize.ts`    |
| Screens     | Shipments list with status filter, new shipment, detail with lines, dispatch, receive and cancel, links to documents; EN/AR                      | `/inventory/shipments`               |

Checks: `pnpm check` pass (lint, typecheck, unit 19 files / 127 tests, build);
`pnpm test:integration` 13 files / 130 tests pass (new: dispatch → receive
with value and shortage, recall and draft cancel, expired/recalled/moved
stock refused, source/destination access and visibility, scoped-user
adjustment); `pnpm test:e2e` 21 tests pass (new: draft → dispatch → stock
in transit → receive with a damaged shortage → stock value).

Known limitation: the server logs a `pg` deprecation warning ("client.query()
while already executing") that comes from inside Prisma's query interpreter
with the pg adapter, not from application code; it predates this slice and
is harmless with pg 8.

## M3c part 1 — Categories, reorder levels, price history, PO print (delivered)

Rules: DECISIONS.md ADR-025 (default for Q-13).

| Area                          | What works                                                                                                                                                                     | Where                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Categories                    | Flat list (code, EN/AR name), assign on product create/edit, filter and column in the product list, archive/restore                                                            | `src/modules/catalog/categories.ts`, `/catalog/categories`  |
| Reorder levels                | Min/max per product × warehouse, entered in any convertible unit, stored in the base unit                                                                                      | `src/modules/procurement/reorder.ts`, `/purchasing/reorder` |
| Suggestions                   | Usable stock (expired and recall-held excluded) + open orders vs. minimum; order up to maximum in whole purchase units, supplier minimum respected; preferred or only supplier | `suggestReorder` (pure, unit-tested)                        |
| Draft orders from suggestions | One draft per supplier at the last known price, recomputed on the server; unpriced or supplier-less lines skipped and named                                                    | `createOrdersFromPlan`                                      |
| Price history                 | Prices charged on posted receipts (with the ordered price) on the supplier page                                                                                                | `getSupplier`                                               |
| Printable PO                  | Print button; navigation and actions hidden in print                                                                                                                           | order page                                                  |

Checks: `pnpm check` pass (unit 19 files, 126 tests); `pnpm test:integration`
12 files, 126 tests pass (8 new: categories, reorder levels, suggestions,
draft orders, price history, scope, other tenant); `pnpm test:e2e` 20 tests
pass (new: category → product → supplier price → reorder level → draft order).

Found and fixed: the result message of "Create draft orders" disappeared
because the form was removed once nothing was left to suggest; it now stays.

## M3b — Suppliers, purchase orders, receiving (delivered)

Rules: DECISIONS.md ADR-023 (with defaults for Q-04, Q-05, Q-09) and ADR-024.

| Area                      | What works                                                                                                                                                                                                                                                                                                                                   | Where                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Suppliers                 | Create, edit, archive (refused with open orders), EN/AR names, contacts, payment terms, lead time                                                                                                                                                                                                                                            | `src/modules/procurement/suppliers.ts`, `/suppliers` |
| Supplier products         | Purchase unit (must convert to the base unit), supplier SKU, last price (updated by receipts), lead time, minimum order, preferred                                                                                                                                                                                                           | supplier page                                        |
| Purchase orders           | Numbered drafts, lines in any convertible unit, exact totals, one line per product, edit only in draft, submit, short close, cancel (only without receipts)                                                                                                                                                                                  | `orders.ts`, `/purchasing/orders`                    |
| Approval                  | Optional approval limit per organization; above it another user with `purchasing.approve` must approve; send back to draft with a reason                                                                                                                                                                                                     | `orders.ts`, `/settings/purchasing`                  |
| Receiving                 | Partial deliveries; received = accepted + rejected with reason; rejected goods never enter stock; quarantine on receipt; lot and expiry per product rules; expired and recall-held lots refused; temperature required for chilled/frozen goods; price charged may differ from the order; over-receipt tolerance; location; delivery note no. | `receipts.ts`, `/purchasing/orders/[id]/receive`     |
| Stock and value           | Accepted quantities posted through the inventory module (`RCV-` document, `RECEIPT` entries) at the charged price per base unit; FEFO, balances and valuation updated in the same transaction                                                                                                                                                | `postReceiptInTx` in `inventory/operations.ts`       |
| Reversal                  | From the receipt page only: stock out (exact value, ADR-024), order quantities and status restored; refused if the stock was used or the order closed                                                                                                                                                                                        | `reverseReceipt`                                     |
| Concurrency & idempotency | Order row locked for every change and receipt (parallel receipts cannot over-receive); idempotency keys on order creation and receipts                                                                                                                                                                                                       | tests                                                |
| Supplier performance      | Receipts, on-time rate, fill rate, rejection rate, price variance — from posted receipts only; "not enough data" instead of invented 0 %/100 %                                                                                                                                                                                               | `rules.ts` `supplierPerformance`                     |
| Access                    | 6 new permissions (`suppliers.*`, `purchasing.*`, purchasing warehouse-scoped); system roles updated for existing organizations by data migration                                                                                                                                                                                            | `permissions.ts`, migration                          |
| Localization              | All screens, statuses, reasons and errors in English and Arabic; names and dates isolated for RTL                                                                                                                                                                                                                                            | `src/i18n/messages/`                                 |
| Seed                      | `[DEMO] Delta Foods` with a product link and one approved order per demo organization (idempotent)                                                                                                                                                                                                                                           | `prisma/seed.ts`                                     |

### Check results (M3b)

| Command                                             | Result                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check` (format, lint, typecheck, unit, build) | pass — unit: 19 files, 122 tests                                                                                                                                                                                                                      |
| `pnpm test:integration`                             | 10 files, 118 tests pass (18 new purchasing tests: approval, partial/rejected/quarantined receipts, tolerance, units, lots, temperature, reversal, concurrency, idempotency, scorecard, roles, warehouse scope, other tenant, RLS, append-only lines) |
| `pnpm test:e2e`                                     | 19 tests pass (new: supplier → order → receive with rejection → over-receipt refused → close)                                                                                                                                                         |
| Fresh database                                      | all migrations apply; seed run twice creates the demo purchasing data once                                                                                                                                                                            |
| Mutation check                                      | disabling the over-receipt limit makes the tolerance test fail, as it should                                                                                                                                                                          |
| Screens                                             | orders, order, receive, supplier checked in English and Arabic; phone width has no horizontal scroll                                                                                                                                                  |

### Defects found and fixed during M3b

- **Wrong-price receipts could not be corrected cleanly**: reversing an
  inbound entry removed stock at the average and left the wrong value
  behind. Reversals now remove the value the entry added (ADR-024).
- **Arabic layout** mixed names and dates on the order page; each part is
  now its own bidi run.
- A long constraint name was truncated by PostgreSQL (63 characters); the
  duplicate-line check now uses the real name.

### Known limitations (M3b)

- No purchase requisitions, landed cost, in-transit transfers or par levels
  yet (M3c).
- No PO printout or email to suppliers (email needs Q-10).
- One approval level; base currency only.
- Temperatures are recorded but no acceptable range is enforced (Q-02).
- Receipts against several orders at once, and receipts without an order,
  are not supported.

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

M3c (requisitions, in-transit transfers, landed cost, par levels), M4–M8, proposed M9
(central kitchen & B2B) and M10 (integrations), and the point of sale
POS1–POS5 (ADR-022). See PROJECT_PLAN.md and the capability reviews in
`docs/`.
