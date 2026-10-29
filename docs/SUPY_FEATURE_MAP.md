# Supy capability map and gap analysis

Last updated: 2026-10-29

This document lists the capabilities that Supy (supy.io, a restaurant
back-office platform) describes publicly. Each one is mapped against Food
Ambassador: what exists today, what is partly there, what is missing, and
which milestone covers it. The descriptions are our own summaries of public
marketing pages, help-centre titles and marketplace listings. No Supy text,
branding or UI is reused. Their pages are vendor claims, and we have not used
the product.

Status legend: ✅ have · 🟡 partial · ⬜ planned (in an existing milestone) ·
🆕 not yet in the plan (proposed below).

## 1. Account structure and access

| Capability                                  | Food Ambassador                                                                  | Status | Milestone |
| ------------------------------------------- | -------------------------------------------------------------------------------- | ------ | --------- |
| Multi-branch / multi-location organization  | Organizations → branches → warehouses → storage locations                        | ✅     | M1        |
| Role-based permissions                      | Permission catalogue, custom roles, org/branch/warehouse scopes, last-owner lock | ✅     | M1        |
| Multi-language                              | English and Arabic, full RTL                                                     | ✅     | M1        |
| Item repository (central product catalogue) | Products, EN/AR names, units, pack conversions, GS1 barcodes, lot/expiry modes   | ✅     | M2        |
| Product categories / groups                 | Not yet (Q-13)                                                                   | 🟡     | M3        |
| Mobile apps (native iOS/Android)            | Responsive web, tested at phone width; no native app, no offline mode            | 🟡     | backlog   |

## 2. Inventory

| Capability                                               | Food Ambassador                                                                   | Status | Milestone |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | ------ | --------- |
| Real-time stock by location                              | Ledger-backed balances per warehouse/location/lot/status                          | ✅     | M2        |
| Stock counts with variance                               | Count sheets, blind counting, system quantity captured per line, approve and post | ✅     | M2        |
| Count templates (saved item lists, count order by shelf) | Count sheet is generated from balances each time; no saved templates              | 🆕     | proposed  |
| Wastage logging                                          | Write-offs with reason, including expired stock                                   | ✅     | M2        |
| Wastage analysis and reporting                           | Write-offs are recorded; no reports yet                                           | ⬜     | M8        |
| Transfers between locations                              | Immediate transfers only (ADR-016)                                                | 🟡     | M3        |
| Transfer requests → send → receive (incoming/outgoing)   | In-transit stage and request workflow are on the M3 backlog                       | ⬜     | M3        |
| Theoretical vs actual usage (variance to sales)          | Needs recipe-based consumption from sales                                         | ⬜     | M7        |
| Expiry tracking and FEFO                                 | Expiry by business date, FEFO suggestions, expired stock unusable                 | ✅     | M2        |
| Stock valuation / COGS                                   | Unit cost captured; no valuation until Q-01 is decided                            | ⬜     | M3        |

## 3. Procurement

| Capability                                         | Food Ambassador                                             | Status | Milestone |
| -------------------------------------------------- | ----------------------------------------------------------- | ------ | --------- |
| Supplier records and supplier item catalogues      | Planned: suppliers, supplier products, prices, pack sizes   | ⬜     | M3        |
| Requisitions and approvals                         | Planned (approval rules: Q-04)                              | ⬜     | M3        |
| Purchase orders                                    | Planned                                                     | ⬜     | M3        |
| Goods receipt (partial, rejected, quarantined)     | Planned; the ledger already supports quarantine/hold/reject | ⬜     | M3        |
| Par levels and suggested order quantities          | Not in the plan                                             | 🆕     | proposed  |
| Sending POs to suppliers by email                  | Needs an email provider (Q-10)                              | ⬜     | M3        |
| Sending POs by WhatsApp                            | Not in the plan; needs a WhatsApp Business provider         | 🆕     | proposed  |
| Supplier performance (on-time, fill rate, quality) | Planned                                                     | ⬜     | M3 / M8   |
| Price-change tracking per supplier item            | Partly implied by cost history; not explicit                | 🆕     | proposed  |

## 4. Invoices and settlements

| Capability                                             | Food Ambassador                                                      | Status | Milestone |
| ------------------------------------------------------ | -------------------------------------------------------------------- | ------ | --------- |
| Supplier invoice capture                               | Planned (manual entry first)                                         | ⬜     | M7        |
| Invoice reading from email/photo (OCR / AI extraction) | Not in the plan. Must always be reviewed by a person before posting. | 🆕     | proposed  |
| Matching invoice ↔ PO ↔ receipt, discrepancy flags     | Planned (3-way match)                                                | ⬜     | M7        |
| Credit notes for short/rejected deliveries             | Not explicit in the plan                                             | 🆕     | proposed  |
| Statements of account, supplier balances, settlements  | Planned                                                              | ⬜     | M7        |

## 5. Recipes and menu engineering

| Capability                                                   | Food Ambassador                                   | Status | Milestone |
| ------------------------------------------------------------ | ------------------------------------------------- | ------ | --------- |
| Recipes and sub-recipes with yields                          | Planned                                           | ⬜     | M4        |
| Recipe cost from current ingredient prices                   | Planned (cost source + effective date, snapshots) | ⬜     | M4        |
| Alerts when a dish margin moves past a threshold             | Not explicit                                      | 🆕     | proposed  |
| Price / food-cost simulator ("what if I sell at X")          | Not explicit; cheap once M4 costing exists        | 🆕     | proposed  |
| Bulk replace an ingredient across many recipes               | Not explicit; must create new recipe versions     | 🆕     | proposed  |
| Menu engineering (popularity × profitability classification) | Needs sales (M7) and recipe costs (M4)            | ⬜     | M8        |

## 6. Sales and POS

| Capability                               | Food Ambassador                                                                             | Status | Milestone |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------ | --------- |
| Import sales and deplete stock by recipe | Planned with idempotent file import first                                                   | ⬜     | M7        |
| Live POS connector (e.g. Foodics)        | Not claimed until built and tested against the real API; connector framework proposed below | 🆕     | proposed  |

## 7. Central kitchen and B2B

| Capability                                                        | Food Ambassador                                               | Status | Milestone |
| ----------------------------------------------------------------- | ------------------------------------------------------------- | ------ | --------- |
| Production planning (what to produce, from branch demand)         | Not in the plan                                               | 🆕     | proposed  |
| Production orders: consume ingredients, produce batches with lots | Not in the plan; builds on recipes (M4) and traceability (M6) | 🆕     | proposed  |
| Internal orders from branches to the central kitchen              | Partly covered by the transfer-request work in M3             | 🟡     | M3        |
| External B2B customers: orders, delivery notes, sales invoices    | Not in the plan                                               | 🆕     | proposed  |

## 8. Accounting and other integrations

| Capability                                         | Food Ambassador                                                     | Status | Milestone |
| -------------------------------------------------- | ------------------------------------------------------------------- | ------ | --------- |
| Accounting export                                  | Planned as export files                                             | ⬜     | M7        |
| Push supplier bills to Xero (draft), sync contacts | Not in the plan; needs Xero OAuth and sandbox testing               | 🆕     | proposed  |
| Large integration catalogue ("75+")                | Not claimed. Each integration is added only once tested end to end. | —      | —         |

## 9. Analytics

| Capability                                                | Food Ambassador   | Status | Milestone |
| --------------------------------------------------------- | ----------------- | ------ | --------- |
| Inventory dashboard (stock, expiry, recent documents)     | Real figures only | ✅     | M2        |
| Food cost, variance, wastage, supplier and branch reports | Planned           | ⬜     | M8        |

## 10. Where Food Ambassador already goes further

These are areas where Supy's public pages say little:

- **Food safety** (temperature logs, checklists, CAPA) and **traceability**
  with recall simulation (M6).
- **Nutrition and allergens**, with explicit "unknown" status and an
  approval gate (M5).
- **Lot-level inventory integrity**: append-only ledger, database-enforced
  tenant isolation, and no negative stock.

---

## Proposed plan changes

We keep M3–M8 as planned and add the new items in three places:

**Folded into existing milestones** (small, natural extensions):

| Item                                                    | Milestone |
| ------------------------------------------------------- | --------- |
| Product categories (Q-13)                               | M3        |
| Par levels + suggested order quantities per warehouse   | M3        |
| Supplier item price history                             | M3        |
| Count templates                                         | M3        |
| Margin alerts, price simulator, bulk ingredient replace | M4        |
| Credit notes for short/rejected deliveries              | M7        |

**New milestone M9 — Central kitchen and B2B** (after M4 and M6):
production planning, production orders that consume ingredients and produce
lot-tracked batches, internal branch orders, external B2B customers with
orders, delivery notes and sales invoices.

**New milestone M10 — Integrations** (after M7): connector framework (OAuth
credentials stored encrypted, webhook verification, idempotent sync, retry,
audit), then one integration at a time — POS sales (e.g. Foodics), Xero
bills, PO delivery via WhatsApp Business. Invoice OCR is also here because it
depends on an external extraction service. Every extracted value must be
confirmed by a person before posting. Each connector is marked "available"
only after testing against the provider's real sandbox.

**Backlog (not scheduled):** installable PWA with offline stock counting;
native mobile apps.

## Sources

- [Supy on the Foodics marketplace](https://www.foodics.com/portfolio/supy)
- [Supy — restaurant procurement software](https://supy.io/en-au/platform/restaurant-procurement-software)
- [Supy — central kitchen](https://supy.io/platform/central-kitchen-management-software)
- [Supy — inventory transfers](https://supy.io/product-features/inventory-transfers)
- [Supy vs MarketMan comparison page](https://supy.io/platform-comparison/supy-vs-marketman)
- [Supy vs Loaded Reports comparison page](https://supy.io/zh-cn/platform-comparison/supy-vs-loaded-reports)
- [Supy accounting integration on the Xero App Store](https://apps.xero.com/app/supy-accounting-integration)
- [Supy help centre: account structure](https://help.supy.io/en/articles/11121985-account-structure-and-settings)
- [Supy help centre: receiving a transfer](https://help.supy.io/en/articles/11122441-how-to-receive-a-transfer)
