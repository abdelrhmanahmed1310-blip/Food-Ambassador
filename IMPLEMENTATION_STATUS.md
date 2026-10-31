# Food Ambassador — Implementation Status

Last updated: 2026-10-31 (M9b kitchen fulfilment and B2B; Milestone 9 complete)

## Summary

| Milestone                     | Status                                                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 Repository & architecture  | ✅ Complete                                                                                                                                                                                                           |
| M1 Application foundation     | ✅ Complete                                                                                                                                                                                                           |
| M2 Inventory MVP              | ✅ Complete                                                                                                                                                                                                           |
| M3 Procurement & receiving    | ✅ Complete — M3a valuation, M3b purchasing and receiving, M3c parts 1–4 (categories/reorder, shipments, landed cost, requisitions)                                                                                   |
| M4 Recipes & food cost        | ✅ Complete — M4a recipes, versions, cost sources, snapshots; M4b prices, food cost targets, simulator, bulk replace, recipe card                                                                                     |
| M6 Food safety & traceability | ✅ Complete — M6a traceability and recalls; M6b records, checklists, non-conformances and corrective actions                                                                                                          |
| M7 Sales & finance            | ✅ Complete — M7a sales import and recipe consumption, VAT setup (KSA, Egypt, GCC), M7b supplier invoices with 3-way match, **M7c payables** (payments, credit notes, balances, aging, export)                        |
| M5 Nutrition & allergens      | ✅ Complete — M5a allergens, nutrition, recipe roll-up, matrix, approved labels; **M5b ingredient library** (USDA FDC, Open Food Facts, Wikidata). Open: live lookup, market label layouts                            |
| M8 Analytics & pilot          | ✅ Complete — M8a reports, M8b needs attention, **M8c pilot readiness** (backup/restore drill, integrity check, runbooks, security review, onboarding). Open before go-live: pen test, CSP nonces, password reset/2FA |
| M9 Central kitchen & B2B      | ✅ Complete — M9a production orders, plan, genealogy; **M9b** branch fulfilment from the kitchen, B2B orders, deliveries, invoices, receivables                                                                       |
| M10, POS1 – POS5              | Not started (POS in scope since ADR-022)                                                                                                                                                                              |

## M9b — Kitchen fulfilment and B2B sales (delivered)

Rules: DECISIONS.md ADR-046, ADR-047.

| Area         | What works                                                                                                                             | Where                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Fulfilment   | Requisition lines sent from another warehouse: FEFO picks into a draft shipment; requisition partly/fully met; shipment cancel reopens | requisition page, `fulfilRequisitionFromStock` |
| Customers    | Code, names, VAT number, payment terms; account with open invoices and receipts                                                        | `/b2b/customers`                               |
| Sales orders | Draft lines (net price, VAT code), confirm, partial deliveries, cancel without deliveries                                              | `/b2b/orders`, `b2b/service.ts`                |
| Deliveries   | FEFO from the order's warehouse, CUSTOMER_DELIVERY document, cost of goods per line; reversal while not invoiced                       | `deliverSalesOrder`, `reverseDelivery`         |
| Invoices     | One per delivery, VAT per line at the invoice date, due date, margin; fixed once issued; printable (not an e-invoice)                  | `/b2b/invoices/[id]`                           |
| Receivables  | Receipts oldest first, void; balances and aging; overdue invoices in "needs attention"; output VAT in the VAT summary                  | `b2b/receivables.ts`, `/b2b/balances`          |

Checks: `pnpm check` pass (unit 31 files / 186 tests; build);
`pnpm test:integration` 31 files / 203 tests pass (5 new: kitchen
fulfilment FEFO across lots, order and double fulfilment refused, shipment
cancel reopens, dispatch; short source, same place, rights and tenants;
B2B order → partial FEFO delivery at cost → invoice 300 + 15 % VAT due in 30
days with margin 120 → duplicate invoice refused → full delivery → receipt
oldest first → balance and aging on two dates → void, cancel, reverse with
stock back; short delivery refused; invoice not editable in the database;
permissions and tenants; ledger and valuations reconcile);
`pnpm test:e2e` 36 tests pass (new: customer, order 8 kg at 40, delivered
at 120 cost, invoice 320 with margin 200, receipt 100, balance 220).

Found and fixed: the permission-sync unit test could not read permission
names containing digits (`b2b.view`), so it would have silently skipped
them; its pattern now accepts digits. My own check on sales orders
rejected cancelled drafts; corrected in a follow-up migration before
commit.

Limitations: no customer credit notes or returns, price lists or credit
limits; one invoice per delivery; no B2B lines in the accounting journal
export yet; printed invoices are not ZATCA/ETA e-invoices (POS4).

## M9a — Central kitchen production (delivered)

Rules: DECISIONS.md ADR-045.

| Area      | What works                                                                                                                                | Where                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Output    | A preparation names the stock product it produces (yield unit must convert)                                                               | recipe page, `setRecipeOutputProduct` |
| Orders    | `PRD-` planned at a site; ingredients needed vs usable shown; complete with actual output, lot and use-by; cancel; reverse from the order | `src/modules/production/service.ts`   |
| Posting   | One `PRO-` document: ingredients FEFO (gross, with waste), output at exactly their value (`costFromLines`); shortages refuse the batch    | `inventory/posting.ts`                |
| Lots      | Output lot (default the order number), use-by capped by the earliest ingredient lot                                                       | `completeProduction`                  |
| Genealogy | Lot trace shows "made from" (with unlotted inputs as gaps) and "used in batches"                                                          | `traceability/trace.ts`               |
| Plan      | Branch requisitions + reorder top-up − usable − planned, in whole batches; "plan it" prefills an order                                    | `/production/plan`                    |

Checks: `pnpm check` pass (unit 31 files / 186 tests; build);
`pnpm test:integration` 29 files / 198 tests pass (5 new: output only on
preparations and convertible units; FEFO across two lots, exact value 146
at moving average, use-by capped by the oldest lot, genealogy both ways,
generic reversal refused, reversal restores stock and value; shortage
refused and cancel; plan from a branch requisition in whole batches and
less what is planned; permissions, other tenants, trigger refuses reopening
a reversed batch; ledger and valuations reconcile afterwards);
`pnpm test:e2e` 35 tests pass (new: preparation set to produce a stock item,
oversized batch refused with the shortage and cancelled, 4 kg batch made at
80.00, stock value 200.00).

Found while testing: my own expectation priced ingredients per lot; costs
are a moving average per product and warehouse (ADR-021), so the batch
cost 146, not 144 — the test was corrected, not the rule.

Limitations: ingredients are taken for the planned quantity (no per-line
actual usage entry); recalls do not yet extend to output lots
automatically; no capacity or labour planning; fulfilment of branch
requests by shipment comes with M9b.

## M8c — Pilot readiness (delivered)

Rules: DECISIONS.md ADR-044.

| Area            | What works                                                                                                                                       | Where                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Backup          | `pnpm db:backup`: compressed custom-format dump + SHA-256                                                                                        | `scripts/backup.sh`           |
| Restore         | `pnpm db:restore`: checksum must match, target must be empty, tenant role recreated, one transaction, then verify                                | `scripts/restore.sh`          |
| Integrity check | `pnpm db:verify`: RLS + policy on tenant tables, balances = ledger, values = ledger + revaluations + landed costs, no negative stock, migrations | `scripts/verify-integrity.ts` |
| Drill           | Test database (1,651 orgs, 79 tables, 6.3 MB): backup 2.6 s, restore + verify 4.9 s; identical row counts; bad inputs refused                    | docs/OPERATIONS.md §3         |
| Runbooks        | Deploy, rollback, monitoring, backup/restore, integrity failures, incidents                                                                      | docs/OPERATIONS.md            |
| Security review | Controls with evidence; 3 findings fixed (service checks, headers, restore), 3 open with owners                                                  | docs/SECURITY_REVIEW.md       |
| Onboarding      | Pilot checklist from decisions to acceptance                                                                                                     | docs/PILOT_ONBOARDING.md      |

Checks: `pnpm check` pass (unit 31 files / 186 tests; build);
`pnpm test:integration` 28 files / 193 tests pass (1 new: an analyst is
refused roles, VAT setup and organization settings; those who use them are
not); `pnpm test:e2e` 34 tests pass with the new headers; `pnpm db:verify`
passes on the development and test databases; `pnpm audit --prod` reports no
known vulnerabilities; headers checked on the production build.

Found and fixed: three settings reads without a service-level permission
check; no CSP or HSTS; `.env.example` wrongly said tests reset the test
database.

Open before go-live: external penetration test, CSP script nonces, password
reset and 2FA (Q-10, Q-07), hosting and data residency (Q-03).

## M8b — Needs attention (delivered)

Rules: DECISIONS.md ADR-043.

| Area      | What works                                                                                                                                     | Where                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Stock     | Expired still available, expiring within 7 days, quarantine waiting, usable stock below the reorder minimum                                    | `analytics/attention.ts`  |
| Approvals | Purchase orders (not one's own), requisitions, counts, invoice exceptions (not one's own), labels and nutrition data to verify (not one's own) | `attentionItems`          |
| Money     | Overdue supplier invoices with open amount                                                                                                     | `attentionItems`          |
| Safety    | Open non-conformances, overdue corrective actions, active recalls                                                                              | `attentionItems`          |
| Screens   | Overview card (most urgent six) and `/attention`; each item links to where it is handled; EN/AR with plurals                                   | `/o/[slug]`, `/attention` |

Checks: `pnpm check` pass (unit 31 files / 186 tests; build);
`pnpm test:integration` 27 files / 192 tests pass (2 new: empty for a new
organization; expiring, quarantine, below minimum and an order to approve,
ordered by urgency; the buyer does not see their own order or quarantine
release; another branch's manager sees nothing); `pnpm test:e2e` 34 tests
pass (nutrition journey extended: the quality lead's overview shows the
product to verify, and the label to review opens from the attention page).

Limitations: nothing is pushed (no e-mail or push notifications until an
e-mail provider, Q-10, and background jobs exist); the 7-day expiry window
is fixed.

## M8a — Reports (delivered)

Rules: DECISIONS.md ADR-042.

| Area              | What works                                                                                                             | Where                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Waste             | Write-offs net of reversals by reason, product, warehouse, at stock value, by business date; unknown cost flagged      | `/reports/waste`, `analytics/service.ts` |
| Stock differences | Adjustments and count differences net of reversals (found stock negative)                                              | `/reports/waste`                         |
| Food cost         | Cost of sales ÷ net sales of imports wholly inside the period; straddling imports listed; % only with every net amount | `/reports/food-cost`                     |
| Branch comparison | Net sales, cost of sales, food cost %, waste, differences, cost incl. losses %, totals                                 | `/reports/food-cost`                     |
| Trend             | Food cost % per branch per month, 12 months                                                                            | `/reports/food-cost`                     |
| CSV               | Waste rows; branch comparison (amounts at the currency's decimals)                                                     | `…/export` routes                        |

Checks: `pnpm check` pass (lint, typecheck, unit 31 files / 186 tests — 3
new: ratios only with known sales, imports inside vs straddling a period,
month lists and ranges across a year end and leap February; build);
`pnpm test:integration` 26 files / 190 tests pass (3 new: waste and
differences net of a reversed write-off and found stock, warehouse filter,
CSV, invalid period; food cost per branch, straddling import excluded,
monthly trend, branch CSV; analyst sees all, branch manager only their
branch, procurement refused, other tenants empty); `pnpm test:e2e` 34
tests pass (new: write-off of 12.00, a sale of 10 for 100.00 → food cost
40 %, 52 % with waste, CSV).

Found and fixed in the tests: the new tests used the UTC date while waste is
dated in the organization's time zone, which would fail between midnight
in Cairo and midnight UTC; they now use the business date.

Limitations: no charts (tables only); an import spanning a period boundary
is not split; no per-product theoretical-vs-actual usage beyond count
differences; no scheduled e-mailed reports (no e-mail provider, Q-10).

## M5b — Ingredient library (delivered)

Rules: DECISIONS.md ADR-041.

| Area            | What works                                                                                                                                                        | Where                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| USDA FDC        | JSON downloads (Foundation, SR Legacy, Survey, Branded) and API responses; nutrients by number and unit; sodium mg → g; choices noted                             | `library-parsers.ts` (pure, unit-tested)                        |
| Open Food Facts | Product / search JSON and JSONL dump; per-100 values; allergen and trace tags mapped to the 14; other tags kept                                                   | `library-parsers.ts`                                            |
| Wikidata        | Entity JSON: English and Arabic names                                                                                                                             | `library-parsers.ts`                                            |
| Import          | Upload up to 900 KB, or `pnpm library:import` for full downloads in idempotent parts of 2,000; a file is imported once; licence on each record                    | `src/modules/nutrition/library.ts`, `scripts/import-library.ts` |
| Use for product | Values as unverified DATABASE profile (not over spec/lab, plausibility-checked); allergens only where unknown, contradictions reported; Arabic name only if empty | `linkReferenceFood`                                             |
| Screens         | Library search by name / brand / id and source, record detail with licence and source link, import history; EN/AR                                                 | `/catalog/library`                                              |

Checks: `pnpm check` pass (lint, typecheck, unit 30 files / 183 tests — 4
new: FDC download and API formats with fallbacks, unit mismatch and no
derived salt; Open Food Facts tags, liquids, no-allergen note, JSON Lines
with bad lines; Wikidata labels; build); `pnpm test:integration` 25 files /
187 tests pass (3 new: import once per file with licence, update on a later
file, search; use for a product as unverified database values, implausible
values refused, Arabic name, allergens with a reported contradiction, spec
values not replaced; permissions and other tenants); `pnpm test:e2e` 33
tests pass (new: upload an Open Food Facts file, second upload skipped,
record with licence, use for a product, values unverified, sesame contains,
peanut may contain, milk still unknown). The command-line import was run
once against the development database with 2,500 placeholder records (2
parts, rerun skipped both); those records were removed afterwards.

Not verified here: the parsers follow the sources' published formats but
could not be run against real downloads — this environment cannot reach
fdc.nal.usda.gov, world.openfoodfacts.org or wikidata.org. Live search from
the app is therefore not built.

## M5a — Nutrition, allergens and labels (delivered)

Rules: DECISIONS.md ADR-040.

| Area            | What works                                                                                                                             | Where                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Allergens       | 14 allergens (EU Annex II; Codex 8 marked) per product: contains / may contain / free from / unknown, source, reference, history       | `src/modules/nutrition/service.ts`                            |
| Free from       | Needs a reference, never from a food database, counts only after a second person verifies                                              | `declareAllergens`, `verifyAllergenDeclarations`              |
| Nutrition       | Per 100 g or 100 ml, ten nutrients each optional, source and reference, plausibility checks, history, second-person verification       | `recordNutritionProfile`                                      |
| Recipe roll-up  | Through active sub-recipes with net (eaten) quantities; per nutrient unknown unless every ingredient has it; per portion and per 100 g | `rules.ts` (pure, unit-tested)                                |
| Labels          | Generated only from complete verified data; review by another person; stale data blocks approval; only approved labels print           | `/recipes/labels/[labelId]`                                   |
| Allergen matrix | Every active recipe × 14 allergens, printable                                                                                          | `/recipes/allergens`                                          |
| Screens         | Product and recipe "Nutrition and allergens" pages; EN/AR                                                                              | `/catalog/products/[id]/nutrition`, `/recipes/[id]/nutrition` |

Checks: `pnpm check` pass (lint, typecheck, unit 29 files / 179 tests — 7
new: basis amount per base unit through product conversions, per-nutrient
roll-up with missing and unverified products, incomplete recipes, allergen
roll-up precedence and verified free-from, products reached through
sub-recipes, label rounding, net explosion without waste; build);
`pnpm test:integration` 24 files / 184 tests pass (5 new: nothing known
without data; profile and free-from validation; roll-up through a
sub-recipe with waste excluded, second-person verification, weight needed
for the ingredient list, matrix; label generation, self-review refused,
rejection needs a reason, approval, stale label after new values, change
after generation blocks approval, supersede history; permissions, other
tenants, statements not editable in the database); `pnpm test:e2e` 32 tests
pass (new: chef enters values (saturates > fat refused) and statements
(free from without reference refused), dish shows 1,200 kcal and unknown
allergens, quality lead verifies, label generated as a draft, approved by
the quality lead, printable, matrix shows sesame).

Limitations: cooking losses and retention
factors are not modelled (per 100 g uses the yield weight entered); no
market-specific label layouts (Q-02); no front-of-pack schemes (e.g.
Nutri-Score); labels are not yet pushed to a POS or printer.

## M7c — Supplier payables (delivered)

Rules: DECISIONS.md ADR-039.

| Area         | What works                                                                                                                             | Where                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Payments     | `PAY-` with method and reference; applied per invoice or earliest due first; rest on account, applied later; amounts in currency units | `src/modules/invoices/payables.ts`   |
| Credit notes | `SCN-` with supplier number (unique per supplier), net + VAT at the rate on its date, reason; applied like payments                    | `recordCreditNote`                   |
| Void         | With a reason; reopens the invoices; settlements otherwise unchangeable (trigger); paid invoices cannot be cancelled                   | `voidSettlement`                     |
| Balances     | Per supplier on any date, aging (not due, 1–30, 31–60, 61–90, 90+ days past due), on-account amounts, totals                           | `/purchasing/payables`               |
| Statement    | Opening balance, documents with running balance, open invoices, unapplied settlements; record payment / credit note                    | `/purchasing/payables/[supplierId]`  |
| Input VAT    | Credit notes reduce input VAT in their period                                                                                          | `inputVatSummary`                    |
| Export       | Documents CSV (per VAT rate) and balanced journal CSV with the organization's own account codes (purchasing settings)                  | `src/modules/invoices/accounting.ts` |
| Invoices     | Paid / partly paid / unpaid status, settled and open amounts, payments and credits listed                                              | `/purchasing/invoices`               |

Checks: `pnpm check` pass (lint, typecheck, unit 28 files / 172 tests — 5
new: aging days and buckets incl. leap years, payment status, earliest-due
allocation with remainder, journal lines with and without VAT registration
and for credit notes and payments, always balanced; build);
`pnpm test:integration` 23 files / 179 tests pass (4 new: explicit and
oldest-first payments, on-account remainder applied later, over-allocation
refused, another supplier's invoice refused, too many decimals refused,
balances and aging on two dates, statement running balance, a paid invoice
cannot be cancelled, void reopens; credit note VAT, duplicate number,
zero-rated credit, input VAT net of credits, idempotent retry; documents
export, journal refused without accounts, formula-like account code
refused, balanced journal with VAT split; permissions — operations manager
and procurement cannot pay, read-only balances — other tenants, and a
settlement cannot be edited in the database); `pnpm test:e2e` 31 tests
pass (new: invoice of 300 → payment over-applied refused → 120 applied →
partly paid with 180 open → balance 180 → account codes → journal CSV).

Limitations: one currency (Q-05); no bank file import or reconciliation;
no payment approvals or scheduled payment runs; no supplier advances
before an invoice beyond "on account"; the journal format is generic CSV
(target ERP formats wait for Q-06); invoice price differences are still
not posted to stock value.

## M7b — Supplier invoices with 3-way match (delivered)

Rules: DECISIONS.md ADR-038.

| Area       | What works                                                                                                                                       | Where                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Invoice    | `PI-` number, supplier invoice no. (unique per supplier unless cancelled), invoice/due date (from payment terms), total as printed               | `src/modules/invoices/service.ts`   |
| Lines      | Goods from posted receipt lines of the supplier (defaults: open quantity, price charged on receiving); charges with net amount                   | `addGoodsLine`, `addChargeLine`     |
| Match      | Price vs order price within the tolerance (purchasing settings), quantity vs received and not yet invoiced (drafts count), printed total = lines | `rules.ts` (pure, unit-tested)      |
| Exceptions | Approved with a note by another person; any change clears the approval; posting refused without it                                               | `approveException`, `postInvoice`   |
| VAT        | Per line at the rate on the invoice date (product, override or default purchase code); invoice date locked while there are lines                 | `loadTaxContextInTx` + `taxFromNet` |
| Input VAT  | Posted invoices by invoice date per code and rate; marked not reclaimable when not VAT registered; output − input shown as an estimate           | `/sales/vat`                        |
| Screens    | Invoices list with status filter, new invoice, detail (lines with match, received-to-invoice, charges, header, approve, post, cancel); EN/AR     | `/purchasing/invoices`              |

Checks: `pnpm check` pass (lint, typecheck, unit 27 files / 167 tests — new:
goods line match with tolerance and over-invoicing, total check per
currency unit, due date from terms, invoice status; build);
`pnpm test:integration` 22 files / 175 tests pass (5 new: matched invoice
with VAT, total mismatch then corrected and posted, duplicate supplier
number refused but allowed for another supplier, a draft line removes the
quantity from what is open; price variance needing a second person,
approval cleared by a change, over-invoicing across invoices, cancel and
re-use of the number; other supplier's and reversed receipts refused, date
locked with lines, due date before invoice date; 5 % rate for a 2020
invoice and the input VAT summary; permissions and other tenants);
`pnpm test:e2e` 30 tests pass (new: Egypt preset → order, receive 10 kg at
10 → invoice with a wrong total flagged → corrected → posted → input VAT
14.00 at 14 %, marked not reclaimable).

Found and fixed: the invoice page left a receipt line on offer after it was
fully put on the same draft (the open quantity ignored the invoice being
edited), inviting double entry; open quantity now counts every invoice that
is not cancelled.

Limitations: invoices do not change stock value (price differences are
reported only); payments and credit notes came with M7c;
base currency only; no PDF/e-invoice import (ZATCA / ETA XML) — entered by
hand; one approval level for exceptions.

## VAT setup — Saudi Arabia, Egypt, GCC (delivered)

Rules: DECISIONS.md ADR-037 (answers Q-02 for VAT).

| Area            | What works                                                                                                                                      | Where                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Country presets | SA 15 % (5 % before 2020-07-01), AE 5 %, BH 10 % (5 % before 2022), OM 5 %, EG 14 %; QA and KW: no VAT in force, no codes; sources shown        | `src/modules/tax/presets.ts`   |
| Codes and rates | STD / ZERO / EXEMPT / OOS per preset, own codes, new dated rates when the law changes; rates append-only                                        | `src/modules/tax/service.ts`   |
| Registration    | VAT registered flag, number format check per country (KSA 3…3, 15 digits; AE/BH 15; EG 9), prices incl./excl. VAT, default sales/purchase codes | `/settings/tax`                |
| Calculation     | Per line at the rate on the sale date; from net or from gross; rounded to the currency unit (3 decimals for BHD, KWD, OMR)                      | `rules.ts` (pure, unit-tested) |
| Sales import    | `net_amount` or `gross_amount`, optional `tax_code`; dish VAT code; code, rate, net, VAT and gross stored per line and per import               | `src/modules/sales/imports.ts` |
| Food cost       | Prices entered incl. VAT are converted to net for food cost % and margin                                                                        | `src/modules/recipes/menu.ts`  |
| VAT summary     | Output VAT by code and rate for a period, from imported sales                                                                                   | `/sales/vat`                   |

Checks: `pnpm check` pass (lint, typecheck, unit 26 files / 163 tests — 5 new:
currency units, rate on a date, VAT from net and from gross with rounding
incl. BHD, VAT number formats, presets; build); `pnpm test:integration` 21
files / 170 tests pass (5 new: Saudi preset with history and idempotent
re-apply; registration checks, append-only rates and admin-only changes;
VAT per sale line at the rate on its date incl. 5 % in 2019 and an exempt
override, with summary; net price in food cost and a zero-rated dish; Egypt
unregistered and Qatar without VAT); `pnpm test:e2e` 29 tests pass (new:
Saudi preset → invalid then valid VAT number → sale of 23.00 incl. VAT →
3.00 VAT → VAT summary).

Found and fixed: after a failed save, checkboxes in forms went back to
their initial state (React resets forms after an action), so correcting
the VAT number and saving again silently stored "not registered"; a shared
checkbox field now keeps the user's choice — also used for "activate now"
in bulk replacement and the line selection when ordering a requisition.

Limitations: no e-invoicing (ZATCA Fatoora phases, Egypt ETA e-invoice /
e-receipt — POS4); input VAT comes from supplier invoices (M7b); VAT
returns are not filed from here; the VAT country is not tied to the base
currency; special regimes (e.g. tourism, free zones) are left to the
organization's own codes.

## M7a — Sales import and recipe-based consumption (delivered)

Rules: DECISIONS.md ADR-036.

| Area        | What works                                                                                                                                | Where                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Import      | CSV per warehouse with template; dishes (portions), preparations (yield unit), products (base unit); net amount and channel kept as given | `src/modules/sales/imports.ts`      |
| Idempotency | External id posted once (partial unique index, serialized imports); re-uploads skip what was imported                                     | `importSales`                       |
| Explosion   | Through the active version and every sub-recipe, gross quantities with waste; version used stored per line                                | `explodeRecipe` (pure, unit-tested) |
| Consumption | One `CON-` document; FEFO over usable lots (expired and recalled excluded); cost of sales from moving average; visible in lot trace       | `inventory/consumption.ts`          |
| Validation  | All or nothing: unknown/ambiguous items, no active version, bad dates and numbers, duplicates in file, stock shortages — all listed       | `importSales`                       |
| Reversal    | From the import: stock restored, lines freed for re-import; generic reversal refused                                                      | `reverseSalesImport`                |
| Screens     | Sales (upload, history), import detail (sold items, stock used by lot, cost of sales, reverse); EN/AR                                     | `/sales`                            |

Checks: `pnpm check` pass (lint, typecheck, unit 25 files / 158 tests — new:
recipe explosion through sub-recipes with waste and its problems, calendar
date validation; build); `pnpm test:integration` 20 files / 165 tests pass
(5 new: dish and product sales use stock FEFO with exact cost of sales and
show in lot trace; re-upload posts nothing twice; every row and stock
problem listed with nothing posted; reversal frees lines for re-import and
generic reversal is refused; warehouse scope, roles and other tenants;
ledger and valuations reconcile afterwards); `pnpm test:e2e` 28 tests pass
(new: salad recipe → file with an unknown item rejected → 4 portions
imported → same file again skipped → cost of sales 40.00 → 8 kg left).

Found and fixed: date validators in purchasing, recipes and food safety
crashed (server error) on well-formed but impossible dates such as
2026-13-01 instead of reporting "invalid date"; all now use one tested
`isCalendarDate` helper. The traceability page note is updated now that
sales consume stock.

Limitations: no live POS connection (file import only); no refunds or
negative quantities; amounts are stored as given (no VAT until Q-02);
no theoretical-vs-actual usage report yet (planned with analytics, M8).

## M6b — Food safety records, checklists, corrective actions (delivered; M6 complete)

Rules: DECISIONS.md ADR-035.

| Area               | What works                                                                                                                              | Where                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Monitoring points  | Per branch, kind, °C limits (at least one), last reading shown, archive                                                                 | `src/modules/foodsafety/service.ts`            |
| Records            | Temperatures judged against the limits at the time (copied); pass/fail checks; immediate action required when out of spec; never edited | `addRecord`, `/food-safety/records`            |
| Checklists         | Yes/no and number items with ranges; complete per branch in one go; answers keep the item text and range; items retired, not deleted    | `completeChecklist`, `/food-safety/checklists` |
| Non-conformances   | Opened automatically from out-of-spec records and failed checklists, or by hand; root cause; severity; status flow                      | `nonconformances.ts`                           |
| Corrective actions | Owner (member), due date, overdue flag; done with a note; verified by someone else (service and DB); close only when all verified       | `completeAction`, `verifyAction`               |
| Overview           | Open non-conformances with overdue actions, recent out-of-spec records                                                                  | `/food-safety`                                 |
| Access             | `foodsafety.view` / `record` / `manage`, branch-scopable (data migration); other branches and tenants see nothing                       | `permissions.ts`                               |

Checks: `pnpm check` pass (lint, typecheck, unit 23 files / 154 tests — 3 new
for limits, closing, status and overdue rules; build); `pnpm test:integration`
19 files / 160 tests pass (5 new: readings against limits with automatic
non-conformance and undeletable records; pass/fail checks and refusals;
checklist snapshot, failures, one NC per run, answers append-only; NC flow
with overdue action, self-verification refused, verification by another
member, close; branch, role and tenant isolation); `pnpm test:e2e` 27 tests
pass (new: fridge 0–5 °C → 4 °C in spec → 8 °C needs action → NC opened →
action done, own verification blocked → failed checklist opens an NC).

Limitations: limits are set by each organization (no market defaults, Q-02);
no reminders for readings that were not taken (needs scheduling and
notifications, Q-10); no photo attachments (Q-08); checklist runs are
submitted in one go (no saving half-way).

## M6a — Lot traceability and recalls (delivered)

Rules: DECISIONS.md ADR-033 and ADR-034.

| Area         | What works                                                                                                                                 | Where                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Lot search   | By lot code, SKU or product name; recall hold shown                                                                                        | `src/modules/traceability/trace.ts`      |
| Trace        | Back to receipts (supplier and contact, PO, GRN, delivery note, temperature); forward to stock by place and status, shipments, all moves   | `traceLot`, `/traceability/lots/[lotId]` |
| Gaps         | Origins without a supplier and usage of the product without a lot where the lot was, listed explicitly; consumption not yet recorded noted | `summarizeTrace` (pure, unit-tested)     |
| Recall scope | Lots by search, or all lots received from a supplier (and product)                                                                         | `recalls.ts`, recall page                |
| Simulation   | Draft recall shows affected stock by place and status, in transit, suppliers; changes nothing                                              | `getRecall`                              |
| Going live   | Recall hold on the lots, stock snapshot, AVAILABLE/QUARANTINE → ON_HOLD in every warehouse via linked documents; shipments arrive on hold  | `activateRecall`, `recall-postings.ts`   |
| Closing      | Disposed (write-off of held stock) or released (hold lifted, stock stays on hold); drafts can be cancelled; printable report               | `closeRecall`, `cancelRecall`            |
| Access       | `traceability.view`, `recalls.manage` (data migration); other tenants see nothing                                                          | `permissions.ts`                         |

Checks: `pnpm check` pass (lint, typecheck, unit 22 files / 151 tests — 4 new
for trace classification and gaps; build); `pnpm test:integration` 18 files /
155 tests pass (6 new: trace back to supplier and forward to MAIN, kitchen and
in-transit stock; gap for an opening-balance lot; search by code, product
and supplier; recall simulation → live hold in two warehouses → recalled
lot refused for transfer → shipment arrives on hold → disposal; release
leaving stock on hold; wrong states, permissions and other tenants; ledger
and valuations reconcile afterwards); `pnpm test:e2e` 26 tests pass (new:
receipt with lot → trace to Delta Mills → recall draft simulation → live,
on hold → disposed, 0 kg on hand).

Found and fixed: the application role could not update lots at all, so
activating a recall failed; it may now update only `recall_hold`. Goods in
transit during a recall would have arrived as available (though blocked by
the hold); they now arrive on hold.

Limitations: no production yet, so no input → output lot links; sales do
not consume stock until M7; no customer notification list (needs sales).

## M4b — Menu pricing and recipe tools (delivered; M4 complete)

Rules: DECISIONS.md ADR-032.

| Area             | What works                                                                                                                                | Where                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Selling prices   | Per dish, excl. VAT, effective date, history; today's price used                                                                          | `src/modules/recipes/menu.ts`         |
| Targets          | Organization target food cost % and per-dish override; no invented default                                                                | `/recipes/food-cost`, recipe page     |
| Food cost report | Every active dish: cost per portion, price, food cost %, target, margin, price for target, status (above target, incomplete, no price, …) | `foodCostReport`, `pricing.ts`        |
| Price simulator  | What-if cost for one product → before/after for every dish using it (also via preparations); nothing stored                               | `simulatePrice`, `/recipes/simulator` |
| Bulk replacement | Product A → B (× factor) in selected recipes as new versions, optionally activated; skips reported (open draft, not used, unit)           | `bulkReplaceIngredient`               |
| Recipe card      | Printable card with yield, net and gross quantities, method; costs only on request and with permission                                    | `/recipes/…/card`                     |
| Screens          | Kitchen menu: Recipes, Food cost, Price simulator, Replace ingredient; EN/AR                                                              | `src/app/o/[orgSlug]/recipes/`        |

Checks: `pnpm check` pass (lint, typecheck, unit 21 files / 147 tests — new:
food cost %, price for target, status rules incl. never judging incomplete
costs, simulated costs through sub-recipes; build); `pnpm test:integration`
17 files / 149 tests pass (6 new: price history and today's price, target
classification with per-dish override, simulator storing nothing, bulk
replacement with activation and every skip reason, method locked with the
version, permissions and other tenants); `pnpm test:e2e` 25 tests pass (new:
standard cost → dish 10.00 with method → card → price 25 → target 30 % → above
target, 33.34 suggested → simulator 15.00 → replace with activation → 20.00).

Found and fixed: after a successful replacement the page no longer listed
the recipe, so the form — and its result message — disappeared; the form
now stays mounted.

Limitations: one price per dish (branch/channel prices with POS1); prices
exclude VAT until M7; the simulator changes one product at a time; no
popularity data yet for menu engineering (needs sales, M7/M8).

## M4a — Recipes, versions and food cost (delivered)

Rules: DECISIONS.md ADR-030 and ADR-031.

| Area           | What works                                                                                                                                          | Where                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Recipes        | Dishes (per portion) and preparations (per yield unit), EN/AR names, search and filters, archive (refused while used)                               | `src/modules/recipes/recipes.ts`       |
| Versions       | Draft → active → retired; one active and one draft; new version copies ingredients; discard drafts; active versions locked by DB triggers           | `recipes.ts`, migration `…_m4_recipes` |
| Ingredients    | Product or sub-recipe, net quantity in any convertible unit, waste % (gross = net ÷ (1 − waste)); cycles refused on add and on activation           | `addIngredient`, `createsCycle`        |
| Cost sources   | Stock average (organization or one warehouse), last purchase price, standard cost by date; chosen source first, others as fallback, source per line | `costs.ts`, `costing.ts` (pure)        |
| Missing costs  | Lines without any cost, with units that do not convert or sub-recipes without an active version are flagged and excluded — never estimated          | `costVersion`                          |
| Snapshots      | Stored on activation and on demand with the full breakdown; history per recipe; stored values never change when prices do                           | `snapshotInTx`, `/recipes/snapshots/…` |
| Standard costs | Per product with effective date, history on the product page                                                                                        | product page                           |
| Access         | `recipes.view`, `recipes.manage`, `recipes.costs.view` (data migration); costs hidden without the permission; other tenants see nothing             | `permissions.ts`                       |
| Screens        | Recipes list, new recipe, recipe (versions, cost history, used in), version (ingredients, yield, live cost with source/warehouse, activate), EN/AR  | `/recipes`                             |

Checks: `pnpm check` pass (lint, typecheck, unit 20 files / 144 tests — 7 new
for the costing engine: waste, source order, sub-recipes, portions, missing
costs, cycles; build); `pnpm test:integration` 16 files / 143 tests pass (7
new: preparation with waste and snapshot, DB triggers refusing changes to an
active version, warehouse vs organization average, dish through a
sub-recipe with last purchase price and a missing cost, recalculation after
revaluation with unchanged snapshots, versions and drafts, cycles and other
refusals, standard cost history, permissions and other tenants);
`pnpm test:e2e` 24 tests pass (new: standard cost → stock → sauce with waste
68.00 → activate and lock → pasta 4.25 per portion → cost history).

Limitations: no selling prices or food-cost % yet (M4b); landed cost is not
part of the last purchase price; one cost per product × source (no supplier
choice); nutrition and allergens come in M5; stock is not yet consumed by
recipes (M7 sales, production later).

## M3c part 4 — Purchase requisitions (delivered; M3 complete)

Rules: DECISIONS.md ADR-029.

| Area       | What works                                                                                                                                 | Where                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Requesting | `REQ-` numbered request for a warehouse, needed-by date, lines in any convertible unit (one per product), submit, cancel with a reason     | `src/modules/procurement/requisitions.ts` |
| Ordering   | Buyer picks a supplier and open lines → one draft PO at entered prices (supplier's last price offered only in the same unit); repeatable   | `orderRequisition`                        |
| Decisions  | Reject (nothing ordered), close (partly ordered), cancel — each with a reason, shown on the page                                           | `rejectRequisition`, `closeRequisition`   |
| Links      | Each line links to its PO line; removing it from a draft or cancelling the PO frees the line and recomputes the status                     | `requisition-links.ts`, `orders.ts`       |
| Access     | New scopable `purchasing.request` (data migration for existing organizations); branch users see only their warehouses; other tenants: none | `permissions.ts`, migration               |
| Screens    | List with status filter, new requisition, detail with lines, submit, supplier choice, order form, reject/close/cancel; EN/AR               | `/purchasing/requisitions`                |

Checks: `pnpm check` pass (lint, typecheck, unit 19 files / 137 tests — new
requisition status and action rules, build); `pnpm test:integration` 15 files
/ 136 tests pass (new: request → order in steps → line freed by removing the
PO line → fully ordered → freed by cancelling the PO; reject/close/cancel
states and reasons; branch, role and tenant isolation; permission-migration
sync); `pnpm test:e2e` 23 tests pass (new: requisition → supplier → price
required → draft PO 2,200 → requisition ordered).

Limitations: requisitions have no approval step of their own (Q-04); one
supplier per draft order (repeat for others); no merging into an existing
draft order; quantities cannot be changed while ordering (edit the draft
order instead).

## M3c part 3 — Landed cost (delivered)

Rules: DECISIONS.md ADR-028 (extends ADR-021).

| Area       | What works                                                                                                                                       | Where                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Charges    | Freight, customs duty, insurance, handling, other — amount, reference, note — on a posted receipt; each its own `LCA-` document; idempotent      | `src/modules/procurement/landed-costs.ts`              |
| Allocation | By line value at the charged price, or by quantity when all lines share a base unit; exact to 0.0001 (largest remainder)                         | `allocateCharge` (pure, unit-tested)                   |
| Valuation  | Only the share for units still on hand is added to the average cost; the rest is recorded as expensed; before/after value and cost per line kept | `addLandedCost` (pure), `postLandedCost` in posting.ts |
| Safeguards | Append-only tables with DB checks; landed costs cannot be reversed; receipts with landed costs cannot be reversed; reconciliation includes them  | migration, `reconcileValuations`                       |
| Access     | `inventory.valuation.revalue` at the receipt's warehouse; other tenants get not found; amounts on stock documents hidden without valuation view  | `landed-costs.ts`, `queries.ts`                        |
| Screens    | Landed-cost card on the receipt page (list, add form, per-line share), link from the stock document; EN/AR                                       | `/purchasing/receipts/[receiptId]`                     |

Checks: `pnpm check` pass (lint, typecheck, unit 19 files / 135 tests — 8 new
for allocation and capitalization, build); `pnpm test:integration` 14 files /
133 tests pass (new: by value with partly used stock, by quantity, retry with
the same key, reversals refused, mixed units, free goods, permission, other
tenant, reversed receipt; valuations reconcile afterwards); `pnpm test:e2e`
22 tests pass (new: order → receipt → freight → stock value 2,300).

Limitations: base currency only (Q-05); no allocation by weight or volume;
one charge covers one receipt; no link to the carrier's invoice yet (M7).

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
