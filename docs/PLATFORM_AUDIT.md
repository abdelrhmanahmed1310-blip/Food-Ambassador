# Food Ambassador — Platform audit and enterprise roadmap

> Progress: D1 decided (companies = legal entities). **F1a built** (ADR-082):
> companies, brands, branch → company/brand. **F1b step 1 built** (ADR-083):
> company on money documents, dashboard by company. **F1b step 2a built**
> (ADR-084): VAT registration and rates per company. **Step 2b built**
> (ADR-085): ZATCA seller and units per company. **Step 3 built**
> (ADR-086): company currency for stock, purchasing, payables, POS, B2B and
> reports, group figures converted. F1 is complete. **F2a built**
> (ADR-087): job runner and in-app notification centre. **F2b built**
> (ADR-088): global search. **F2c built** (ADR-089): Excel exports and PDF
> purchase orders and sales invoices. **F2d built** (ADR-090): read-only REST
> API v1 with API keys and OpenAPI. F2 is complete. **C1a built** (ADR-091):
> supplier approval and blocking, licences and certificates with expiry,
> encrypted bank accounts verified by a second person. **C1b built**
> (ADR-092): requests for quotation, quotations, comparison in the company
> currency and award to draft orders. Next in C1: PO revisions, supplier
> returns, price variance and spend.

Date: 2026-11-02. Scope: the whole repository on `milestone-0-foundation`
(commit after HR2b). Purpose: answer the "Master product development
prompt" (16 modules) with an evidence-based audit **before** any further
building. Nothing in the application was changed to write this document.

Status words used below:

- **Built** — backend, database, UI and tests exist and pass.
- **Partial** — part of the capability is built; the gap is named.
- **Not started** — nothing yet.
- **Unvalidated** — built and tested against a simulated service only,
  because the real service is unreachable from the build environment.

---

## 1. Existing architecture assessment

### 1.1 Stack and size

| Item               | Today                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application        | Next.js 16 (App Router, React 19 server components and server actions), TypeScript strict, one deployable                                                                   |
| Database           | PostgreSQL 16, Prisma 7; **152 tables**, 102 enums, **55 migrations** (hand-written constraints, triggers, row-level security in each)                                      |
| Auth               | Better Auth (email + password, optional TOTP two-step with backup codes), DB-validated sessions, rate limits                                                                |
| Tenancy            | Organization = tenant. Every tenant table has `organization_id`, composite tenant foreign keys, and PostgreSQL **row-level security** under a restricted role (`fa_tenant`) |
| Authorization      | 64 permissions; system roles per organization, custom roles; grants scoped to organization, branch or warehouse                                                             |
| Languages          | English and Arabic (RTL) via next-intl; Latin digits for amounts                                                                                                            |
| Money / quantities | `decimal.js` + `NUMERIC` columns; never JS floats                                                                                                                           |
| Integrations       | Signed inbound webhooks (sales, delivery platforms, attendance devices), outbound webhooks with retries, encrypted connector secrets; ZATCA Phase 2; Moyasar pay-by-link    |
| Offline            | Installable web app (PWA) with an offline cashier queue; Android/iOS store-app projects wrap it                                                                             |
| Security           | Strict CSP with per-request nonces, HSTS, attachment virus scanning (ClamAV), PDPL erasure for customers, audit log (append-only)                                           |
| Code               | ≈101 k lines of TypeScript (excluding generated client); business logic in `src/modules/<domain>` (29 domains), pages thin                                                  |
| Tests              | 53 unit files (275 tests), 55 integration files (361 tests, real PostgreSQL incl. cross-tenant), 45 end-to-end specs (59 tests, production build)                           |
| Decisions          | 81 architecture decision records (DECISIONS.md)                                                                                                                             |
| Hosting            | Demo on Render (Frankfurt) from `render.yaml`; production hosting open (Q-03)                                                                                               |

### 1.2 Strengths to keep

1. **Ledger-only inventory**: every stock change is a posting with a
   document; balances are a locked projection; reconciliation test proves
   balances = ledger. No negative stock.
2. **Defence-in-depth tenancy**: app filters + composite FKs + RLS;
   cross-tenant tests in every integration suite.
3. **Immutable records with database triggers** (posted documents, POS
   orders, punches, leave requests, ZATCA chain, payouts).
4. **Audit trail in the same transaction** as every important change;
   approvals keep user and timestamp.
5. **Honest integrations**: everything not tested against the real service
   is labelled unvalidated in the UI and docs.
6. **Domain modules with pure rule files** (testable calculations).

### 1.3 Limitations and technical debt

| #   | Limitation                                                                                                                               | Impact                                                                                              | Proposed answer                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| L1  | **One organization = one legal entity**: base currency, VAT settings and ZATCA seller are per organization. No company or brand layer.   | Blocks Module 14 (multi-company, multi-country in one tenant, brands, intercompany, consolidation). | Add `companies` and `brands` under the organization (§4). Backward compatible: one default company per existing organization. |
| L2  | **No public API**: server actions + webhooks only.                                                                                       | Blocks "API-first", ERP/BI/accounting integrations beyond CSV exports.                              | Versioned REST API (`/api/v1`) with API keys / OAuth client credentials, OpenAPI document, same services and permissions.     |
| L3  | **No general job runner / scheduler**: retries exist per feature (outbound webhooks, ZATCA reporting), daily checks are cron-documented. | Notifications, forecasts, expiry alerts, scheduled reports need it.                                 | One PostgreSQL-backed job table with workers (no new infrastructure), idempotent jobs.                                        |
| L4  | **No notification engine / centre**; no email provider (Q-10), so no password reset by email.                                            | Approvals, expiry and alerts rely on users opening pages.                                           | In-app notification centre first; email/SMS/WhatsApp adapters once providers are chosen.                                      |
| L5  | **Exports are CSV and print pages**; no Excel/PDF generation, no global search, no saved filters.                                        | UX requirements in §5 of the prompt.                                                                | XLSX + PDF export service; global search over master data and documents.                                                      |
| L6  | **Real-time by polling** (kitchen screens and boards refresh every few seconds).                                                         | Acceptable today; scale and latency later.                                                          | Server-sent events for KDS, boards and notifications.                                                                         |
| L7  | Some large service files (POS service ≈1 700 lines).                                                                                     | Maintainability.                                                                                    | Split by sub-domain when next touched (no behaviour change).                                                                  |
| L8  | End-to-end suite ≈6 min; two timing-related test fixes this week.                                                                        | CI time, flakiness.                                                                                 | Shard the suite; keep "wait for the saved state" pattern.                                                                     |
| L9  | Unvalidated: ZATCA (gw-fatoora blocked), Moyasar, native delivery adapters.                                                              | Go-live risk in KSA.                                                                                | Network allowlist + sandbox credentials (owner action).                                                                       |

---

## 2. Current vs proposed functionality matrix (summary)

| Module                        | Status                             | Evidence (built)                                                                                                                                                                                                                                                                                                                                                                                                             | Main gaps                                                                                                                                                                                                                                                                        |
| ----------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 POS & sales                | **Largely built**                  | Dine-in, takeaway, delivery intake, web ordering and kiosks, floor plans, merge, held courses, modifiers, combos, recipe items, promotions, coupons, loyalty, gift cards, split by seat/evenly, cash/card/QR/gift card/platform payments, pay-in/out, voids, refunds, VAT, receipts, ZATCA, kitchen transmission, shifts with Z report and cash reconciliation, offline till                                                 | Customer-facing display, dedicated waiter app (PWA works on phones), sales analytics by employee/item/category, sales targets, multi-outlet consolidation report, customer order history page                                                                                    |
| 02 Inventory                  | **Largely built**                  | Products (raw, semi-finished, finished, packaging, consumable), units + conversions, barcodes, categories, storage and shelf life, statuses (available, quarantine, rejected, on hold, in transit), adjustments, transfers with transit, counts with approval, opening balances, reorder rules + suggestions, moving-average valuation and revaluation, lots + expiry, FEFO, quarantine release, recalls, waste, COGS on POS | Reserved stock, cycle-count programmes, stock aging, slow/non-moving, turnover, days on hand, stockout prediction, FIFO option                                                                                                                                                   |
| 03 Procurement & suppliers    | **Largely built**                  | Suppliers, supplier products and prices, price history, performance, requisitions with approval, POs with approval matrix, partial receiving, over-receipt tolerance, landed costs, foreign currency, supplier invoices with 3-way match, payments, credit notes, aging, accounting export                                                                                                                                   | Supplier approval/blocking workflow, certificates and licences with expiry, bank details, contracts, RFQs and quotation comparison, PO revisions, supplier returns as a document, purchase price variance report, spend analysis, supplier notifications, forecast-driven buying |
| 04 Warehouse (WMS)            | **Partial**                        | Warehouses, storage locations with temperature zones, transfers, FEFO picks in production, B2B deliveries, counts                                                                                                                                                                                                                                                                                                            | Zones (receiving/quarantine/picking/dispatch), directed put-away, pick lists and wave picking, packing, loading confirmation, receiving QC step, scanning (barcode/QR) on handhelds, productivity and utilisation                                                                |
| 05 Recipes & menu engineering | **Largely built**                  | Recipes with versions, preparations (sub-recipes), yield, portions, method, costing snapshots, selling price, food cost %, margin alerts, price simulator, ingredient replacement, allergens, nutrition, labels with approval, recipe card                                                                                                                                                                                   | Cooking losses per ingredient, substitutions, prep/cook times, images, labour and overhead cost, **menu engineering matrix** (stars, plowhorses, puzzles, dogs)                                                                                                                  |
| 06 Central kitchen            | **Largely built**                  | Production orders with FEFO consumption, costed output lots, genealogy, production plan, branch requisitions, B2B/branch fulfilment                                                                                                                                                                                                                                                                                          | Ingredient reservations, scheduling calendar, QC step on output, production variance report                                                                                                                                                                                      |
| 07 KDS                        | **Built (core)**                   | Stations, routing, tickets, timers vs target, bump, ready to the check, online orders                                                                                                                                                                                                                                                                                                                                        | Delay alerts, workload and station/staff performance, fulfilment-time reports                                                                                                                                                                                                    |
| 08 Food safety & quality      | **Partial**                        | Safety records (temperature, hygiene, cleaning, pest control), checkpoints (fridge, freezer, hot holding, cooking), checklists, non-conformances with CAPA, recalls with documents                                                                                                                                                                                                                                           | **HACCP plan** (hazards, CCPs, OPRPs, limits, monitoring/verification), **document control** (SOPs, versions, approval), audits, customer complaints, calibration and maintenance, training records, compliance scores, mock recall                                              |
| 09 Traceability & recall      | **Largely built**                  | Lot genealogy forward/backward, recall with affected lots/stock and documents, supplier lot references                                                                                                                                                                                                                                                                                                                       | POS-order-to-lot link per sale, one-click printable batch report, recall notifications, mock recall                                                                                                                                                                              |
| 10 Delivery & logistics       | **Partial**                        | Platform intake (HungerStation, Jahez, Keeta via plug-and-play; native unvalidated), payout reconciliation, B2B deliveries                                                                                                                                                                                                                                                                                                   | Own fleet, riders, dispatch, proof of delivery, routes, cold-chain temperature, logistics cost                                                                                                                                                                                   |
| 11 CRM & loyalty              | **Partial**                        | Customers with consent and PDPL erase, points, gift cards, coupons                                                                                                                                                                                                                                                                                                                                                           | Segments, campaigns, feedback and complaints, CLV, churn, personalised offers                                                                                                                                                                                                    |
| 12 Finance & cost control     | **Partial**                        | AP (invoices, payments, aging), AR (B2B), FX revaluation, accounting export, card settlements and delivery payouts reconciliation, food cost and waste reports, branch comparison                                                                                                                                                                                                                                            | Cost centres, budgets and budget vs actual, operating expenses, branch P&L / EBITDA, consolidated reporting across companies, PPV report                                                                                                                                         |
| 13 BI & AI                    | **Partial**                        | Overview dashboard (real POS data), reports with CSV, needs-attention list                                                                                                                                                                                                                                                                                                                                                   | Executive dashboard (sales growth, vs budget, turnover…), configurable dashboards, **AI assistant**, forecasting and predictions                                                                                                                                                 |
| 14 Multi-company & enterprise | **Partial**                        | Multi-organization users, branches, warehouses, scoped roles, approval matrix, multi-currency documents, AR/EN                                                                                                                                                                                                                                                                                                               | Companies (legal entities), brands, intercompany, consolidation, country-level configuration inside one organization (L1)                                                                                                                                                        |
| 15 Import/export & regulatory | **Not started** (landed cost only) | Landed costs in foreign currencies                                                                                                                                                                                                                                                                                                                                                                                           | Shipments, HS codes, origin, product registration (SFDA), certificates (origin, health, halal), permits, customs, packing lists, duty, document expiry                                                                                                                           |
| 16 Workforce                  | **Partial**                        | HRIS, documents with expiry, attendance (tablet/phone/device/HR), leave with approvals                                                                                                                                                                                                                                                                                                                                       | Rosters/shifts (next), training and competency, performance, labour cost, demand-based scheduling, payroll (Q-20)                                                                                                                                                                |
| Platform                      | **Partial**                        | Audit, RBAC, tenancy, backups runbook, health checks, error logging, webhooks                                                                                                                                                                                                                                                                                                                                                | Public API + docs (L2), job runner (L3), notifications (L4), XLSX/PDF, global search (L5), SSE (L6)                                                                                                                                                                              |

---

## 3. Module-by-module gap analysis (what to build, in order of value)

Each line is one shippable increment with database, backend, UI and tests.

**Module 14 / foundation first (it changes keys other modules use)**

1. Companies and brands; branches belong to a company and optionally a brand; tax and e-invoicing settings per company; consolidated reports by company.
2. Intercompany transfers (central kitchen in company A supplying branches of company B) with matching AR/AP documents.

**Module 01 POS** 3. Sales analytics: by item, category, employee, channel, branch, hour; targets per branch/day with progress. 4. Customer-facing display (second screen showing the order and total). 5. Customer order history on the customer page.

**Module 02 Inventory intelligence** 6. Stock aging, slow/non-moving, turnover, days on hand — computed from the ledger. 7. Reservations (production and sales orders reserve lots). 8. Cycle-count programmes (ABC classes, schedules).

**Module 03 Procurement** 9. Supplier compliance: approval workflow, blocking, certificates/licences with expiry alerts, bank details (encrypted, masked). 10. RFQs, quotations, comparison and award → PO. 11. PO revisions (versioned), supplier returns document, PPV and spend reports.

**Module 04 WMS** 12. Zones on locations; directed put-away rules; receiving QC step that routes to quarantine. 13. Pick lists (FEFO), wave picking, packing, loading confirmation. 14. Handheld scanning screens (camera barcode/QR + Bluetooth scanners as keyboard) for receiving, picking and counts.

**Module 05 Recipes** 15. Menu engineering matrix from real sales and recipe costs, with recommendations. 16. Ingredient losses, substitutions, times, images; labour and overhead rates (configurable).

**Module 06/07** 17. Reservations and scheduling for production; QC on output; variance report. 18. KDS delay alerts and performance reports.

**Module 08/09 Food safety (competitive advantage)** 19. Document control (SOPs, manual, work instructions) with versions and approval. 20. HACCP plan builder: process steps, hazards, CCP/OPRP decision, critical limits, monitoring linked to existing checkpoints and records, deviations → CAPA automatically. 21. Audits (internal/external) with findings → CAPA; customer complaints; calibration and maintenance. 22. Compliance score per outlet; mock recall exercise with timing; one-click batch report (PDF).

**Module 10 Logistics** 23. Own delivery: riders, dispatch, status, proof of delivery (photo/signature), cold-chain readings.

**Module 11 CRM** 24. Segments, campaigns (needs messaging providers), feedback and complaints, CLV.

**Module 12 Finance** 25. Cost centres, operating expenses, budgets, budget vs actual, branch P&L.

**Module 13 Intelligence** 26. Executive dashboard (configurable widgets). 27. Forecasting (transparent statistical baselines per item/branch: moving averages, seasonality by weekday), used by replenishment. 28. AI assistant: natural-language questions answered by calling the platform's own read services (same permissions), every answer citing the records and numbers it used; no invented figures.

**Module 15 Trade** 29. Import shipments (supplier, POs, containers, HS codes, origin, documents, duties, freight, insurance) feeding landed cost; certificates with expiry; configurable requirements per country/authority.

**Module 16 Workforce** 30. Rosters (next), training and competency (incl. food-handler certificates), performance, labour cost vs sales, payroll (after Q-20).

---

## 4. Proposed database architecture changes

Principles kept: one PostgreSQL database; every tenant table carries
`organization_id` with RLS; composite tenant FKs; `NUMERIC` for money and
quantities; immutable posted records; audit in the same transaction.

### 4.1 Enterprise layer (Module 14)

```
organizations (tenant / group)          -- unchanged; owns users, roles, master data
 ├─ companies (legal entity)            -- NEW: name, country, tax registration, base currency,
 │                                       --      VAT/e-invoicing settings, ZATCA seller
 ├─ brands                              -- NEW: name, logo; menus can be per brand
 └─ branches                            -- + company_id (required), brand_id (optional)
      └─ warehouses                     -- unchanged (company via branch)
```

- Migration: create one default company per organization from today's
  settings; set every branch's `company_id`; move tax/ZATCA settings
  reads to the company with a fallback period. No data loss, no URL change.
- Documents that carry money (POs, invoices, POS orders, sales invoices)
  get `company_id` (denormalised from the branch at creation, fixed).
- Master data (products, recipes, suppliers, customers) stays at the
  organization level and is shared; per-company overrides only where law
  requires (tax codes).

### 4.2 Platform tables

- `jobs` (queue: kind, payload, run_at, attempts, status, locked_by) and
  `job_runs`; `notifications` (user, kind, entity, read_at) and
  `notification_preferences`; `api_clients` (hashed keys, scopes,
  company/branch scope); `saved_views` (filters per user).

### 4.3 New domain tables (by phase)

| Phase        | Tables                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Procurement  | `supplier_documents` (type, number, expiry), `supplier_bank_accounts` (encrypted), `rfqs`, `rfq_lines`, `quotations`, `quotation_lines`, `po_revisions`, `supplier_returns`                                                          |
| WMS          | `location_zones`, `putaway_rules`, `pick_lists`, `pick_list_lines`, `pack_units`, `loads`                                                                                                                                            |
| Inventory    | `stock_reservations`, `count_programmes`                                                                                                                                                                                             |
| Food safety  | `fs_documents`, `fs_document_versions`, `haccp_plans`, `process_steps`, `hazards`, `control_points` (CCP/OPRP, limits), `audits`, `audit_findings`, `complaints`, `equipment`, `calibrations`, `maintenance_records`, `mock_recalls` |
| Logistics    | `riders`, `vehicles`, `dispatches`, `delivery_stops`, `proofs_of_delivery`, `transport_readings`                                                                                                                                     |
| CRM          | `customer_segments`, `campaigns`, `feedback`                                                                                                                                                                                         |
| Finance      | `cost_centres`, `expense_entries`, `budgets`, `budget_lines`                                                                                                                                                                         |
| Trade        | `shipments`, `shipment_lines`, `hs_codes`, `trade_documents`, `customs_entries`                                                                                                                                                      |
| Workforce    | `shift_templates`, `roster_shifts`, `trainings`, `training_records`, `competencies`                                                                                                                                                  |
| Intelligence | `forecasts` (item, branch, day, quantity, method, inputs hash), `ai_conversations` / `ai_answers` (question, tools called, cited records)                                                                                            |

---

## 5. Recommended roadmap and prioritisation

Ordering rule: (1) what changes shared keys first, (2) what removes
operational risk, (3) what pays back fastest for restaurants and central
kitchens, (4) intelligence once enough real data flows.

| Order | Phase                                                  | Content                                                                                                                                    | Why now                                                               | Depends on                 |
| ----- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------- |
| 1     | **F1 Enterprise layer**                                | Companies, brands, company-scoped tax/ZATCA, consolidated views                                                                            | Changes keys every later module uses; cheaper now than later          | —                          |
| 2     | **F2 Platform services**                               | Job runner, notification centre, XLSX/PDF export, global search, REST API v1 + OpenAPI                                                     | Needed by alerts, approvals, integrations and reports in every module | F1 (API scopes by company) |
| 3     | **HR2c Rosters** (in progress) + onboarding checklists | Lateness/overtime, labour cost                                                                                                             | Already started; payroll needs it                                     | —                          |
| 4     | **C1 Procurement compliance**                          | Supplier approval/blocking, certificates with expiry, bank details, RFQ/quotations, PO revisions, supplier returns, PPV/spend              | Supplier risk and cost control                                        | F2 (alerts)                |
| 5     | **C2 Food safety system**                              | Document control, HACCP plan builder linked to existing records, audits, complaints, calibration, compliance score, mock recall, batch PDF | Differentiator; builds on existing records/CAPA/recalls               | F2                         |
| 6     | **C3 WMS**                                             | Zones, put-away, pick lists, packing, loading, receiving QC, handheld scanning                                                             | Central kitchen and distributor operations                            | —                          |
| 7     | **C4 Analytics depth**                                 | Sales analytics and targets, stock aging/turnover/DOH, menu engineering, KDS performance                                                   | Immediate value from existing data                                    | F2 (exports)               |
| 8     | **C5 Finance control**                                 | Cost centres, expenses, budgets, branch P&L, consolidation                                                                                 | Needs F1 companies                                                    | F1                         |
| 9     | **C6 Trade**                                           | Import shipments, HS codes, certificates, customs, landed cost link                                                                        | Importers/distributors                                                | F1, C1                     |
| 10    | **C7 Logistics & CRM**                                 | Own fleet/POD/cold chain; segments, campaigns, feedback                                                                                    | Needs messaging providers for campaigns                               | F2 + providers             |
| 11    | **I1 Forecasting & replenishment**                     | Transparent forecasts → suggested orders and production                                                                                    | Needs history from live use                                           | C4                         |
| 12    | **I2 AI assistant**                                    | Natural-language Q&A over permitted data with citations                                                                                    | Needs provider decision and data governance                           | F2 API, I1                 |
| 13    | **HR4 Payroll**                                        | Dated country rules, payslips, WPS/Mudad files                                                                                             | Waits for Q-20 confirmations                                          | HR2c                       |

Each phase ships as testable increments (schema + service + UI + unit,
integration, cross-tenant and end-to-end tests + docs), like the
milestones so far.

---

## 6. Functionality that must be preserved

Every capability marked Built or Partial above, and these invariants:

1. Inventory changes only through ledger postings; balances equal the
   ledger; no negative stock; FEFO allocation; lot/expiry rules.
2. Decimal arithmetic and NUMERIC columns for money and quantities.
3. Tenant isolation (app filters, composite FKs, RLS) and cross-tenant tests.
4. Immutable posted documents, POS orders, punches, leave requests; voids
   and reversals instead of edits.
5. Audit events in the same transaction; approvals keep user and time; the
   approval matrix and the "nobody approves their own" rules.
6. ZATCA hash chain, counters and clearance/reporting flows; VAT presets
   for Saudi Arabia, Egypt and the GCC.
7. Offline cashier queue and idempotent order submission.
8. Strict CSP, 2FA, rate limits, encrypted connector secrets, attachment
   scanning, PDPL erasure, personal data kept out of audit logs.
9. Arabic/RTL parity for every new string; real data only on dashboards;
   demo data only in the explicit seed.
10. Existing URLs, permissions and role templates (new permissions are
    added to system roles by migration, never removed silently).

---

## 7. Decisions needed from the owner

| #   | Decision                                                                                                                                                            | Needed for                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| D1  | Confirm the company/brand model in §4.1 (one tenant per group, companies per country/legal entity)                                                                  | F1                                              |
| D2  | Email provider (Q-10), SMS and WhatsApp Business providers                                                                                                          | F2 notifications, CRM campaigns, password reset |
| D3  | AI provider and data rules (which data may leave the platform; region)                                                                                              | I2                                              |
| D4  | Production hosting and data residency (Q-03)                                                                                                                        | Go-live                                         |
| D5  | Handheld hardware for warehouses (Android scanners such as Zebra/Honeywell, or phones)                                                                              | C3                                              |
| D6  | Network access and sandbox credentials for ZATCA, Moyasar and delivery platforms                                                                                    | Validation (L9)                                 |
| D7  | Payroll rules per country (Q-20)                                                                                                                                    | HR4                                             |
| D8  | Benchmark references: access to Sapaad material (feature list or demo) if exact parity matters; this audit benchmarks against the capabilities listed in the prompt | Prioritisation                                  |
