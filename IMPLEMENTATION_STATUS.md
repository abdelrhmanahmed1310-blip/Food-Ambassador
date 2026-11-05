# Food Ambassador — Implementation Status

Last updated: 2026-11-05 (I2a AI assistant with Claude — live once a key passes the test; I1b forecast batches for the central kitchen — I1 complete; I1a demand forecasts and forecast-based orders; C7d campaigns, provider-neutral; C7c segments and feedback; C7b own riders; C7a own fleet; C6c customs and shipment charges — C6 complete; C6b trade documents; C6a import shipments; C5d consolidated P&L — C5 complete; C5c branch P&L; C5b branch budgets and budget against actual; C5a operating expenses; C4d kitchen performance — C4 complete; C4c menu engineering; C4b stock ageing and turnover; C4a sales analytics and targets; C3d handheld scanning — C3 complete; C3c packing and loading; C3b pick lists and waves; C3a receiving inspection and put-away; C2e compliance score, mock recalls, batch report — C2 complete; C2d equipment and calibration; C2c audits and complaints; C2b document control; C2a HACCP plans; C1e spend and price variance — C1 complete; C1d supplier returns; C1c purchase order revisions; C1b requests for quotation; C1a supplier compliance; F2d REST API v1 — F2 complete; F2c Excel and PDF; F2b global search; F2a job runner and notifications; F1b step 3 currency per company complete; step 2b ZATCA per company; step 2a VAT per company; F1a companies and brands; HR1–HR2b)

## Summary

| Milestone                     | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 Repository & architecture  | ✅ Complete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| M1 Application foundation     | ✅ Complete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| M2 Inventory MVP              | ✅ Complete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| M3 Procurement & receiving    | ✅ Complete — M3a valuation, M3b purchasing and receiving, M3c parts 1–4 (categories/reorder, shipments, landed cost, requisitions)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M4 Recipes & food cost        | ✅ Complete — M4a recipes, versions, cost sources, snapshots; M4b prices, food cost targets, simulator, bulk replace, recipe card                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| M6 Food safety & traceability | ✅ Complete — M6a traceability and recalls; M6b records, checklists, non-conformances and corrective actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| M7 Sales & finance            | ✅ Complete — M7a sales import and recipe consumption, VAT setup (KSA, Egypt, GCC), M7b supplier invoices with 3-way match, **M7c payables** (payments, credit notes, balances, aging, export)                                                                                                                                                                                                                                                                                                                                                                                                          |
| M5 Nutrition & allergens      | ✅ Complete — M5a allergens, nutrition, recipe roll-up, matrix, approved labels; **M5b ingredient library** (USDA FDC, Open Food Facts, Wikidata). Open: live lookup, market label layouts                                                                                                                                                                                                                                                                                                                                                                                                              |
| M8 Analytics & pilot          | ✅ Complete — M8a reports, M8b needs attention, **M8c pilot readiness** (backup/restore drill, integrity check, runbooks, security review, onboarding). Open before go-live: pen test, password reset (Q-10). 2FA (ADR-073) and CSP nonces (ADR-074) done                                                                                                                                                                                                                                                                                                                                               |
| M9 Central kitchen & B2B      | ✅ Complete — M9a production orders, plan, genealogy; **M9b** branch fulfilment from the kitchen, B2B orders, deliveries, invoices, receivables                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| M10 Integrations              | ✅ Framework — **M10a** connectors, signed inbound sales webhook, outbound event webhooks with outbox and retries. Named third-party connectors open                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POS1 – POS5                   | POS1 and POS2 complete. POS3a done; **POS3b pay by QR (Moyasar)** built — Moyasar validation pending. POS4a ZATCA and POS4b standard invoices with clearance built — ZATCA validation pending. Both need the network allowlist (api.moyasar.com, gw-fatoora.zatca.gov.sa). **POS5a discounts**, **POS5b customers, loyalty, gift cards** done; **POS5c delivery intake** built (native platform adapters pending specifications) with payout reconciliation; **POS5d online ordering and kiosks** and **POS5e** (prepayment — Moyasar validation pending, pick-up times, promotions, manual ready) done |

## I2a — AI assistant with Claude (built; live once a key passes the test)

Rules: DECISIONS.md ADR-122.

| Area       | What works                                                                                                           | Where                |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Set-up     | Anthropic key sealed, model (Opus 5.5 default, Sonnet 5.5, Haiku 5.5), daily limit, Test connection, switch on/off   | Settings → Assistant |
| Asking     | Plain-language questions and follow-ups; answers with links to the reports behind them and what was read             | Reports → Assistant  |
| Tools      | Sites, sales summary, stock levels, needs attention, demand forecast, reorder suggestions, branch P&L — as the asker | —                    |
| Governance | Business data only; e-mail addresses and phone numbers removed from questions; audit by tools read; 90-day retention | —                    |

Not live yet: no organization key has been tested here — the provider call was exercised up to authentication (a placeholder key is refused). Not yet: streaming, more tools (waste, food cost, menu engineering, spend, food safety), charts, usage reporting.

Checks: `pnpm check` pass (unit 393; new: removing e-mail addresses and phone numbers while keeping dates and document numbers, titles, key hints, exact decimal strings, the system prompt); `pnpm test:integration` 546/546 pass (new — with a scripted stand-in for Claude: off until a key is stored, tested and switched on; a bad key never switches it on; the key sealed and absent from audits and requests; two tools in one turn with both results sent back together and exact quantities; sources cited; the phone number in a question removed; no guest name, phone or key in anything sent; follow-ups carry the conversation; a warehouse-scoped keeper sees no other warehouse's stock and is refused the P&L; conversations private; cashiers and other organizations refused; the reading limit forces an answer; refusals, unknown tools and provider errors recorded; answers never edited; the daily limit; a new model needs a new test; deletion and 90-day retention); `pnpm test:e2e` 94/94 pass (new: assistant off, invalid key refused, a well-formed placeholder key saved and refused by the real provider on Test connection, no Switch on offered).

## I1b — Forecast batches for the central kitchen (built)

Rules: DECISIONS.md ADR-121.

| Area     | What works                                                                                                       | Where             |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ----------------- |
| Kitchen  | Forecast of what leaves the kitchen (use, deliveries, transfers to branches) against its usable stock            | Production → Plan |
| Branches | Or what all warehouses use (transfers excluded) against stock held anywhere, in transit included; totals only    | Production → Plan |
| Batches  | Next 1–14 days (default 2) plus safety stock at the service level, less stock and planned batches, whole batches | Production → Plan |
| Planning | "Plan forecast batches" opens a production order with that quantity, beside the requisition-based suggestion     | Production → Plan |

Not yet: ingredient planning for forecast batches, production calendars, per-branch forecasts shown to the kitchen, holidays and promotions.

Checks: `pnpm check` pass (unit 388); `pnpm test:integration` 539/539 pass (new — six weeks of backdated dispatches and branch use: 10 kg a day leaves the kitchen, forecast exactly; 12 batches of 5 kg over 14 days, 10 once 10 kg is planned; branches use 12 kg a day against 196 kg held anywhere, so no batches; no history, no forecast; service level applied; cover and basis validated; cashiers and other organizations refused); `pnpm test:e2e` 93/93 pass (extended production: "Not enough history" on the plan, cover and basis applied).

## I1a — Demand forecasts and forecast-based orders (built)

Rules: DECISIONS.md ADR-120.

| Area           | What works                                                                                                   | Where                        |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Demand         | Use, customer deliveries and transfers out per day from the ledger, net of reversals; 8 weeks shown per item | Purchasing → Demand forecast |
| Methods        | 28-day and 7-day averages, same weekday of the last 4 weeks; the most accurate over the last 14 days is used | Demand forecast              |
| Transparency   | Error (WAPE), bias, next 7 and 28 days; under 4 weeks of history says so instead of forecasting              | Demand forecast, CSV/Excel   |
| Forecast order | Lead time + review period, safety stock at the service level, less usable stock and open orders              | Reorder plan                 |
| Ordering       | Draft orders from min–max or forecast quantities; no lead time or price means no forecast line               | Reorder plan                 |
| Settings       | Review period (1–90 days, default 7) and service level (90/95/98/99 %, default 95 %)                         | Settings → Purchasing        |

Not yet: production forecasts for the central kitchen (I1b), seasonality beyond the week, holidays and promotions, stored forecasts to track accuracy over time. Imported sales count on the day they are imported.

Checks: `pnpm check` pass (unit 388; new: the three methods, same weekday ahead, backtest WAPE/bias/RMSE, method choice and ties, short history, order over lead time and review with safety stock and minimum order, weekly totals); `pnpm test:integration` 533/533 pass (new — six weeks of backdated use with a weekday pattern: transfers out count and transfers in, write-offs do not; the same-weekday method chosen with no error and the next 7 days forecast exactly; 10 days cover with no safety stock; no lead time and short history refused; a forecast draft order in 25 kg sacks at the last price while min–max orders nothing; an unknown basis refused; review period and service level validated and applied; cashiers and other organizations refused); `pnpm test:e2e` 93/93 pass (extended reorder: "Under 4 weeks of history" on the plan, the forecast page and its CSV, review period validated and saved with a 98 % service level).

## C7d — Campaigns, provider-neutral (built; sending waits for a provider)

Rules: DECISIONS.md ADR-119.

| Area        | What works                                                                                               | Where            |
| ----------- | -------------------------------------------------------------------------------------------------------- | ---------------- |
| Drafts      | SMS, WhatsApp or e-mail to a segment; `{name}`; leave out guests messaged recently; attribution window   | POS → Campaigns  |
| Audience    | In segment → agreed to offers → has a contact for the channel → not messaged recently, with each count   | campaign page    |
| Preview     | The message as a guest reads it, with its unsubscribe link; SMS parts by GSM-7 / UCS-2                   | campaign page    |
| Launch      | Recipients fixed, sent now or later; refused while no provider is connected (none is yet)                | campaign page    |
| Sending     | A job every minute; consent and erasure checked again per guest; no contact details stored on recipients | —                |
| Unsubscribe | Signed link in every message; the guest stops all offers; audited                                        | `/unsubscribe/…` |
| Results     | Sent, failed, left out, stopped offers; guests who came back, their orders and spend                     | campaign page    |

Not live: no SMS, WhatsApp or e-mail provider is connected — an adapter is added only after testing it with your account. Not yet: WhatsApp templates, e-mail HTML and domains, quiet hours and caps across campaigns, A/B variants, per-recipient coupons.

Checks: `pnpm check` pass (unit 379; new: SMS parts for GSM-7, extension characters and Arabic, placeholders, unsubscribe line); `pnpm test:integration` 527/527 pass (new — sending exercised with a recording stand-in provider available only in tests: unknown placeholders and an e-mail without subject refused; 3 in the segment, 2 consenting, 2 reachable; launch refused with no provider; branch managers cannot launch; one message delivered and one failing at the provider; the draft locked once launched; Sara comes back within 7 days — 1 order, 25.00; no phone numbers on recipients; a forged unsubscribe link refused, Sara stops offers and her consent is withdrawn; a later campaign leaves her out, is scheduled, not sent early, and cancelled; cashiers and other organizations refused); `pnpm test:e2e` 93/93 pass (new: a consenting guest at the till, a segment, a draft with 1 recipient, the preview with the unsubscribe link and GSM-7, launch refused with the no-provider message).

## C7c — Customer segments and guest feedback (built)

Rules: DECISIONS.md ADR-118.

| Area         | What works                                                                                                       | Where                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Segments     | Saved conditions on visits, recency, orders, spend, branches, consent and points; counts worked out live         | POS → Segments         |
| RFM          | Champions, loyal, new, at risk, lost, others — customers, spend, how many agreed to offers                       | Segments               |
| Members      | Who is in a segment today; CSV/Excel with contact details only for consenting guests; exports audited by count   | segment page           |
| Receipt link | QR and signed link on every paid receipt; 1–5 stars and a comment, once, within 14 days; nothing about the guest | receipt, `/feedback/…` |
| Follow-up    | Low ratings in Needs attention until reviewed or turned into a complaint at the branch                           | POS → Guest feedback   |
| Overview     | Count, average, share of 4–5 stars, low ratings, by branch                                                       | Guest feedback         |

Not yet: campaigns (C7d, needs a messaging provider), segments by item or channel, NPS, replying to guests, feedback on platform orders, per-aspect ratings.

Fixed on the way (found by running the suites between 22:00 and 24:00 UTC, when Cairo is already on the next day): a never-calibrated or never-maintained item with an interval was due on the UTC date it was created, so for two hours after local midnight it showed as overdue instead of due now — it is now due today in the branch's time zone; the kitchen-performance test could place its tickets before local midnight; four E2E specs (HR, VAT, delivery, customs) used the UTC date for "today" — they now use the organization's date (`orgDate` helper). Integration set-up hooks may now take 60 s (they build whole tenants; 10 s was no longer enough once the shared database is full).

Checks: `pnpm check` pass (unit 377; new: segment conditions, RFM groups, rating summary); `pnpm test:integration` 523/523 pass (new: a segment preview, save and live counts; names unique ignoring case; members by spend; export with contact details only for consenting guests, audited by count without personal data; archived segments gone; RFM counts; analysts and cashiers refused, managers allowed; a forged link refused; one rating per order, out-of-range refused; rating and comment never change; average 2.67 with 33 % at 4–5; low ratings in Needs attention until reviewed or turned into a complaint, which is linked); `pnpm test:e2e` 92/92 pass (new: receipt QR and link, a signed-out guest rates 2 stars with a comment, rating twice and a forged link refused, the manager sees and reviews it, RFM shown, a segment saved).

## C7b — Own riders for delivery orders (built)

Rules: DECISIONS.md ADR-117.

| Area           | What works                                                                                                      | Where                   |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Dispatch board | Delivery orders without an address; send for delivery with name, phone, address, directions; assign or reassign | POS → Delivery dispatch |
| Riders         | Driver role at the branch (or branch managers); what each carries; delivered, not delivered, median minutes     | Delivery dispatch       |
| Rider page     | My deliveries with call and map links; picked up, delivered (who took it), not delivered (reason)               | POS → My deliveries     |
| Exceptions     | Platform and takeaway orders refused; voided orders cannot be picked up and are cancelled with a reason         | —                       |
| Privacy        | Address, phone, name and directions erased 30 days after the delivery ends (daily job); never in the audit log  | —                       |

Not yet: cash on delivery per rider, delivery fees and zones, promised times and lateness alerts, customer tracking and notifications, address book, rider shifts and pay, live location.

Checks: `pnpm check` pass (unit 374; new: minutes and medians, per-rider figures, map search link); `pnpm test:integration` 517/517 pass (new: a delivery order on the board, a bad phone and a takeaway order refused, one delivery per order, only the branch's riders assignable, the rider sees it only once assigned with address, phone and map link, cannot deliver before picking up, reassigning and cancelling refused once on the way, delivered to Sara with figures on the board; no address in the audit log; a failed delivery needs a reason; a voided order cannot be picked up and its delivery is cancelled; contact details kept for 30 days, then erased while the outcome stays; another branch's cashier and other organizations refused; riders see only their own); `pnpm test:e2e` 91/91 pass (new: delivery price, sale on the Delivery tab, sent for delivery with an address, assigned, picked up and delivered on the rider page with call and map links, the rider's count on the board).

## C7a — Own fleet: trips, proof of delivery, cold chain (built)

Rules: DECISIONS.md ADR-116.

| Area              | What works                                                                                                         | Where                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Vehicles          | Code, plate, type, home warehouse, capacity; refrigerated with a temperature range                                 | Inventory → Vehicles |
| Drivers           | New Driver role; a trip's driver must be allowed to deliver from its warehouse                                     | Members              |
| Trips             | Vehicle, driver and day; ordered stops for posted B2B deliveries and transfers in transit; start, complete, cancel | Inventory → Trips    |
| Proof of delivery | Recipient, time, handover temperature (required when refrigerated), signature drawn on the phone, photos; final    | trip page            |
| Not delivered     | Reason kept; the consignment can go on another trip                                                                | trip page            |
| Cold chain        | Readings on the road; outside the vehicle's range flagged; trips with excursions in Needs attention                | trip page, dashboard |

New permissions `logistics.view`, `logistics.manage`, `logistics.deliver` (warehouse/branch-scopable) and the Driver system role. `pnpm typecheck` and `pnpm build` now run with a 4 GB Node heap: the type check had reached the 2 GB default.

Not yet: riders for POS delivery orders (C7b), route optimisation and maps, GPS, temperature loggers, cost per trip, returns from failed deliveries, customer notifications.

Checks: `pnpm check` pass (unit 371; new: excursions outside the range only, signatures limited to line drawings, distance, all stops resolved); `pnpm test:integration` 513/513 pass (new: a refrigerated truck at 0–5 °C needs its range and an ordered one; duplicate codes refused; drivers offered only where their role covers the warehouse; vehicle from another warehouse and a cashier as driver refused; two B2B deliveries and a transfer as stops, twice or as the wrong kind refused, the driver cannot plan; started with odometer 12 000, readings 3.5 and 7.2 °C — the second an excursion; handover temperature required, a script as signature refused, delivered to Omar with a drawn signature, recorded only once; completion refused while a stop is open and with the odometer going back; the hotel not delivered (receiving closed); completed at 86 km with 1 excursion and 4 readings; the database refuses a change to a proof of delivery; excursion in Needs attention; the driver's own trip list; the failed delivery goes on a new trip, the delivered one cannot; cancel needs a reason and frees its stops; another driver cannot start someone else's trip; other warehouses, cashiers and organizations refused); `pnpm test:e2e` 89/90 in the full run, then 90/90 — `pos.spec.ts` "sells offline … sends the queue" failed once (the "Send now" button re-rendered as the till synced by itself on reconnecting) and passed when run again; it does not touch C7a (new: refrigerated vehicle, trip with a B2B delivery, 8.5 °C flagged out of range, delivered with a drawn signature at 4 °C, completed with 1 excursion).

## C6c — Customs entries and shipment charges (built)

Rules: DECISIONS.md ADR-115.

| Area      | What works                                                                                                                       | Where         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Customs   | Declaration number, date, broker, customs value, duty assessed and import VAT (recorded, not a cost), in the company currency    | shipment page |
| Charges   | Freight, duty, insurance, handling, other — any currency — spread over all lines of the shipment's receipts by value or quantity | shipment page |
| Valuation | Posted per receipt as landed costs: added to stock still on hand, the rest recorded against stock already used                   | LCA documents |
| Costs     | Goods received, charges by type, landed total, charges as % of goods; duty assessed against duty posted                          | shipment page |
| Integrity | Declarations and charges never change (database trigger)                                                                         | —             |

Posting a charge needs `inventory.valuation.revalue` at the warehouse; recording a declaration needs `trade.manage`.

Not yet: allocation by weight or volume, duty per declaration line, linking charges to the forwarder's or broker's invoice, import VAT in the VAT return, demurrage and detention, estimated charges.

Checks: `pnpm check` pass (unit 368); `pnpm test:integration` 509/509 pass (new: a declaration with customs value 1 750, duty 87.50 and import VAT 275.63 in SAR; duplicate number and over-precise amounts refused; the database refuses a change; procurement refused posting a charge; 1 750 SAR freight over 1 000 SAR of flour and 750 SAR of sugar bought in USD at 3.75 — 1 000 / 750, half the flour already written off so 500 expensed, flour 50 kg at 20, sugar 50 kg at 30, valuations reconcile; duty 87.50 by quantity against its declaration, posted in full; goods 1 750, charges 1 837.50, landed 3 587.50, 105 % on top; two LCA documents per charge; charges refused before arrival; other organizations refused); `pnpm test:e2e` 89/89 pass (new: declaration with duty 50 flagged until posted, duty and 100 freight posted, landed 1 150 at 15.0 %).

## C6b — Trade documents and requirements (built)

Rules: DECISIONS.md ADR-114.

| Area      | What works                                                                                                                                  | Where                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Set-up    | Your own document types (per shipment or per product, with or without expiry); requirements by country, origin, HS prefix and authority     | Trade documents → Document types and requirements |
| Documents | Number, issuer, dates, note and scan; held for a shipment or a product; renewed or removed with a reason                                    | Trade documents, shipment page                    |
| Checklist | Per shipment: what applies, the best document held and whether it is held, expiring, expired or missing; unknown HS codes and origins named | shipment page                                     |
| Clearance | Marking a shipment cleared is refused while anything is missing or expired                                                                  | shipment page                                     |
| Expiry    | Expired and expiring (30 days) trade documents in Needs attention and filterable in the list                                                | Dashboard, Trade documents                        |

No document types or requirements are created for you; enter what your broker and authorities require.

Not yet: export-side documents, per-container documents, e-mail reminders, document generation, links to authorities' systems.

Checks: `pnpm check` pass (unit 368; new: 30-day expiry window, matching by destination, origin and HS prefix with unknowns never matching, best document per line, what blocks clearance); `pnpm test:integration` 505/505 pass (new: duplicate type codes and bad HS prefixes or countries refused; a shipment into SA of NZ milk (HS 0402) and beef with no origin needs a commercial invoice, a health certificate (HS 04, SFDA) and the milk's registration, not the Egypt-only requirement, and names the beef as without origin; clearance refused while missing; expiry required for the health certificate; a product type refused on the shipment; expiry before issue refused; an expired certificate still blocks and shows in Needs attention; renewed to 10 days it shows as expiring and clearance goes through; removal needs a reason and stops renewal; warehouse staff see but cannot add; cashiers and other organizations refused); `pnpm test:e2e` 88/88 pass (new: set up a commercial invoice requirement, clearance refused, invoice added, cleared, listed under trade documents).

## C6a — Import shipments (built)

Rules: DECISIONS.md ADR-113.

| Area       | What works                                                                                                              | Where                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Products   | HS code (6–12 digits, shown grouped) and country of origin (ISO list from the runtime's CLDR data)                      | Product page                  |
| Shipments  | Supplier, destination warehouse and company, mode, Incoterm, origin, ports, carrier, B/L or AWB, vessel, ETD/ETA, files | Purchasing → Import shipments |
| Orders     | Approved orders from the supplier to the warehouse, with how much has been received                                     | shipment page                 |
| Containers | ISO 6346 numbers with check digit verified; type, seal, reefer set point                                                | shipment page                 |
| Steps      | Departed → arrived → cleared → closed, dated in order; cancel before arrival with a reason                              | shipment page                 |
| Receipts   | Posted receipts of its orders linked after arrival (one shipment per receipt)                                           | shipment page                 |
| Late       | Past ETA and not arrived: on the list and in Needs attention                                                            | Import shipments, dashboard   |

New permissions `trade.view` and `trade.manage` (warehouse/branch-scopable): administrators and procurement both; operations managers, warehouse, finance and analysts view.

Not yet: trade documents and certificates (C6b), customs entries and landed cost from the shipment (C6c), carrier tracking, demurrage and detention, per-container packing lists.

Checks: `pnpm check` pass (unit 365; new: ISO 6346 check digits, HS code normalising and grouping, days late, ISO countries); `pnpm test:integration` 500/500 pass (new: HS code "0402.21 10" stored as 04022110 and origin NZ, short codes and unknown countries refused, left out keeps them; shipment with CIF from Auckland, departure refused without orders, duplicate and other-warehouse orders refused, reefer container at −18 °C, wrong check digit and a set point on a dry container refused, duplicate container refused; departed 28 days ago and 2 days late — on the list and in Needs attention; dates before the previous step or in the future refused; receipt link refused before arrival, then linked, order then stays; cleared shipments not editable or cancellable; closed with the order 100 % received; the database refuses dates out of order; cancel needs a reason; warehouse staff see but cannot change, other warehouses and organizations see nothing, cashiers refused); `pnpm test:e2e` 87/87 pass (new: approved PO, shipment with B/L, order linked, wrong container check digit refused then a reefer added, departed and arrived, receipt posted and linked, 100 % received).

## C5d — Consolidated group P&L (built)

Rules: DECISIONS.md ADR-112.

| Area          | What works                                                                                                               | Where                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Consolidation | Each company's P&L converted into the group currency at the period's average rate; eliminations; group total and margins | Purchasing → Consolidated P&L     |
| Missing rates | A company without a usable rate is left out of the total and named                                                       | Consolidated P&L                  |
| Intercompany  | Mark a customer as one of the group's companies; its invoices come off sales and cost of sales                           | B2B customer page → Group company |
| Local view    | Each company's sales, intercompany sales and operating result in its own currency                                        | Consolidated P&L                  |
| Export        | CSV and Excel                                                                                                            | Consolidated P&L                  |

New permission `pnl.consolidated.view` (organization-wide): administrators, finance, operations managers, analysts.

Not yet: unrealized profit in stock, matching intercompany purchases, minority interests, closing-rate translation, consolidated balance sheet (no general ledger), consolidation by brand.

Checks: `pnpm check` pass (unit 361; new: elimination against cost of sales leaves the result unchanged); `pnpm test:integration` 496/496 pass (new: SAR group — kitchen sells 10 kg at 50 to its sister company and 4 kg to a hotel, the sister sells the 10 kg for 800; Egypt rent 1 000 EGP at 0.075 = −75 SAR; a USD company without a rate left out and named; eliminations −500 sales and −500 cost; group sales 1 000, cost 420, gross profit 580 (58 %), operating result 505; CSV; unmarking the customer keeps 1 500 sales; analysts see it, branch-scoped managers refused; only managers of B2B can mark; other organizations' customers and companies refused); `pnpm test:e2e` 86/86 pass (new: an expense on the consolidated P&L; a customer marked as a group company).

## C5c — Branch profit and loss (built)

Rules: DECISIONS.md ADR-111.

| Area        | What works                                                                                                                                        | Where                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Statement   | Net sales by source (till, imports, B2B), cost of sales, gross profit, stock losses, expense groups, total expenses, operating result; % of sales | Purchasing → Branch P&L |
| Columns     | Each branch in its company currency plus company totals; one branch by month with the same period last year                                       | Branch P&L              |
| Shared data | Stock losses (waste, adjustments, count differences) added to branch actuals; imported sales and their cost counted on the day sold               | `finance/actuals.ts`    |
| Budget link | Budget against actual shows stock losses as actual only, and the operating result includes them                                                   | Budgets                 |
| Export      | CSV and Excel                                                                                                                                     | Branch P&L              |

New permission `pnl.view` (branch-scopable): administrators, finance, operations managers, analysts, branch managers at their branch.

Not yet: consolidation across companies and currencies (C5d), head-office cost allocation, depreciation, payroll staff costs, P&L by brand or cost centre, PDF.

Checks: `pnpm check` pass (unit 360; new: stock losses after gross profit, zero-filled columns, shares of sales, sums of columns); `pnpm test:integration` 493/493 pass (new: Cairo imported 500 over two days, cost 40, write-off 16, rent 150 → operating result 294 at 58.8 %; Giza rent 90 → −90 and no margins; company total 204; CSV; one day shows 200 sales with 40 % of the import's cost; month columns over two months with last year; branch manager sees only Giza, a hidden branch shows nothing; cashiers refused; other organizations see nothing); `pnpm test:e2e` 85/85 pass (new: a 1 200 utilities expense on the branch P&L, operating result −1 200 without percentages, CSV download).

## C5b — Branch budgets and budget against actual (built)

Rules: DECISIONS.md ADR-110.

| Area             | What works                                                                                                                                                | Where                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Budgets          | Monthly amounts per branch and line (cost of sales, each expense group) in the company currency; empty clears a month; the sales line is the sales target | Purchasing → Budgets |
| Actuals          | POS sales net of VAT and refunds, posted sales imports and B2B invoices, their stock cost, posted expenses by group — one shared definition               | `finance/actuals.ts` |
| Budget vs actual | Chosen month and year to date with difference, % of budget and favourable/unfavourable; gross profit, total expenses, operating result; year budget       | Budgets              |

New permissions `budgets.view` (branch-scopable) and `budgets.manage`: administrators and finance both; operations managers, branch managers (their branch) and analysts view.

Not yet: budget versions and approval, copying last year, spreading a yearly figure, prorating the open month, cost-centre budgets, foreign-currency budgets.

Checks: `pnpm check` pass (unit 357; new: derived rows only when a part exists, favourable direction for income and cost rows); `pnpm test:integration` 489/489 pass (new: empty budget has no variance; cost of sales and occupancy set by month, a month cleared, negative amounts and the sales line refused; sales 150 from the target, gross profit 110, operating result −790; actual POS sales 100 vs 150 unfavourable, stock cost from the order, occupancy 1 000 vs 900 unfavourable, unbudgeted utilities shows actual without variance; future year has nothing elapsed; branch managers see only their branch and cannot set budgets; finance can; cashiers and other organizations refused); `pnpm test:e2e` 84/84 pass (new: record a 1 200 utilities expense, budget 1 000 for the month, see both and "Unfavourable").

## C5a — Cost centres, expense categories and operating expenses (built)

Rules: DECISIONS.md ADR-109.

| Area        | What works                                                                                                               | Where                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Set-up      | Your own expense categories, each in a P&L group; cost centres for one branch or shared; archive and restore             | Operating expenses → Categories and cost centres |
| Expenses    | Per branch in its company currency: date, category, cost centre, supplier, reference, net, VAT, gross; receipts attached | Purchasing → Operating expenses                  |
| Corrections | Never edited (database trigger); reversed with a reason, kept on record and out of the totals                            | expense page                                     |
| Lists       | Filter by period, branch and category; totals per currency and P&L group; CSV and Excel                                  | Operating expenses                               |

New permissions `expenses.view` and `expenses.manage` (branch-scopable): administrators and finance both, branch managers both at their branch, operations managers and analysts view.

Not yet: expense VAT in the VAT summary and accounting export, foreign-currency expenses, approval of large expenses, recurring expenses, spreading one bill over months, expenses from supplier invoice charge lines.

Checks: `pnpm check` pass (unit 355; new: gross = net + VAT, totals per P&L group without reversals); `pnpm test:integration` 485/485 pass (new: electricity 1 200 + 168 VAT and rent 15 000 at Cairo in EGP — totals 16 200 split occupancy 15 000 / utilities 1 200; duplicate category code refused; a Cairo cost centre refused for Giza; future dates and zero amounts refused; the database refuses an edit; reversal needs a reason, happens once and leaves the totals; archived categories refused; a Giza branch manager records only at Giza and sees only Giza; analysts view but cannot record; cashiers refused; other organizations refused); `pnpm test:e2e` 83/83 pass (new: add a utilities category, record electricity with VAT, see 1 368.00 gross and the utilities total, reverse it).

## C4d — Kitchen display performance (built)

Rules: DECISIONS.md ADR-108.

| Area      | What works                                                                                                  | Where                         |
| --------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Times     | Sent to bumped per station: median, 90th percentile, average, share within target (same rule as the screen) | Reports → Kitchen performance |
| Now       | Tickets on screens and those past their target                                                              | same                          |
| Breakdown | By hour sent and day in the branch's time zone; items and voided items; branch filter; CSV and Excel        | same                          |

Not yet: per-item preparation times, staff on shift against tickets, history of station targets (current targets judge past tickets).

Also: the restaurant set-up used by the table-service tests moved to `tests/e2e/restaurant-setup.ts` so the kitchen report test can share it.

Checks: `pnpm check` pass (unit 353; new: interpolated percentiles, within target strictly under the target, no figures without tickets); `pnpm test:integration` 481/481 pass (new: three till orders on a 10-minute grill — bumped after 5 and 15 minutes, one open for 20: median 10.0, 90th percentile 14.0, 50 % within target, one late now; hour and day totals; CSV line; cashiers refused; other organizations see nothing); `pnpm test:e2e` 82/82 pass (new: send soup to the grill, bump it, the report shows one ticket at 100 % within the 12-minute target).

## C4c — Menu engineering (built)

Rules: DECISIONS.md ADR-107.

| Area    | What works                                                                                                                                       | Where                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Sales   | Items sold and revenue per menu item from paid POS lines, net of VAT, discounts and refunds                                                      | Reports → Menu engineering |
| Cost    | Standard cost today: active recipe per portion or product average × quantity, at the selling warehouse; price and cost converted together        | same                       |
| Classes | Stars, plowhorses, puzzles, dogs (popular from 70 % of an equal share, profitable from the weighted average margin); per category; CSV and Excel | same                       |
| Gaps    | Combos, items without an active recipe or product cost listed but not classified; uncosted ingredients marked                                    | same                       |

Not yet: cost at the time of sale, combos split into components, option ingredients, branch menus side by side.

Checks: `pnpm check` pass (unit 351; new: 70 % of an equal share, weighted average margin, the four classes, items without cost left out); `pnpm test:integration` 479/479 pass (new: till sales of 2 burgers and 10 colas with 1 refunded — burger 100.00 at cost 20 margin 30, cola 9 for 90.00 at cost 3; threshold 35 % and average margin 11.18 → burger a puzzle, cola a plowhorse; a soda sold without a recorded cost listed but not classified; the drinks category alone makes cola a star; CSV line; cashiers refused; other organizations see nothing); `pnpm test:e2e` 81/81 pass (new: empty report says nothing can be classified yet, shows the four classes and the category filter, CSV header).

## C4b — Stock ageing, turnover and days on hand (built)

Rules: DECISIONS.md ADR-106.

| Area        | What works                                                                                                                                                    | Where                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Ageing      | Stock on hand now in 0–30 / 31–60 / 61–90 / 91–180 / over 180 days, at average cost; lots by first receipt, other stock first in first out; age unknown shown | Reports → Stock ageing and turnover |
| Expired     | Value of expired lots still on hand                                                                                                                           | same                                |
| Turnover    | Used (consumed or delivered) ÷ average of opening and closing value; days on hand at the period's usage; write-offs apart                                     | same                                |
| Slow movers | Stock on hand with no use in the period; incomplete cost marked; CSV and Excel                                                                                | same                                |

Not yet: ageing at a past date, quantity-based turnover, stock-out days, ABC classification.

Also fixed: the REST API key test read the key's secret with `split("_")`, which breaks when the random secret contains "_" (it failed once in this run); it now takes the whole secret after the prefix.

Checks: `pnpm check` pass (unit 348; new: age buckets, first-in-first-out ages with uncovered stock as unknown, turnover and days on hand only with stock and usage); `pnpm test:integration` 477/477 pass (new: a saffron lot received 100 days ago, expired, 2 kg written off — 40.00 in 91–180 days, expired, slow mover; rice without lots aged today; 10.00 used by a customer delivery and 10.00 written off kept apart; turnover 0.2857 and 7.0 days on hand for the warehouse, 3.0 for rice; the next day opens at 70.00 with no ratio; CSV; cashiers refused; other organizations see nothing); `pnpm test:e2e` 80/80 pass (new: opening balance of 12 kg at 25, the report shows 300.00 now and at period end, no use in the period, and the CSV line).

## C4a — Sales analytics and targets (built)

Rules: DECISIONS.md ADR-105.

| Area       | What works                                                                                                                                    | Where                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Totals     | Net sales (after VAT and refunds), orders, average ticket; against the previous period and the same dates last year; no growth without a base | Reports → Sales analytics |
| Breakdowns | By branch (share, target, achievement), channel, day of the week, hour (branch time), day; CSV and Excel                                      | Sales analytics           |
| Targets    | Monthly net target per branch in its company currency, set by you; shared out by day for any period                                           | Sales analytics → Targets |
| Currency   | Branch figures converted at the period's average rate; currencies without a rate left out and named                                           | Sales analytics           |

New permission `sales.targets.manage` (administrators, operations managers, finance).

Not yet: targets by channel or weekday, forecasts (I1), imported sales files and B2B invoices in the same view.

Checks: `pnpm check` pass (unit 345; new: growth only with a base, average ticket, same dates last year with 29 February, monthly targets shared out by day across months, weekdays, month list); `pnpm test:integration` 474/474 pass (new: zeros and no ratios before any sale; three orders less a refund give 175.00 over 3 with a 58.33 average; no growth without a previous figure; target 3 100 a month shared out to the day and achievement against it; channel shares 57.14 % / 42.86 %; weekday and hour totals; CSV in EGP; targets grid, clearing a month, negative refused, analysts may view but not set, cashiers refused, an invalid period refused; other organizations see nothing and cannot set targets); `pnpm test:e2e` 79/79 pass (new: empty report, set this month's target, the report shows the target and 0.0 % achieved).

## C3d — Handheld scanning and labels (built; D5: both scanners and phones)

Rules: DECISIONS.md ADR-104.

| Area     | What works                                                                                                                      | Where                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Scanners | Keyboard-style scanners (Zebra, Honeywell…) type and press Enter; phone camera via the browser's barcode reader where available | every scan field                   |
| Labels   | Code 128 labels for pack units and storage locations, printed from the browser                                                  | pick list → Unit labels; warehouse |
| Lookup   | One field finds a unit, pick list, load, location, product (barcode or SKU) or lot                                              | Inventory → Scanner                |
| Picking  | Guided: scan location, then product, then quantity, line by line in walk order; wrong scans refused                             | Scanner → Pick                     |
| Loading  | Scan each unit onto the vehicle; progress shown                                                                                 | Scanner → Load a vehicle           |
| Counting | Scan a product or lot, enter what is counted                                                                                    | Scanner → Count                    |

**Unvalidated on hardware:** tested in the browser with simulated keyboard input only; to be checked on a physical Zebra/Honeywell scanner and a phone camera at the pilot. Camera scanning appears only where the browser has a barcode reader (Chrome/Edge on Android, among others). The site now allows the camera for itself (`camera=(self)`).

Not yet: QR and GS1-128 content on labels, label printers (ZPL), scanning at receiving and put-away, offline scanning.

Checks: `pnpm check` pass (unit 341; new: Code 128 pattern table well-formed, modulo-103 checksum, bar layout with quiet zones, printable ASCII only, scanner input cleaned of Enter/Tab/group separators, scan matching by barcode, SKU and lot); `pnpm test:integration` 470/470 pass (new: the guided pick expects shelf A-01, MILK, its EAN-13 and lot; a unit number in lower case with CR/LF, a location, a barcode, a SKU and a lot each resolve; unknown and blank codes find nothing; count lines found by barcode and lot on the shelf and in dispatch; nothing across organizations; cashiers refused); `pnpm test:e2e` 78/78 pass (new: look up a location by scanning, guided pick refusing a wrong location and product, pack, unit label with its barcode, scan the unit onto a van).

## C3c — Packing, loads and dispatch (built)

Rules: DECISIONS.md ADR-103.

| Area     | What works                                                                                                                                                       | Where             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Packing  | Picked stock packed into numbered cartons, crates, pallets or bags with exact contents and weight; never more than picked; unpack until loaded; packing list PDF | pick list page    |
| Loads    | Vehicle trip per warehouse; only fully packed lists go on; lists on a load ship or come off only with it                                                         | Inventory → Loads |
| Loading  | Each unit confirmed on the vehicle by click or by its number (typed or scanned)                                                                                  | load page         |
| Dispatch | Only when every unit is loaded; vehicle temperature required for chilled or frozen goods; seal; delivers every order at once; manifest PDF                       | load page         |

Not yet: unit labels with barcodes (C3d), vehicle temperature limits and in-transit logging, routes and proof of delivery (C7), loads for branch shipments.

Checks: `pnpm check` pass (unit 335); `pnpm test:integration` 466/466 pass (new: packing refuses more than picked, packs the rest with empty quantities, unpacks; an unpacked list cannot go on a load; a list on a load cannot be delivered, cancelled, repacked or unpacked on its own; loading by number in lower case, twice or from another load refused; dispatch refused until all units are loaded, for cashiers, and without the vehicle temperature for chilled yogurt; dispatch delivers both orders from the dispatch bay with seal and temperature recorded; load and units frozen in the database; taking a list off clears its loading, cancelling the load leaves it picked and packed, cancelling the list unpacks it and moves the stock back; other organizations refused); `pnpm test:e2e` 77/77 pass (new: pick, pack into a carton, packing list PDF, load for a van, add the order, scan the carton number, dispatch with a seal, manifest PDF).

## C3b — Pick lists, waves and delivery from picked stock (built)

Rules: DECISIONS.md ADR-102.

| Area    | What works                                                                                                                                                   | Where               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Plan    | Pick list per confirmed sales order: first-expiring first, picking before storage, never quarantine or dispatch, net of other open lists; shortages reported | sales order → Plan  |
| Pick    | Picked quantity per line (short needs a reason); confirming moves the stock to the dispatch location at the product's temperature through the ledger         | Inventory → Picking |
| Deliver | Delivers exactly the staged lots; plain delivery and order cancel refused while a list is open; dispatch stock no longer used by automatic consumption       | pick list page      |
| Cancel  | Planned list releases its hold; picked list moves the stock back                                                                                             | pick list page      |
| Waves   | Several orders of a warehouse planned together; consolidated sheet by place in walk order; pick sheets as PDF                                                | Inventory → Picking |

Not yet: pick lists for branch shipments, packing and loading (C3c), scanning (C3d), reservations honoured by POS and production before picking, splitting a wave between pickers.

Checks: `pnpm check` pass (unit 335; new: FEFO then picking-area order, quarantine/dispatch/expired/recalled/held stock skipped, walk order); `pnpm test:integration` 463/463 pass (new: an order for 15 kg plans 10 kg of the older lot from storage and 5 kg of the newer from the pick face, staged in the chilled dispatch bay; a second list, a plain delivery and cancelling the order are refused; an ambient product without an ambient dispatch area is refused; a wave for 20 kg plans the 15 kg left and reports 5 short; cancelling the planned list; picking needs a reason when short and every line; picked stock moves to dispatch and the plan is fixed in the database; a plain delivery of another order cannot use the staged stock; cashiers cannot deliver; delivery takes exactly the staged lots; cancelling a picked list moves the stock back; other organizations refused; existing B2B tests unchanged); `pnpm test:e2e` 76/76 pass (new: pick face and dispatch bay, sales order, plan pick list, pick sheet PDF, confirm pick, deliver, order delivered).

## C3a — Location zones, receiving inspection and directed put-away (built)

Rules: DECISIONS.md ADR-101.

| Area       | What works                                                                                                                                                                             | Where                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Zones      | Each location has a use (receiving, quarantine, storage, picking, dispatch) beside its temperature; receipts without a location land on the only receiving location                    | warehouse page                   |
| Inspection | Products marked "inspect on receipt" go to quarantine; one inspection per line with packaging, labelling, condition, temperature; accepted part released, rest rejected, in the ledger | Inventory → Receiving inspection |
| Rules      | Put-away rules by product, category or storage temperature with priorities; only storage/picking locations at the right temperature                                                    | warehouse → Put-away             |
| Put-away   | Worklist of received stock with a suggested place (rule, else where the product already is); put-away is a ledger transfer and refused at the wrong temperature                        | warehouse → Put-away             |
| Attention  | Receipt lines waiting for inspection                                                                                                                                                   | Needs attention                  |

Not yet: automatic move of quarantined stock to a quarantine location, location capacity, organization-defined inspection checklists, a non-conformance on rejection, scanning (C3d).

Checks: `pnpm check` pass (unit 332; new: rule matching by priority, unfit rules skipped, same-product fallback, storage/picking at the right temperature only; inspection split, quantity range, reason for rejection, note when a failed check is accepted); `pnpm test:integration` 457/457 pass (new: a receipt without location lands on the dock; milk marked for inspection goes to quarantine, rice does not; inspection refuses a missing reason, more than received and a silent accept after a failed check; 9 of 10 accepted → 9 available, 1 rejected at the dock; one inspection per line, never changed, receipt no longer reversible; cashiers refused; rules refuse the dock and a chiller rule into the dry store; worklist suggests the chiller by rule and nothing for rice; rice refused into the chiller, milk refused beyond stock, put away through transfers; leftover rice suggested where it already is; other organizations refused); `pnpm test:e2e` 75/75 pass (new: dock and chiller locations, a product inspected on receipt, receipt, inspection accepting 45 of 50 kg with crushed cartons rejected, a put-away rule, put away into the chiller).

## C2e — Compliance score, mock recalls and the batch report (built)

Rules: DECISIONS.md ADR-100.

| Area             | What works                                                                                                                                                                                                           | Where                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Compliance score | Per branch over 7, 30 or 90 days: records in spec, checklist items OK, corrective actions on time, equipment calibrated now — each with its counts; equal-weight mean of the parts with data; no data shows no score | Food safety → Compliance score |
| Mock recall      | Timed drill on one lot from its trace page: book position copied, clock running, found quantity per place, optional target set by you; stock never touched                                                           | Traceability → Mock recalls    |
| Result           | Target missed, stock difference, not fully accounted for, trace gaps or unknown origin → MEDIUM non-conformance at the branch; finished drills frozen in the database                                                | mock recall page               |
| Batch report     | One-click PDF per lot: movements, suppliers and receipts, made from / used in, shipments, recalls, gaps                                                                                                              | lot trace page                 |

Not yet: drills across several lots or a whole supplier, customer notification in drills, score trend over time, organization-chosen weights, POS sales linked to lots in the report.

Checks: `pnpm check` pass (unit 327; new: drill outcome — accounted share, difference, inclusive target, gaps and unknown origin; score — parts without data skipped, equal-weight mean, bands); `pnpm test:integration` 451/451 pass (new: a drill copies the book position, refuses completion without every count, passes at 95 of 95 kg within target without changing stock, is frozen after completion in the service and the database; 90 of 95 kg after 61 minutes against 60 opens a MEDIUM MOCK_RECALL NC at the branch; an opening-balance lot is flagged for gaps and unknown origin; cancel needs a reason; cashiers and other organizations are refused; compliance 3/4 records, 1/2 checklist items, 1/2 actions on time, 1/2 equipment calibrated → 56, a branch without records has no score, branch-scoped users see only their branch); `pnpm test:e2e` 74/74 pass (73 in the full run; the new spec failed there on an ambiguous test locator and a message assertion, was fixed and passes on its own: batch report PDF downloads, a drill finding 48 of 50 kg is not passed with an NC and 96 % accounted, stock unchanged, compliance page shows no data).

## C2d — Equipment, calibration and maintenance (built)

Rules: DECISIONS.md ADR-099.

| Area        | What works                                                                                                                                                                    | Where                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Register    | Equipment per branch: type, serial, location, the checkpoint it serves, calibration and maintenance intervals set by you; in service, out of service, retired (with reasons)  | Food safety → Equipment |
| Calibration | Reference, reading and allowed deviation → pass/fail on the numbers; next date from the interval; certificate files; never changed                                            | equipment page          |
| Failure     | Out of service at once and a non-conformance (HIGH when it serves a checkpoint) naming the readings in doubt since the last pass; a passing calibration returns it to service | equipment page          |
| Maintenance | Preventive, repair, deep cleaning, inspection with its own next date; never changed                                                                                           | equipment page          |
| Due         | Flagged 30 days ahead and when passed; overdue, due soon and out-of-service under Needs attention                                                                             | list, Needs attention   |

Not yet: blocking readings from out-of-service thermometers, spare parts and costs, maintenance contracts.

Checks: `pnpm check` pass (unit 319; new: pass/fail on the tolerance inclusive, next due from the interval, due states); `pnpm test:integration` 445/445 pass (new: code unique per branch, only managers register; never-calibrated equipment due at once; incomplete numbers and future dates refused; ice-point 0.4 within ±1 passes and sets 30 days; 1.6 fails, takes it out of service with a HIGH EQUIPMENT NC naming the doubtful period, cannot be returned by hand; repair then a pass returns it; records fixed and the database refuses a pass that the numbers contradict; preventive maintenance sets 90 days; out of service needs a reason, return by managers only; retired equipment takes no records and leaves the list; other organizations and cashiers see nothing); `pnpm test:e2e` 73/73 pass (new: register a probe, record a passing and a failing calibration, the probe is out of service with an NC link).

## C2c — Audits and customer complaints (built)

Rules: DECISIONS.md ADR-098.

| Area       | What works                                                                                                                                                                              | Where                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Audits     | Internal, certification, authority inspection, customer; branch, auditor, scope, planned date; late ones under Needs attention                                                          | Food safety → Audits     |
| Findings   | Observation / minor / major / critical with the requirement; minor → MEDIUM, major → HIGH, critical → CRITICAL non-conformance at once; completed with the auditor's result, then fixed | audit page               |
| Complaints | Channel, category, what happened, order reference, product and lot (linked to traceability), optional customer contact (kept out of the audit log)                                      | Food safety → Complaints |
| Follow-up  | Foreign object, illness, allergen → HIGH non-conformance at once; others on request (MEDIUM); investigation, resolution, what the customer was told; open ones under Needs attention    | complaint page           |

Not yet: audit checklists and scoring templates, recurring audit schedules, complaint trends (C4), notifying customers (needs D2).

Checks: `pnpm check` pass (unit 316; new: finding → non-conformance severity, finding counts, food safety complaint categories); `pnpm test:integration` 443/443 pass (new: an inspection with an observation (no NC), a major finding (HIGH, source audit) and a minor one; completing in the future and cancelling with findings refused; completed with grade B, closed to more findings and fixed in the database; a late audit flagged then cancelled with a reason; branch staff cannot plan audits; a foreign object complaint on a real lot opens a HIGH NC naming the product and lot, unknown lots refused, contact details absent from the audit log; staff log but cannot resolve; investigation and resolution; a hygiene complaint opens a MEDIUM NC on request, only once; a future date refused; the database refuses a food safety complaint without its NC; branches and organizations kept apart); `pnpm test:e2e` 72/72 pass (new: plan an authority inspection, add a major finding → NC link, complete it; log a foreign-object complaint → NC link, resolve it).

## C2b — Document control (built)

Rules: DECISIONS.md ADR-097.

| Area      | What works                                                                                                                                         | Where                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Documents | Policies, SOPs, work instructions, forms, manuals; code, title, one branch or all; text plus attached files                                        | Food safety → Documents |
| Versions  | Draft → approved by someone other than the author, with effective and review dates → fixed; new versions copied and superseding; full history kept | document page           |
| Reading   | "I have read this version" per version; who and when listed; "to read" list and Needs attention per person; new versions need reading again        | document page, list     |
| Control   | Withdraw with a reason (kept); reviews due under Needs attention; branch documents only seen at that branch                                        | document page           |

Not yet: required readers by role, links from HACCP control points and checklists to their SOPs, rich text.

Checks: `pnpm check` pass (unit 313); `pnpm test:integration` 439/439 pass (new: code unique; self-approval, a past effective date and a review date not after it refused; nothing to read before approval; draft edited then approved; read confirmed once and shown; approved version fixed in the database; new version copied, the old one stays in force until approval, then superseded and the new one needs reading again; withdrawal needs a reason, blocks reading and new versions, moves it to the withdrawn list; a branch document hidden from another branch; branch managers cannot write; cashier refused; other organizations see nothing); `pnpm test:e2e` 71/71 pass (new: the owner writes an SOP, a food safety lead approves it, the owner finds it under "to read", confirms reading it, and the page shows one reader).

## C2a — HACCP plans (built)

Rules: DECISIONS.md ADR-096. First part of C2 (food safety system).

| Area           | What works                                                                                                                                                                                               | Where                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Plan           | Code, product or process, scope, intended use, team; one branch or all; process steps in order                                                                                                           | Food safety → HACCP plans |
| Hazards        | Biological, chemical, physical, allergen; likelihood × severity (1–5) as the team scores them; significant or not; Codex decision tree Q1–Q4 → CCP / OPRP / PRP; a reason to classify otherwise          | plan page                 |
| Control points | Critical limit (text, optional min/max and unit), monitoring, frequency, who, corrective action, verification, records; monitored by temperature checkpoints whose limits sit inside the critical limits | plan page                 |
| Deviations     | A reading out of spec at a linked checkpoint opens a HIGH non-conformance tied to the control point, with the critical limit and planned correction; open deviations and 30-day evidence on the plan     | records, plan page        |
| Approval       | Refused while anything is missing; by someone other than the author; review date; fixed once approved; new versions copied and approved to supersede; reviews due under Needs attention; PDF             | plan page                 |

Not yet (rest of C2): document control, audits and complaints, calibration and maintenance, compliance score, mock recall, batch report.

Checks: `pnpm check` pass (unit 313; new: decision tree paths and stopping, risk score, readiness problems, checkpoint limits inside critical limits); `pnpm test:integration` 437/437 pass (new: plan code unique; incomplete plan refused; PRP called CCP needs a reason; tree gives CCP for cooking and OPRP for cold storage; a fridge alarmed at 8 °C refused for a 5 °C limit, one at 4 °C accepted; self-approval and a past review date refused; approved plan fixed in the service and the database; an under-cooked reading opens a HIGH "CCP deviation (CHK v1)" with the planned correction, a reading elsewhere stays MEDIUM; evidence and deviations on the plan; a new version copies steps, hazards, control points and checkpoints, its approval supersedes v1 and new deviations name v2; cashier refused; other organizations see nothing); `pnpm test:e2e` 70/70 pass (new: create a plan, add a step and a significant hazard answered yes / yes → CCP with risk 20, set the critical limit and monitoring, the plan shows as complete, PDF served).

## C1e — Spend and purchase price variance (built)

Rules: DECISIONS.md ADR-095. With this, C1 (procurement compliance) is complete: supplier approval and documents (C1a), requests for quotation (C1b), order revisions (C1c), supplier returns (C1d), spend and price variance (C1e).

| Area           | What works                                                                                                                                                                                             | Where                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Basis          | Posted receipts' accepted lines at the charged price and each receipt's rate, less returns posted in the period; excl. VAT; company currency, or group converted at average rates; missing rates named | both reports             |
| Spend          | Received, returned, net by supplier (share, paid over order price), category (supplier count, single source flagged), branch, month; top-5 supplier share                                              | Reports → Spend          |
| Price variance | Over / under / net against order prices; by supplier with rate of spend; lines off the order price linked to receipts; average price per product against the previous period with impact               | Reports → Price variance |
| Access, export | `purchasing.view` at the warehouses held; CSV and Excel                                                                                                                                                | both reports             |

Not yet: spend from invoices or payments, budgets per category, contract price compliance.

Checks: `pnpm check` pass (unit 306; new: grouping with returns netted, shares and supplier counts, concentration, average price change and impact, previous period); `pnpm test:integration` 435/435 pass (new: EGP and USD receipts valued at their rates, a return netted: received 1680, returned 220, net 1460; suppliers 980 / 480 with shares; categories with a single-source flag; variance 100 over the order price; company currency; cashier refused, branch-scoped user outside sees nothing; invalid period refused; the line off the order price and its supplier rate; a delivery the day before gives the flour price change 90 → 105.33 with impact 230; CSV rows); `pnpm test:e2e` 69/69 pass (new: receive at 22 against 20 ordered; spend shows 220 for the supplier and its CSV row; price variance shows 20 over).

## C1d — Supplier returns (built)

Rules: DECISIONS.md ADR-094.

| Area     | What works                                                                                                                                                                           | Where                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Start    | "Return goods" on a posted receipt, with a reason (quality, damaged, expired, wrong item, recall, too much delivered, other)                                                         | receipt page, Purchasing → Returns |
| Lines    | From any posted receipt of the same supplier, warehouse and currency; lot, unit and charged price kept; at most what was accepted less earlier returns; from available or quarantine | return page                        |
| Post     | Goods leave stock through the ledger (`SUPPLIER_RETURN`, `RETURN_TO_SUPPLIER` at average cost); expected credit = quantity × charged price                                           | return page                        |
| Credit   | Link the supplier's credit note (same supplier and currency); returns waiting for one are under Needs attention                                                                      | return page, Needs attention       |
| Reverse  | Supplier refused the goods: stock put back as it left, quantity returnable again; the receipt cannot be reversed while returns stand                                                 | return page                        |
| Document | Goods return note PDF on the company letterhead                                                                                                                                      | return page                        |

Not yet: returns do not change the quantity that can be invoiced (the credit note settles the money); returning from a location other than the receipt's; collection and transport documents.

Checks: `pnpm check` pass (unit 301); `pnpm test:integration` 432/432 pass (new: return from a receipt, one line per receipt line, no more than accepted, wrong stock status refused by the ledger, posting takes flour and a lot of beans out with `RETURN_TO_SUPPLIER` entries and balances reconcile, expected credit 650; lines fixed after posting (service and database); only the rest is returnable; receipt reversal and generic ledger reversal refused; cancel needs a reason; awaiting-credit item shown; credit note of another supplier refused, only invoice managers link it, then credited and no longer reversible; a refused return is reversed, stock restored and returnable again; other organizations see nothing); `pnpm test:e2e` 68/68 pass (new: receive 10 kg, return 4 kg from the receipt, post, awaiting credit, stock 6 kg, return note PDF served).

## C1c — Purchase order revisions (built)

Rules: DECISIONS.md ADR-093.

| Area       | What works                                                                                                                                                                          | Where                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Revise     | "Start revision" with a reason on an approved or part-received order; the version is kept; the order returns to draft as revision n + 1; receiving waits                            | purchase order page      |
| Edit       | Change quantity and price of lines, add lines, remove unreceived lines, change the expected date and note; supplier, warehouse and currency stay                                    | purchase order page      |
| Protection | Received lines keep product, unit and price and cannot go below what arrived — in the service and by database triggers                                                              | service, database        |
| Re-approve | Resubmission runs the approval matrix and supplier checks again; then the status follows receipts (approved, part-received, received); a stuck part-received revision can be closed | purchase order page      |
| History    | Every revision with reason, who, when and what changed (added, removed, quantity, price, date, total); "Revision n" on the page, PDF and approval webhook                           | purchase order page, PDF |

Not yet: e-mailing the revised PDF to the supplier (D2); changing the price of goods still to come on a line already part-received (close the line short and add the rest as a new order).

Checks: `pnpm check` pass (unit 301; new: which changes a received line refuses, the list of changes between versions); `pnpm test:integration` 429/429 pass (new: revise needs a reason and `purchasing.manage`; receiving stops; removing, re-pricing, changing the unit or cutting below received refused, supplier change refused; allowed changes resubmit to part-received with the right total and history; the database refuses the same changes, revision jumps and versions out of turn; a revision goes through the approval matrix again and can be revised once more; cutting to what was received completes the order; a part-received revision can be closed; drafts cannot be revised; other organizations see nothing); `pnpm test:e2e` 67/67 pass (new: approve an order, revise it to 8 kg, resubmit, see "Revision 1", the reason and "quantity 10 → 8", PDF served).

## C1b — Requests for quotation (built)

Rules: DECISIONS.md ADR-092.

| Area       | What works                                                                                                                                                                   | Where                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Request    | Title, warehouse, quotes wanted by, needed by; lines (product, quantity, unit); suppliers asked (never blocked); "mark as sent" fixes them; cancel with a reason             | Purchasing → Requests for quotation |
| Send       | PDF per supplier on the company letterhead, without prices (no e-mail: provider not chosen, D2)                                                                              | "PDF" beside each supplier          |
| Quotations | Entered as received: currency, reference, date, validity, lead time, price per line and optional smaller quantity; corrections replace; supplier's file attached             | RFQ page                            |
| Comparison | Each offer's cost for the requested quantity in the company currency at today's rate; lowest valid offer marked; totals and full-coverage per quotation; missing rates named | RFQ page                            |
| Award      | One offer (or none) per line; a reason when not the lowest or another offer could not be compared; one draft PO per supplier at the quoted prices, linked back to the RFQ    | RFQ page → purchase order           |

Not yet: supplier portal or e-mailing RFQs (D2), sealed bids, a minimum number of quotes, splitting a line between suppliers.

Checks: `pnpm check` pass (unit 298; new: actions per status, lowest valid comparable offer, when a reason is needed, awarded quantity); `pnpm test:integration` 425/425 pass (new: send needs lines and suppliers, blocked supplier refused, lines frozen after sending, PDF only for suppliers asked, cancel needs a reason; quotes only from suppliers asked (service and database), corrections replace lines; USD offer converted at the day's rate and marked lowest, expired offer neither lowest nor awardable, totals and coverage; a dearer offer and an uncompared EUR offer need a reason; award creates a USD and an EGP draft order at the quoted prices and offered quantity, the order then submits normally, the RFQ cannot be awarded twice; a supplier blocked after quoting is refused; another organization sees nothing); `pnpm test:e2e` 66/66 pass (new: create an RFQ, add a line, ask two suppliers, send, download a PDF, record two quotes, award the dearer one — a reason is asked for — and land on the draft order linked to the RFQ).

## C1a — Supplier compliance (built)

Rules: DECISIONS.md ADR-091. First part of C1 procurement compliance.

| Area             | What works                                                                                                                                                                                                                  | Where                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Approval         | Optional "New suppliers need approval"; a new supplier waits until someone other than the person who added it approves it (`suppliers.approve`: Administrator, Finance); approvers notified and shown under Needs attention | Settings → Purchasing, supplier page |
| Blocking         | Block with a reason, lift the block; who, when and why kept                                                                                                                                                                 | supplier page                        |
| Effect on orders | Blocked: no new order or switch to the supplier, no submit or approval. Waiting: orders can be prepared, not submitted. Receiving, invoices and payments are not stopped                                                    | purchase orders                      |
| Documents        | Commercial registration, VAT, municipality, food safety, halal, ISO, insurance, contract, other; number and dates; files attached; "required to buy" stops orders once expired; flagged 30 days ahead and in the digest     | supplier page, Needs attention       |
| Bank accounts    | IBAN (mod-97) or account number + SWIFT; encrypted, shown masked; full number on request (audited) for bank managers and payers; details never change; verified by a second person; approvers notified                      | supplier page                        |
| List and API     | Status column; filters for waiting, approved, blocked, document expired, expiring; `status` in `/api/v1/suppliers`                                                                                                          | `/suppliers`, API                    |

Not yet (rest of C1): RFQs and quotation comparison, PO revisions, supplier returns as a document, purchase price variance and spend reports. Payments do not yet record which bank account was paid.

Checks: `pnpm check` pass (unit 293; new: order block per status and step, IBAN shape, length and checksum, SWIFT, masking); `pnpm test:integration` 420/420 pass (new: approval off keeps old behaviour; a new supplier waits, approvers notified, the adder cannot approve (service and database); orders prepared but not submitted until approval; blocking stops new orders and approval of a waiting order, lifting restores it; a never-approved supplier returns to waiting; an expired required document stops submission until renewed, flagged under Needs attention; bad IBAN and missing SWIFT refused; the number stored encrypted, never in the audit log or page data, hidden from read-only users, revealed with an audit entry; verification only by someone else; details cannot be changed in the database; another organization sees nothing); `pnpm test:e2e` 65/65 pass (new: turn approval on, add a supplier, an expired required certificate and a bank account; wrong IBAN refused; masked number and reveal; finance sees it under Needs attention, approves the supplier and verifies the account).

## F2d — REST API v1 (built)

Rules: DECISIONS.md ADR-090. With this, F2 (platform services) is complete.

| Area      | What works                                                                                                                                                           | Where                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| API keys  | Created with a name, read scopes and an optional company; shown once (only a hash kept); revocable; last use shown; audited                                          | `/settings/api`        |
| Resources | Companies, branches, warehouses, products, suppliers, stock on hand, purchase orders (list and one), supplier invoices, B2B sales invoices, POS orders; cursor pages | `/api/v1/…`            |
| Rules     | Scopes become read permissions; row-level security; company-limited keys see only that company; 600 requests per minute per key                                      | every request          |
| Contract  | OpenAPI 3.1, checked against the served paths                                                                                                                        | `/api/v1/openapi.json` |

Not yet: writing through the API (needs a decision on who acts and how writes are approved and audited); webhooks already cover outbound events (ADR-048).

Checks: `pnpm check` pass (unit 286); `pnpm test:integration` 410/410 pass (new: key shown once and only hashed; only integration managers create keys; scopes enforced (403); pages continue with the cursor; missing, wrong and revoked keys refused (401); a company-limited key sees only that company's orders; another organization's key sees nothing; every documented path is served); `pnpm test:e2e` 64/64 pass (new: create a key, read products with it, a missing scope refused, revoke it).

## F2c — Excel and PDF exports (built)

Rules: DECISIONS.md ADR-089.

| Area   | What works                                                                                                                                                            | Where                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Excel  | Every CSV export also as `.xlsx` (same rows; amounts as numbers, identifiers as text): products, stock, valuation, waste, food cost, payables and receivables exports | "Excel" buttons beside the CSV links  |
| PDF    | Purchase order for the supplier and B2B sales invoice for the customer, with the company letterhead (e-invoicing seller name, address, VAT and CR numbers)            | "PDF" button on the order and invoice |
| Arabic | Bundled DejaVu fonts; Arabic names shaped and ordered correctly; labels and values in separate cells                                                                  | PDFs                                  |

Not yet: PDFs of statements, delivery notes and goods receipts; scheduled report e-mails (need the email provider, D2). Print pages remain for the rest.

Checks: `pnpm check` pass (unit 283); `pnpm test:integration` 405/405 pass (new: letterhead from the company and its e-invoicing details; a 45-line purchase order renders as a two-page PDF with the font embedded; another organization and a cashier cannot read the order); output checked visually (Arabic words, spacing and page breaks); `pnpm test:e2e` 63/63 pass (new: products downloaded as Excel; the purchase order PDF served as `application/pdf`).

## F2b — Global search (built)

Rules: DECISIONS.md ADR-088.

| Area          | What works                                                                                                                                                                                                                     | Where             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| Search box    | In the header (search icon on small screens); results grouped by kind, up to six each, linking to the record                                                                                                                   | header, `/search` |
| What is found | Products (SKU, names, barcode), suppliers, B2B customers, guests (name or phone in any format), employees, recipes, menu items, lots, POs, receipts, supplier invoices, sales orders and invoices, POS orders, stock documents | `/search`         |
| Permissions   | A group only with the permission its page needs; documents and employees only at the user's branches and warehouses                                                                                                            | service           |
| Speed         | Trigram indexes (`pg_trgm`) on the searched columns                                                                                                                                                                            | migration         |

Not yet: saved filters and views; searching inside notes.

Checks: `pnpm check` pass (unit 281); `pnpm test:integration` 402/402 pass (new: master data by code or name in English and Arabic; documents by number; a guest by a local phone number; a branch manager sees only their branch's people; a waiter only menu items; a kitchen role nothing; another organization nothing; too-short queries ignored); `pnpm test:e2e` 62/62 pass (new: search from the header and open the product).

## F2a — Job runner and notification centre (built)

Rules: DECISIONS.md ADR-087. Plan: docs/PLATFORM_AUDIT.md (phase F2).

| Area          | What works                                                                                                                                                                   | Where                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Job runner    | PostgreSQL queue; `pnpm jobs:run` (or `--watch`) schedules webhook delivery, ZATCA reporting, attachment purge and the daily digest; retries with backoff; failures notified | `scripts/run-jobs.ts`  |
| Notifications | Written with the change: PO and stock-count approvals and decisions, leave requests and decisions, invoice exceptions, daily attention digest, failed jobs                   | bell, `/notifications` |
| Recipients    | From their grants (approval level and site, HR branch or direct manager, invoice managers, administrators); never the person who acted                                       | services               |
| Preferences   | Each user turns kinds on or off                                                                                                                                              | `/notifications`       |
| Jobs page     | The organization's recent jobs, attempts, outcome or error                                                                                                                   | `/settings/jobs`       |

Not yet: email, SMS and WhatsApp (need the provider decision D2); the Render free plan has no background worker, so `pnpm jobs:run` runs from another machine or a paid Render cron job. Next in F2: global search (F2b), XLSX/PDF export (F2c), REST API v1 + OpenAPI (F2d).

Checks: `pnpm check` pass (unit 278); `pnpm test:integration` 398/398 pass (new: approvers at the order's branch notified, not another branch nor the submitter; decision notified to the submitter; only the user's own notifications opened, none across organizations; preferences respected; daily digest written once per day; a failing job retried with backoff, then failed and the administrators told; jobs visible only to the organization's administrators); `pnpm test:e2e` 61/61 pass (new: bell, empty list, preferences saved).

## F1b steps 3b and 3c — Purchasing, payables and sales in the company's currency (built)

Rules: DECISIONS.md ADR-086. With these, F1 (enterprise layer) is complete.

| Area                   | What works                                                                                                                                                                         | Where                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Purchasing             | Orders (supplier's currency, else the company's), receipts, landed costs and supplier invoices booked in the company's currency; PO approval limits compared in the group currency | `/purchasing`                           |
| Payables / receivables | Payments, credit notes and customer receipts belong to a company and settle only its invoices (service and database); balances per company with group totals converted             | `/purchasing/payables`, `/b2b/balances` |
| Per company            | FX revaluation, VAT return (input and output VAT) and accounting journals, each in the company's currency                                                                          | revaluation, `/sales/vat`, exports      |
| Point of sale          | Till, online ordering, checks, payment links in the branch's company's currency; branch prices only there; options that change the price, points and fixed coupons refused there   | `/pos`, ordering pages                  |
| Gift cards             | In the selling register's company's currency; spent only in that currency (service and database); owed per currency                                                                | `/pos/gift-cards`                       |
| Sales imports and B2B  | In the warehouse's company's currency                                                                                                                                              | `/sales`, `/b2b`                        |
| Group figures          | Overview sales and best sellers, food cost, waste converted at the period's average rate; missing rates named                                                                      | overview, reports                       |

Known limits (ADR-086): card settlement files and delivery payout reconciliation assume one currency per file; per-branch prices for modifier options and multi-currency loyalty are not built.

Checks: `pnpm check` pass (unit 275); `pnpm test:integration` 393/393 pass (new: purchasing flow in EGP — order, receipt and stock in EGP; EGP and USD invoices with the cross rate; balances per company and group total; a payment settles only its company's invoices, also refused by the database; revaluation per company; journal in EGP — and the Cairo till: EGP prices and cost, options that change the price refused, points not spent or earned, a SAR gift card refused, dashboard converted and missing rate named; sales import in EGP). The HR document-expiry test used the UTC date and failed after midnight in Riyadh; it now uses the organization's business date, as the service does. `pnpm test:e2e` 60/60 pass.

## F1b step 3a — Currency per company: foundation and stock (built)

Rules: DECISIONS.md ADR-086.

| Area             | What works                                                                                                                                         | Where                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Company currency | Chosen per company (group's by default); fixed once the company has stock or documents (service and database)                                      | `/settings/companies`                 |
| Exchange rates   | Cross rates through the group currency for a company keeping its books in another currency; missing or stale rates refused                         | services                              |
| Stock            | Valued in the warehouse's company's currency; pages, movements, documents, counts and production show that currency                                | `/inventory`, `/production`           |
| Group figures    | Stock value at today's rates; waste and food cost at the period's average rate; recipe average costs converted; missing rates named, never guessed | inventory, reports, overview, recipes |
| One company      | Its own figures in its own currency (overview and food cost filtered by company, one warehouse's valuation)                                        | overview, reports                     |
| Rules            | No stock moves between companies with different currencies; count approval limits compared in the group currency; ZATCA needs a SAR company        | transfers, shipments, counts, ZATCA   |

Not yet in a company's own currency (refused with a clear message, and by the database): purchasing and payables (step 3b); point of sale, sales imports and B2B (step 3c).

Checks: `pnpm check` pass (unit 275); `pnpm test:integration` 384/384 pass (new: currency chosen and fixed once there is stock — refused by the service and the database; stock values in each warehouse's currency; group total converted and a missing rate left out and named; cross rate through the group currency; waste converted for the group and kept in EGP for the Egyptian company; transfers and shipments across currencies refused, also directly in the database; purchasing refused for the other-currency company only); `pnpm test:e2e` 60/60 pass.

## F1b step 2b — ZATCA per company (built)

Rules: DECISIONS.md ADR-085.

| Area           | What works                                                                                                                  | Where             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Seller details | Per company (legal name, CR, national address, category, environment); existing settings moved to the default company       | `/settings/zatca` |
| Units          | A register's unit signs for its branch's company; one back-office unit per company; a unit never changes company (database) | `/settings/zatca` |
| Documents      | POS invoices and credit notes as the register's company; B2B standard invoices on the office unit of the invoice's company  | all flows         |
| Receipts       | Phase 1 QR with the selling company's name and VAT number                                                                   | receipt           |

ZATCA itself is still not validated against the live sandbox (network allowlist pending); the flows are tested with a simulated transport. ZATCA still needs the Saudi riyal as base currency (per-company currency is step 3).

Checks: `pnpm check` pass (unit 275); `pnpm test:integration` 378/378 pass (new: two Saudi companies in one group — own seller details and registers, receipts with each company's VAT number and name, units and CSRs per company, one office unit per company, a company outside Saudi Arabia refused, a unit keeps its company, other organizations' companies unreachable); `pnpm test:e2e` 60/60 pass.

## F1b step 2a — VAT per company (built)

Rules: DECISIONS.md ADR-084.

| Area        | What works                                                                                                                                   | Where                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| VAT rates   | Rates tagged by country under shared codes; a second country's preset adds its rates without changing the group's VAT country                | `/settings/tax`       |
| Companies   | "Registered for VAT" per company (country with VAT, valid number, rates set up); the default company follows the VAT settings page           | `/settings/companies` |
| Calculation | POS and till menu (branch's company), supplier invoices (billed company), B2B invoices (order's company), sales imports (warehouse's branch) | all flows             |
| Receipt     | POS receipt shows the selling company's VAT number                                                                                           | receipt               |

Not yet: ZATCA seller and e-invoice numbering per company (step 2b); per-company currency (step 3). Recipe food-cost pricing and supplier credit notes use the default company.

Checks: `pnpm check` pass; `pnpm test:integration` 375/375 pass (new: a Saudi and an Egyptian company in one group — 15 % vs 14 % on sales and supplier invoices, registration rules, default company follows VAT settings, unregistered company charges no VAT, a Saudi rate change does not reach the Egyptian company); `pnpm test:e2e` 60/60 pass. The migration first failed because `tax_rates` is append-only; the one-off tagging now runs with its triggers off.

## F1b step 1 — Company on money documents (built)

Rules: DECISIONS.md ADR-083.

| Area              | What works                                                                                                         | Where                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Documents         | POS orders, POs, receipts, B2B sales orders and invoices stamped with their company by the database; never changes | all flows (no screen change)             |
| Supplier invoices | Billed company chosen (default otherwise); only that company's receipts offered and accepted                       | `/purchasing/invoices/new`, invoice page |
| Dashboard         | Company filter on the overview (whole group by default)                                                            | overview                                 |

Not yet: per-company VAT and ZATCA (step 2); per-company currency and consolidation (step 3).

Checks: `pnpm check` pass (unit 275); `pnpm test:integration` 370/370 pass (new: orders and receipts take their branch's company and never change; supplier invoice bills a chosen or the default company and matches only that company's receipts — refused by the service and, inserted directly, by the database; dashboard by company with costs following); `pnpm test:e2e` 60/60 pass.

## F1a — Companies (legal entities) and brands (built)

Rules: DECISIONS.md ADR-082. Plan: docs/PLATFORM_AUDIT.md (phase F1).

| Area      | What works                                                                                                                                | Where                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Companies | Add, edit, make default, archive (no active branches, never the default); one default per organization, backfilled from existing settings | `/settings/companies` |
| Brands    | Add, archive (clears from branches)                                                                                                       | `/settings/brands`    |
| Branches  | Company on creation (default when one), optional brand; a branch stays with its company; company and brand shown in list and page         | `/branches`           |

Not yet (F1b): per-company currency, VAT and ZATCA; company on money documents; consolidated reporting by company.

Checks: `pnpm check` pass (unit 275); `pnpm test:integration` 366 — 365 passed in the full run; the failure was another time-of-day dependency in the POS5e ordering tests (slot [3] did not exist late in the evening, so the test silently ordered "as soon as possible"); its channel now offers tomorrow too and the test asserts the slot exists — 12/12 pass. New: companies (default and backfill, legal entity, brand, a branch stays with its company, archive and default rules, permissions, cross-tenant) and the row-level-security test now uses the other tenant's own company. `pnpm test:e2e` 60/60 passed (new: companies and brands).

## HR2b — Leave with approvals (built)

Rules: DECISIONS.md ADR-081.

| Area                      | What works                                                                       | Where                        |
| ------------------------- | -------------------------------------------------------------------------------- | ---------------------------- |
| Leave types               | Common types with one click (no entitlements invented); own types; archive       | `/hr/leave/types`            |
| Entitlements and balances | Days per employee, type and year; remaining = entitled − approved − waiting      | employee page, My leave      |
| Requests                  | Employee (My leave) or HR for an employee; overlap, balance and one-year checks  | `/my/leave`, employee page   |
| Approval                  | Direct manager (own account) or HR for the branch; never one's own; cancel rules | `/hr/leave`, My leave → team |

Checks: `pnpm check` pass (unit 275; new: day counting, overlaps, common types without entitlements); `pnpm test:integration` 361 — 360 passed; the one failure was the POS5e ordering test counting today's pick-up slots, which depended on the hour it ran (late evening left fewer than 9). Its channel now offers tomorrow too, and it passes (12/12). `pnpm test:e2e` 57 of 59 in the full run: the HR test met a second "Reason" field (the termination one is now "Reason for leaving") and the leave test read the approved list before the approval had saved (it now waits); HR, leave and attendance tests then pass (3/3).

## HR2a — Time and attendance (built)

Rules: DECISIONS.md ADR-080.

| Area          | What works                                                                                                               | Where                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Branch tablet | Secret link per tablet; employee number + PIN; lockout after 5 wrong PINs; rate limits; clock in/out alternates          | `/clock/<link>`, setup page     |
| Phone         | "My attendance" for linked staff; optional branch location and radius (distance kept, not location)                      | `/my/attendance`                |
| Devices       | Signed batches from fingerprint or face devices; repeats ignored; unknown numbers reported                               | setup page, `docs` in ADR-080   |
| HR            | Board (who is in, sessions, hours, missing punches) by day; employee history; missed punch with reason; void with reason | `/hr/attendance`, employee page |

Not yet: rosters and shifts (lateness, overtime), leave and approvals,
onboarding checklists; native vendor device formats.

Checks: `pnpm check` pass (unit 272; new: distance, clock-in alternation, PIN format, timesheet pairing with night shifts and unmatched punches); `pnpm test:integration` 354 pass (new: tablet PIN and lockout, switched-off tablet, employee on leave, phone radius with distance only, device batches with repeats and unknown numbers and signatures, manual punch and void, punches never edited, cross-tenant); `pnpm test:e2e` 57 of 58 in the full run — the HR test met two fields called "Reason" on the employee page; the attendance one was relabelled ("Why it is entered by hand") and both HR and attendance tests then pass.

## HR1 — HRIS (built)

Rules: DECISIONS.md ADR-079. The HR tab lists all eleven HR capabilities
with their state; only HR1 is built.

| Area                   | What works                                                                                                               | Where                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| HR overview            | Active, on leave, hired in 30 days, documents expired or expiring; headcount by branch and department; capability map    | `/hr`                              |
| Employees              | Register, edit, search and filter; automatic or own numbers; manager, department, branch; optional sign-in account       | `/hr/employees`                    |
| Status                 | On leave, active, left (date and reason); refused while the person still manages others; rehire                          | employee page                      |
| Documents              | Iqama, ID, passport, work permit, health certificate, licence, contract with expiry states; numbers only for HR managers | employee page                      |
| Departments, org chart | Departments with parents (archive only when empty); reporting tree                                                       | `/hr/departments`, `/hr/org-chart` |
| Access                 | `hr.view` / `hr.manage` per branch; ID numbers hidden from viewers and kept out of the audit log                         |                                    |

Not built yet (phases in PROJECT_PLAN.md): attendance and leave, approvals,
onboarding checklists, recruitment, workforce planning, payroll (waits for
Q-20), performance, engagement, learning, HR analytics beyond headcount.

Checks: `pnpm check` pass (unit 268; new: document expiry states, reporting-loop check, org tree); `pnpm test:integration` 348 pass (new: numbering, loops, foreign managers, ID numbers hidden and kept out of the audit log, documents, termination rules, branch scope, cross-tenant); `pnpm test:e2e` 55 of 57 passed in the full run — the 2 failures were Playwright losing its own trace files on closing the browser (ENOENT), and both passed on rerun with the table-service tests (5/5); new HR journey test passes.

## Security and follow-ups (2026-11-02)

| Area                    | What works                                                                                                                                                                                                                        | Where                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Two-step sign-in        | Optional TOTP per user; setup by QR with password, confirmed by a first code; ten one-time backup codes; turn off with password                                                                                                   | `/account/security`, `/sign-in/two-factor`                   |
| Content Security Policy | Per-request nonce, `'strict-dynamic'`; inline handlers and injected scripts refused; no framing; attachment downloads keep their sandbox policy                                                                                   | `src/proxy.ts`, `src/lib/csp.ts` (ADR-074)                   |
| Check screen            | Customer, loyalty points and gift cards (with split payments) when paying a table's check                                                                                                                                         | check screen                                                 |
| Report discounts        | Food cost report shows discounts given per branch; CSV column `discounts_given`                                                                                                                                                   | `/reports`                                                   |
| Delivery payouts        | Import a platform settlement statement (canonical CSV); lines matched with received orders; unpaid accepted orders of the period; commission rate; bank difference; confirming fixes it and settles each order once               | `/pos/delivery/payouts` (ADR-075)                            |
| Hosted demo             | `render.yaml` Blueprint for Render (Frankfurt): app + PostgreSQL, migrations and [DEMO] seed before each deploy; rehearsed on an empty PostgreSQL 16 with a non-superuser owner, not yet run on Render                            | `render.yaml` (ADR-076)                                      |
| Brand look              | Red, white and black theme from the logo; Supy-style black sidebar with icons and collapsible groups; restyled cards, tables, badges, buttons; logo on sign-in and home; stale "modules arrive in upcoming releases" note removed | `globals.css`, `components/shell`, `components/ui` (ADR-077) |
| Overview dashboard      | KPI cards (today, 14 days; food cost, waste and discounts for cost viewers), net sales per day chart, top sellers — real POS figures only, scoped like the reports                                                                | overview (ADR-078)                                           |
| Touch-friendly POS      | Larger tiles, in-order badges, 44 px quantity buttons, self-sizing tiles on tablets                                                                                                                                               | till, table check                                            |
| Demo restaurant         | `[DEMO] Olaya Burgers`: menu, till with open shift, 8 tables, promotion, loyalty, ordering page, sample orders                                                                                                                    | `prisma/seed-restaurant.ts`                                  |
| Pick-up slot capacity   | Optional orders-per-slot limit; full slots hidden and refused                                                                                                                                                                     | `/pos/online/setup`                                          |

Rules: DECISIONS.md ADR-073 – ADR-078 (and ADR-068, ADR-067, ADR-071).

Checks: `pnpm check` pass (unit 50 files / 265 tests; new: CSP nonce and directives, payout statement parsing, merging, matching and totals); `pnpm test:integration` 51 files / 336 tests pass (new: payouts — matching, unpaid orders by local day, duplicate statements, settle-once on confirm, fixed confirmed rows, finance-only, cross-tenant); `pnpm test:e2e` 56 passed (new: two-step sign-in journey, strict CSP with an injected handler refused, payout import and confirm in the delivery journey).

## POS4b — ZATCA standard (B2B) invoices with clearance (built; ZATCA validation pending)

Rules: DECISIONS.md ADR-072.

| Area             | What works                                                                                                                | Where                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Back-office unit | One per organization for standard invoices; key, CSR ("1000"), onboarding with OTP and three standard samples             | `/settings/zatca`                       |
| Buyer details    | VAT or CR number and national address on the B2B customer; incomplete buyers refused at invoicing                         | customer page                           |
| Standard XML     | Buyer party, supply date, type 0100000, VAT in SAR for foreign-currency invoices                                          | `zatca/invoice.ts`                      |
| Clearance        | Right after invoicing; retries with back-off; "Clear now"; cleared document and ZATCA's QR kept; rejections with messages | sales invoice page, `clearSalesInvoice` |
| Credit notes     | Cancelling an e-invoiced invoice issues and clears a standard credit note                                                 | `cancelSalesInvoice`                    |

**Not tested against ZATCA** (gw-fatoora.zatca.gov.sa is blocked here):
clearance and onboarding run against a simulated ZATCA.

Checks: `pnpm check` pass (unit 49 files / 257 tests; new: standard type,
buyer and supply date in UBL order, VAT in SAR for a USD invoice, buyer
without VAT by CRN, buyer completeness, clearance answers and the cleared
QR); `pnpm test:integration` 50 files / 328 tests pass (7 new: invoicing unchanged before
onboarding; the back-office unit onboarded with standard samples; an
incomplete buyer and a backdated invoice refused, completing the customer
lets it through; cleared with the cleared document and its QR, the signed
original unchanged; a 503 retried and a rejection kept with ZATCA's
messages; a cancelled invoice cleared as a standard credit note; the
scheduled job clears too, other organizations and viewers cannot act);
`pnpm test:e2e` 54 tests pass.

## POS5e — Guest prepayment, pick-up times, promotions, manual ready (built; Moyasar validation pending)

Rules: DECISIONS.md ADR-071.

| Area           | What works                                                                                                                | Where                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Payment mode   | Per page: at the counter, online before ordering, or the guest's choice; register for online payments                     | `/pos/online/setup`           |
| Online payment | Guest sent to Moyasar; back to the status page; payment confirmed with Moyasar by the server, recorded once, then kitchen | `/order/<token>`, status page |
| Expiry         | Unpaid after 30 min: cancelled (the invoice expires too); paid-but-unrecorded orders never expire, reason shown to staff  | `syncGuestOrdersInCtx`        |
| Pick-up times  | Slots in opening hours (past midnight too), lead time, days ahead; ASAP while open; only offered slots accepted           | guest page, `pickup-rules.ts` |
| Held orders    | Accepted for later, released to the kitchen at its preparation time before pick-up                                        | staff list                    |
| Ready / handed | Ready from kitchen screens or staff; handed over by staff for online-paid orders; counter-paid collected when paid        | `/pos/online`                 |
| Promotions     | Shown on the guest page (struck price, total) with the till's rules                                                       | guest page                    |

**Not tested against Moyasar** (api.moyasar.com is blocked here): the
invoice return address and expiry fields follow Moyasar's invoice API and
are checked against a simulated Moyasar.

Checks: `pnpm check` pass (unit 47 files / 252 tests; new: slots in the
branch's time zone across daylight saving and midnight, lead time, offered
slots with grace, release time, the guest order states); `pnpm
test:integration` 49 files / 321 tests pass (4 new: online payment — no register refused,
invoice amount, return address and expiry, waiting not accepted, paid →
card payment recorded and sent to the kitchen, cannot be rejected, ready
and handed over by staff; unpaid order expired and its link closed, an
order paid with another amount kept with the reason; slots offered, a
non-slot refused, accepted for later held, released at its lead time, paid
at the counter → collected; promotions shown to the guest and charged the
same); `pnpm test:e2e` 54 tests pass (the online ordering journey now also
marks an order ready by hand and the guest sees it).

## POS5d — Online ordering and self-order kiosks (delivered)

Rules: DECISIONS.md ADR-070.

| Area    | What works                                                                                                   | Where                              |
| ------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Pages   | Web page (pick-up) or kiosk (eat in / take away) per branch; public address; order limit; auto-send; close   | `/pos/online/setup`                |
| Guest   | Menu with server prices and options, cart, name (+ mobile on the web), note; resend-safe; Arabic and English | `/order/<token>`, `/kiosk/<token>` |
| Kiosk   | Large buttons, no phone, order number shown, back to the start for the next guest                            | `/kiosk/<token>`                   |
| Staff   | Open guest orders with state (new / in the kitchen / ready); accept (to the kitchen) or reject with a reason | `/pos/online`                      |
| Status  | Guest's own page: received → preparing → ready → collected, or cancelled with the reason; refreshes          | `/order/status/<token>`            |
| Payment | At the counter, as any check (cash, card, gift card, pay by QR)                                              | check screen                       |
| Safety  | Rate limits per address and per page; refused orders leave nothing; phone cleared when the check closes      | `pos/ordering.ts`                  |

Checks: `pnpm check` pass (unit 46 files / 247 tests); `pnpm test:integration`
49 files / 317 tests pass (7 new: a floor is needed and the web takes no eat-in; the public
menu shows only the page's channels with server prices; a web order becomes
a check, a resend returns it, reject shows the reason, accept → kitchen →
ready → paid → collected, phone cleared; kiosk orders go to the kitchen at
once without a phone; missing phone, wrong channel, too large and unknown
items refused leaving nothing; the rate limit; a closed page stops and
other organizations cannot see or act); `pnpm test:e2e` 54 tests pass (new:
set up a web page and a kiosk, a guest orders on the web, the branch
accepts, the guest's status page follows; a kiosk order goes straight to
the kitchen and the kiosk resets).

Limitations: addressed by POS5e (online prepayment, pick-up times, manual
ready, promotions on the guest page).

## POS5c — Delivery platform orders (built; native adapters pending platform specifications)

Rules: DECISIONS.md ADR-069; format: docs/DELIVERY.md. Q-18 decided:
HungerStation, Jahez, Keeta, plug and play.

| Area       | What works                                                                                                      | Where                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Connectors | One per platform and register; address and secret shown once; disable, rotate, request log (integrations page)  | `/pos/delivery/setup`                     |
| Adapters   | Registry per platform; canonical format for all today; native adapter = one file once a spec is available       | `delivery/adapters.ts`                    |
| Mapping    | Platform item and modifier ids → menu items and options; ids waiting for a mapping listed                       | `/pos/delivery/setup/<connector>`         |
| Orders     | Waiting / needs mapping / accepted / rejected / cancelled; accept or reject (with reason); refreshes every 10 s | `/pos/delivery`                           |
| Recording  | POS order with the platform's prices and discount, paid to the platform, kitchen ticket, stock, VAT, ZATCA      | `acceptDeliveryOrder` → `recordOrderInTx` |
| Automatic  | Optional auto-accept when mapped and a shift is open; otherwise waits with the reason                           | connector setting                         |
| Cancelling | Platform cancellation closes a waiting order or voids an accepted one in its open shift                         | `order.cancelled`                         |

**Not tested against HungerStation, Jahez or Keeta**: their partner APIs
need onboarding (and `api-docs.mykeeta.com` is not reachable from the
development environment). No native adapter is claimed; all three connect
through the canonical format (directly or via middleware) until their
specifications and sandboxes are available.

Checks: `pnpm check` pass (unit 46 files / 247 tests; new: the canonical
format for every platform, no adapter claimed native, ids still to map);
`pnpm test:integration` 48 files / 310 tests pass (7 new: unsigned and malformed requests
refused; unmapped order waits, mapping moves it on, accepted with the
platform's prices, discount, VAT and platform payment; the same platform
order not taken twice; a wrong total kept with its reason, rejected;
auto-accept with a kitchen ticket, cancellation voids it, platform money
apart in the shift; devices cannot send a platform payment; other
organizations cannot see, accept or map); `pnpm test:e2e` 53 tests pass (new:
connect HungerStation in the UI, a signed order arrives, map its item,
accept, see the POS order).

Also: the inbound checks were moved into one shared function for sales and
delivery connectors; the order page shows the order's note.

Limitations: no status sent back to the platforms (accepted, ready,
rejected) and no menu sync until native adapters exist; platform payouts
are not reconciled yet; each modifier option once per item.

## POS5b — Customers, loyalty points and gift cards (delivered)

Rules: DECISIONS.md ADR-068.

| Area        | What works                                                                                                                   | Where                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Customers   | Found by phone or added at the till; list and search, consent to offers, edit, erase personal data (PDPL)                    | till, `/pos/customers`          |
| Loyalty     | Points per currency paid, point value, minimum; earn on orders, spend as the order discount; void/refund take back correctly | till, `pos/customers.ts`        |
| Corrections | Points added or taken with a reason; full history                                                                            | customer page                   |
| Gift cards  | Sold at the till (cash or card, counted in the shift), code shown once and kept hashed; spent alone or with cash/card        | till, `pos/gift-cards.ts`       |
| Finance     | Cards, what is still owed (liability), block a lost card                                                                     | `/pos/gift-cards`               |
| Records     | Customer, points spent and earned, gift card (last 4) on receipts and the order page; gift cards in the X/Z report           | receipt, order page, shift page |

Checks: `pnpm check` pass (unit 45 files / 244 tests; new: points earned,
valued and taken back on refunds, phone numbers, gift card check digit);
`pnpm test:integration` 47 files / 303 tests pass (10 new: a cashier adds and finds a
customer, duplicate and invalid numbers, managers only for the list and
corrections; earn and spend points with VAT on the paid amount, void returns
points; too few/too many/worth more than the order refused; refund takes
back the share; the ledger equals the balance; gift card sold in the shift
and kept as a hash, paid alone and split with cash, more than the balance
refused, void returns it; mistyped/unknown/blocked cards refused, finance
only can block; gift card cash in expected cash and not in sales; erasure;
other organizations cannot find, change or use customers and cards);
`pnpm test:e2e` 52 tests pass (new: loyalty settings, customer added at the
till, gift card sold, points + gift card + card on one order, receipt and
order page, gift card liability, erasure).

Also fixed: the order page showed "[object Object]" for an order discount
(POS5a); covered by the new E2E.

Limitations: the check screen does not yet offer customers, points or gift
cards (the server accepts them on checks); refunds go back in cash or by
card, not onto a gift card; no expiry on cards or points; VAT treatment of
points and gift cards to be confirmed with a tax adviser.

## POS5a — Discounts, promotions and coupons (delivered)

Rules: DECISIONS.md ADR-067.

| Area             | What works                                                                                                                    | Where                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Promotions       | % off items or categories by channel, weekday, hours (past midnight too) and dates; best one wins; archived, never edited     | `/pos/promotions`, `pos/promotions.ts` |
| Coupons          | Code, % or amount, dates, maximum uses; checked online on the till or check, use counted in the order's transaction           | `/pos/promotions`, till, check screen  |
| Manual discounts | % or amount off the order with a reason; needs `pos.discount` (admins, operations and branch managers)                        | till, check screen                     |
| Pricing          | Promotion, then the order discount spread over the lines; VAT on the discounted amount; same rules on the till and the server | `pos/discounts.ts`                     |
| Offline          | Promotions as loaded on the till (`menuAsOf`), at the time each item was ordered (checks: when the item was added)            | `recordOrderInTx`                      |
| Records          | Per line discount and promotion, per order promotions, order discount, reason, coupon; receipt, order page, X/Z report        | receipt, order page, shift report      |
| Nothing to pay   | An order discounted to nothing is completed without a payment                                                                 | till                                   |

Checks: `pnpm check` pass (unit 44 files / 240 tests; new: promotion
matching, discount spreading and VAT, the local time at the branch, and
payments for an order discounted to nothing — the old rule that an order
always needs a payment was changed on purpose for 100 % discounts and its
test updated to the new rule); `pnpm test:integration` 46 files / 293 tests
pass (12 new: promotion and VAT, a till showing the undiscounted total
refused, days/hours/best promotion, offline orders priced with the
promotions the till had, promotions immutable, promotions on a check paid
later, manual discount needs `pos.discount` and a reason and is spread,
refund of a discounted line, discount capped at the order and no payment,
shift report, coupon used up, unknown/future/archived/duplicate coupons,
coupon and manual discount together refused, other organizations cannot
see or use promotions and coupons — RLS included); `pnpm test:e2e`
51 tests pass (new: promotion, coupon, coupon used up, 100 % manual discount,
receipt).

Limitations: one promotion per item (no stacking, no "buy X get Y" or
bundle prices yet); coupons need the till online when applied; pay by QR
takes no order discount; discounts are not yet in the food cost and sales
reports beyond the shift report.

## POS3b — Pay by QR with Moyasar (built; Moyasar validation pending)

Rules: DECISIONS.md ADR-066. Q-15 decided for Saudi Arabia.

| Area            | What works                                                                                                               | Where                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Provider key    | Moyasar test or live secret key, checked against the mode, sealed, never shown again                                     | `/settings/payments`              |
| QR on the check | "Pay by QR" for everything left or chosen items; QR and link; checked every 4 s; cancel an unpaid link                   | check screen, `payments/links.ts` |
| Recording       | Paid at Moyasar → recorded once on the check as a card payment with scheme, last 4 and the Moyasar reference             | `refreshPaymentLink` → `payTab`   |
| Safety          | Server-priced amount (changed total refused); amount reported by Moyasar must match; unrecorded payments keep the reason | `payment_links.problem`           |

**Not tested against Moyasar**: `api.moyasar.com` is blocked in the
development environment. Verified here: halala amounts, reading the paying
card (last 4 only), and the whole flow against a simulated Moyasar.

Checks: `pnpm check` pass (unit 43 files / 235 tests, 2 new: halala
amounts and fractions refused, invoice states and the paying card);
`pnpm test:integration` 45 files / 281 tests pass (3 new, simulated
Moyasar: provider missing, key/mode check, admins only, key sealed; a
changed total refused, the amount sent in halalas with Basic auth,
pending, paid by mada and recorded once with scheme, last 4 and reference,
the check closed; part of a check, a different amount reported, cancel,
other organizations cannot see a link); `pnpm test:e2e` 50 tests pass (new:
key form refuses a key of the wrong mode and saves a test key without
showing it; the check offers Pay by QR and shows the provider's refusal for
a key that is not real, recording nothing).

Limitations: pay by QR on checks only (not yet on the counter till);
links are checked by polling while the check is open (no webhook yet);
no refunds through Moyasar from here (refund in Moyasar's dashboard and
record the refund on the order); terminal ECR integration waits on the
acquirer.

## POS3a — Card payments and settlements (delivered)

Rules: DECISIONS.md ADR-065. The terminal/gateway connection (POS3b) waits
on Q-15.

| Area         | What works                                                                                                                                            | Where                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Card details | Scheme, terminal, approval code and last 4 digits from the slip on card payments (optional); never on cash                                            | till, order page, `pos_payments`         |
| No card data | A database CHECK allows exactly 4 digits — a full card number cannot be stored                                                                        | migration                                |
| Tips         | On card payments, outside sales and VAT; card tips on the X/Z report                                                                                  | till, shift report                       |
| Card refunds | The terminal's refund reference                                                                                                                       | refund form                              |
| Settlements  | Import the acquirer's CSV once; matched by approval code, terminal and amount within 2 days; differences, sales without a payout (after 3 days), fees | `/pos/settlements`, `pos/settlements.ts` |

Checks: `pnpm check` pass (unit 42 files / 233 tests, 3 new: matching by
code and amount with each payment used once, terminals and the two-day
window, the settlement file and its errors); `pnpm test:integration` 44
files / 278 tests pass (2 new: card details and tip stored, the tip not a
sale, card details or tips on cash refused, a 16-digit "last 4" refused by
the service and by the database, tips on the shift, the card refund
reference; import refused for cashiers and for a bad file, matched /
different amount / no such sale, the same file twice refused, period
totals, fees and payments not settled, a payment paid out once, other
organizations see nothing); `pnpm test:e2e` 49 tests pass (new: a card sale
with scheme, approval code, last 4 and tip shown on the order; the
acquirer's file uploaded and the payment matched, nothing left unsettled).

Found and fixed: the till's card fields were labelled by wrapping the
inputs, so the scheme list's accessible name included every option; they
now have explicit labels.

Limitations: no connection to a terminal or gateway yet (the amount is
keyed on the terminal and confirmed on the till); split payments on a
check do not take card details; one settlement file format (CSV with the
documented columns) until the acquirer is chosen.

## POS4a — ZATCA e-invoicing, simplified documents (built; ZATCA validation pending)

Rules: DECISIONS.md ADR-064. Q-17 decided: Saudi Arabia first.

| Area           | What works                                                                                                                                                                    | Where                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Receipt QR     | Phase 1 QR (seller, VAT number, time, total, VAT) on receipts in Saudi Arabia; Phase 2 QR of the signed document once onboarded                                               | receipt page, `zatca/tlv.ts`                 |
| Seller details | Legal name, CR, national address, business category, ZATCA environment; requires SAR and Saudi VAT registration                                                               | `/settings/zatca`                            |
| Units          | One per register: secp256k1 key (sealed), CSR with ZATCA's extensions; onboarding with the portal OTP (compliance CSID, three compliance samples, production CSID), resumable | `zatca/signing.ts`, `zatca/service.ts`       |
| Documents      | Signed simplified invoice per sale; credit note per refund and void; UBL 2.1 canonical XML, hash, ECDSA signature, XAdES, ICV/PIH chain per unit; immutable                   | `zatca/invoice.ts`, `zatca_documents`        |
| Reporting      | `pnpm zatca:report` (scheduled) or "Report now": reported, with warnings, rejected (answer kept), retried with backoff                                                        | `zatca/client.ts`, `scripts/report-zatca.ts` |

**Not validated against ZATCA.** The environment's network policy blocks
`gw-fatoora.zatca.gov.sa`. Verified here: the Phase 1 QR reproduces ZATCA's
published example byte for byte; OpenSSL verifies the CSR and shows the
ZATCA extensions; signatures verify with the device key; the flows run
against a simulated ZATCA. Still to verify with ZATCA's sandbox: the
invoice hash and signed-properties digest as ZATCA computes them, amount
rounding (BR-KSA rules), exemption codes for zero-rated or exempt items,
and the API responses. Do not use the core (production) environment until
then.

Checks: `pnpm check` pass (unit 41 files / 230 tests, 8 new: ZATCA's QR
example, Arabic names and field limits, canonical XML with totals per VAT
category and escaping, credit note references, the hash of the document
without stamp equals the signed digest and the signature verifies, the
Phase 2 QR fields, the first PIH and the chain, certificate reading, the
CSR's signature and extensions); `pnpm test:integration` 43 files / 276
tests pass (6 new, simulated ZATCA: Phase 1 QR before onboarding with the
order's totals, SAR required, seller details validated, admins only; key
sealed and CSR made, wrong OTP leaves the unit as it was, onboarding sends
the compliance request, three signed samples whose hashes match and the
production request; sales, a refund and a void form one chain with signed
QRs that verify; reporting outcomes 200/202/400/503 with retry; documents
cannot change or be deleted; other organizations see nothing);
`pnpm test:e2e` 48 tests pass (new: Saudi organization, VAT registration,
seller details with a building-number check, a card sale whose receipt is a
simplified tax invoice with the QR, a register's unit prepared and waiting
for the OTP).

Found and fixed: invoices were written in the organization's base
currency, so a non-SAR organization would have produced riyal-less
documents; ZATCA setup is now refused unless the base currency is SAR.

Limitations: standard (B2B) invoices and clearance are POS4b (the B2B
sales invoices of M9b are not e-invoiced yet); zero-rated and exempt lines
carry no exemption reason code yet; receipts printed before a sale is
synced from an offline till have no QR (printed after sync).

## POS2b — Kitchen display (delivered)

Rules: DECISIONS.md ADR-063.

| Area           | What works                                                                                                                               | Where                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Stations       | Per branch with a target time; one default station per branch (`pos.manage`)                                                             | `/pos/kitchen/setup`                    |
| Routing        | By menu category or by item (item wins), else the default station, else no ticket                                                        | `pos/kitchen-rules.ts` `stationFor`     |
| Tickets        | Created when check items are sent and when a counter order is paid (offline orders when they sync); one per station per event            | `pos/kitchen.ts` `createTicketsInTx`    |
| Kitchen screen | Oldest first, waiting time against the target (warning from 75 %, late at the target), bump, recall the last bumped; refreshes every 5 s | `/pos/kitchen/[stationId]`              |
| Status back    | Check items: preparing / ready; floor plan: tickets in the kitchen per table; register: preparing / ready per counter order              | check screen, floor plan, register page |
| Voids          | A voided check item or counter order stays on its ticket, struck through                                                                 | `markVoidedInTx`                        |
| Prep times     | Count, average, 90th percentile and late tickets over the last 24 hours per station                                                      | station screen                          |
| Access         | New `pos.kitchen` permission and **Kitchen** role; screens limited to the user's branches                                                | `access/permissions.ts`, migration      |

Checks: `pnpm check` pass (unit 40 files / 222 tests, 3 new: routing by
item, category, default or none; warning and late thresholds; count,
average and 90th percentile); `pnpm test:integration` 42 files / 270
tests pass (4 new: one default station per branch, unique codes, routes by
category or item replacing each other, one route per category, route
removal, waiters cannot set up stations; a sent check makes one ticket per
station with label, guests, note and seat, items preparing until bumped
then ready, double bump harmless, recall, prep time counted, voided item
struck through; a counter order makes a ticket and shows preparing then
ready on the shift, its void strikes the items; no station = no ticket,
kitchen staff of another branch, cashiers and other organizations cannot
see or bump); `pnpm test:e2e` 47 tests pass (new: set up a default station,
send a check item, see it on the station's screen, bump it, recall offered,
the check shows it ready; repeated 3× without a failure).

Limitations: no "served" step or item-level bump; screens poll every few
seconds (no push); no kitchen printers yet (hardware, Q-16); prep times are
the last 24 hours, not a chosen period.

## POS2a — Floor and tables (delivered)

Rules: DECISIONS.md ADR-062.

| Area          | What works                                                                                                                         | Where                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Setup         | Floors per branch with the kitchen's stock warehouse; tables with seats and grid position (`pos.manage`)                           | `/pos/floors`                          |
| Floor plan    | Tables on their grid: free, or the open check with guests, minutes open and unsent items; checks without a table; refreshes itself | `/pos/floor`                           |
| Checks        | Open at a table (one open check per table) or by name; items with seat, course, note and hold; send; fire a course                 | `/pos/tabs/[id]`, `pos/tables.ts`      |
| Sent items    | Fixed in the database; voided with a reason (`pos.void`) and written off as "prepared, not sold" (shows with waste)                | `voidTabLine`, new write-off reason    |
| Paying        | Everything left, chosen items, one seat, or split evenly into several payments; each payment is an ordinary order with its receipt | `payTab`, `pos/rules.ts` `splitEvenly` |
| Table actions | Move to a free table, merge before paying, cancel a check nobody paid                                                              | check screen                           |
| Access        | New `pos.tables` permission and **Waiter** role; cashiers (`pos.sell`) see and pay checks but do not add items                     | `access/permissions.ts`, migration     |

Checks: `pnpm check` pass (unit 39 files / 219 tests, 3 new: what is left
to pay, when a check is settled, even split to the cent adding up exactly);
`pnpm test:integration` 41 files / 266 tests pass (7 new: floor warehouse
in its branch, duplicate table code, waiters cannot set up floors; one open
check per table, hold and fire a course, nothing to send, sent items fixed
in the service and the database; void needs `pos.void`, writes off the
stock as PREPARED_NOT_SOLD, not twice; pay a seat, then one item, then the
rest — check closes, stock used from the floor's warehouse, order linked to
check and line, retry pays nothing twice, over-payment refused, refund of a
check order; even split into three card payments; move, merge with guests
and renumbered items, named check, cancel only without sent items; other
branch and other organization see nothing, cashiers pay but cannot add
items); `pnpm test:e2e` 46 tests pass (new: set up a floor and table, seat
guests, add a drink for seat 1 and a held second course for seat 2, send,
fire the course, pay seat 1 by card, pay the rest in cash with change, the
table is free again; repeated 5× without a failure).

Found and fixed while testing: the order engine was split into pricing,
stock use and recording steps so checks reuse it (counter-sale tests
unchanged and passing); the pay panel's method field reused the refund
label — it now has its own. The new E2E test first clicked "Open check"
before the page was interactive (after a full page load from a link
clicked before hydration), which does nothing; it now waits for the page to
load, as after `page.goto`.

Limitations: checks need a connection (not queued offline); kitchen
tickets, stations and ready status are POS2b; a check shows today's price
and is priced when paid; merging is only before any payment; no drag-and-
drop floor editor (grid positions are entered).

## POS1d — Store apps (delivered as buildable projects)

Rules: DECISIONS.md ADR-061; release steps: docs/MOBILE_RELEASE.md.

| Area          | What works                                                                                                                                 | Where                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Projects      | Capacitor 8 Android and iOS projects loading the hosted web app; own package and lockfile                                                  | `mobile/`                                                    |
| Configuration | Server URL, app id and version per build; iOS app-bound domain and bundle id applied by `npm run sync`; release builds refuse placeholders | `mobile/capacitor.config.ts`, `mobile/scripts/configure.mjs` |
| Look          | Icons (incl. Android adaptive) and splash screens (light and dark) from the brand mark; offline first-launch page EN/AR                    | `mobile/assets`, `mobile/www`                                |
| Builds        | CI builds an Android debug APK (downloadable) and an unsigned iOS simulator build on every change under `mobile/`                          | `.github/workflows/mobile.yml`                               |
| In the apps   | Same pages and offline till; print buttons say where to print (in-app web views have no print dialog)                                      | `components/ui/print-button.tsx`                             |

Checks: `pnpm check` pass; `pnpm test:e2e` 45 tests pass (new: the same pages in
the app's web view, print button replaced by where to print; a normal browser
still prints); mobile workflow passed on its first run (Android debug APK built and
uploaded as an artifact; iOS simulator build on macOS succeeded). Locally: `cap add`/`cap sync`
for both platforms, configuration applied and idempotent, release guard
refuses placeholders. The Android SDK and Xcode are not available in the
development container, so the native builds are verified in CI only.

Not done (needs the organization): developer accounts, app id (Q-19),
production URL (Q-03), signing keys, store listings, review submission. Not
yet in the apps: printing (needs a printer plugin and hardware), card
terminals (POS3), push notifications, camera barcode scanning. Not tested on
physical devices.

## POS1c — Cashier app, offline (delivered)

Rules: DECISIONS.md ADR-060 (offline), ADR-057 (devices).

| Area            | What works                                                                                                                                                                        | Where                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Install         | Web app manifest (standalone, icons incl. maskable, theme colour, Apple touch icon); installs from the browser on tablet, phone, desktop                                          | `app/manifest.ts`, `public/icons`         |
| Offline loading | Service worker: build files cache-first, the till page network-first with the last copy offline; nothing else cached; cleared on sign-in page                                     | `public/sw.js`, `pos/offline-support.tsx` |
| Order queue     | Every paid order saved in IndexedDB first, sent at once, kept until the server has it; sent oldest first every 15 s, on reconnect or "Send now"                                   | `pos/queue.ts`, till status bar           |
| Sync endpoint   | `POST /o/<org>/pos/sync`: session cookie, same-origin JSON only, idempotent by order id; works across deployments                                                                 | `pos/sync/route.ts`                       |
| Pricing         | Priced with the menu the till loaded (`menuAsOf`, within the shift); later prices and withdrawals do not apply; menu refreshed every 5 minutes when idle                          | `pos/service.ts`, `pos/rules.ts`          |
| Late orders     | Orders taken before the close but sent after are kept in their shift; the Z report keeps the expected cash at close and lists them separately; register page warns before closing | `/pos/shifts/[id]`, `/pos/registers/[id]` |
| Who sends       | Only the cashier who took an order sends it; another session leaves it waiting; refused orders listed with their reason to retry or discard                                       | till                                      |

Checks: `pnpm check` pass (unit 39 files / 216 tests, 5 new: order and menu
times within the shift including late sync, refused times, things archived
after the menu time still on sale, what the device does with each sync
response); `pnpm test:integration` 40 files / 259 tests pass (2 new: priced with the menu
the till loaded despite a later price and a withdrawn item, current menu
without it, a menu from before the shift refused, someone else's order
refused, menu time in the audit; an order taken before the close recorded in
the closed shift as late with its cash, expected cash at close unchanged,
resend returns the same order, an order after the close refused, another
register's shift not found); `pnpm test:e2e` 44 tests pass (new: manifest
served; service worker controls the till; a card sale with the network off is
kept on the device; the till reloads offline with the order still waiting;
back online it is sent and appears in the shift; repeated 3× without a
failure).

Found and fixed: a POS1b test picked "any order" to check that amounts are
fixed in the database; with device-generated ids it sometimes picked a
voided one, where setting "voided" again changes nothing. It now picks a
paid order; the database rule is unchanged.

Limitations: no receipt for an order still on the device; no background
sync while the app is closed (it resumes when the till is opened); stock is
used when the order reaches the server; tax rates by date only; a device
offline when the shift is closed elsewhere keeps selling into the closed
shift and those orders are refused and listed on the till; one browser
profile per device holds its own queue (clearing site data deletes unsent
orders — the till warns via the waiting count). Store apps: POS1d.

## POS1b — Selling (delivered)

Rules: DECISIONS.md ADR-059 (selling), ADR-057 (devices), ADR-058 (menu).

| Area            | What works                                                                                                                                                                     | Where                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Registers       | Per branch, using one of its warehouses for stock; created with `pos.manage`                                                                                                   | `/pos`                                                 |
| Shifts and cash | One open shift per register, opening float, cash in / out with reason, close by counting the drawer (expected, counted, difference)                                            | `/pos/registers/[id]`                                  |
| Cashier screen  | Channel tabs, categories, item grid, options dialog (at least / at most), cart, cash with change or card; tablet, phone and browser layouts                                    | `/pos/registers/[id]/sell`, `pos/till.tsx`             |
| Orders          | Device-generated id (a retry returns the same order), server-side prices, options and VAT per line, refused if the total changed or time is outside the shift                  | `pos/service.ts` `submitOrder`, `pos/rules.ts`         |
| Stock           | Recipes per portion, products, combo components and options used FEFO from the register's warehouse; missing stock becomes a shortfall, posted later (cost added to the order) | `/pos/shortfalls`, needs attention                     |
| Voids, refunds  | Void in the open shift before any refund (stock back, including late-posted shortfalls); refunds by line and quantity, proportional VAT, from an open shift of the same branch | `/pos/orders/[id]`                                     |
| Reports         | X report while open, Z report when closed; POS sales in the food cost report (new POS orders column, CSV `pos_orders`) and the VAT summary                                     | `/pos/shifts/[id]`, `/reports/food-cost`, `/sales/vat` |
| Receipt         | 80 mm print view with VAT number and "simplified tax invoice" when registered                                                                                                  | `/pos/orders/[id]/receipt`                             |
| Access          | `pos.sell`, `pos.void`, `pos.refund`, `pos.view` (branch-scopable), `pos.manage`; new **Cashier** role; cashiers use stock without browsing it                                 | `access/permissions.ts`, migration                     |

Checks: `pnpm check` pass (unit 39 files / 211 tests, 4 new: line amounts with
and without VAT, payments must settle exactly with change only on cash,
expected cash, proportional refunds with the remainder on the last part;
build); `pnpm test:integration` 40 files / 257 tests pass (9 new: register
warehouse in its own branch, one open shift; prices, VAT, cash change, stock
and an idempotent retry; changed prices, wrong payments, unknown options, no
channel price and an order time outside the shift refused; combo components,
shortfall instead of negative stock, late posting with its cost, void returning
it; void permissions and stock back, partial refund, over-refund and void after
refund refused; shift close against counted cash; POS in the VAT summary and
food cost report; cashiers limited to their branch, other organizations see
nothing and cannot reuse an order id; amounts fixed in the database);
`pnpm test:e2e` 43 tests (new: register and shift, two items paid in cash
with change, receipt, shortfall listed, the till at phone width without
sideways scrolling, close with a Z report showing expected cash and no
difference). The first full runs had one failure each in integration and
E2E, both from the new CSV column (tests read the row by position); both
tests now expect the new column and pass.

Found and fixed: `loadWarehouse` required `inventory.view`, so a cashier could
not sell; it now takes the permission that reaches the warehouse (`pos.sell`
for the till). Changed: the branch comparison CSV has a new `pos_orders`
column, and its test now checks the new layout.

Limitations: counter service only (tabs, tables, kitchen tickets are POS2);
one payment method per order on the screen (the service accepts several);
card payments are recorded, not processed (POS3); receipts are not ZATCA/ETA
e-invoices (POS4); no offline queue or installable app yet (POS1c); base
currency only; refunds do not return food to stock.

## POS1a — Menu (delivered)

Rules: DECISIONS.md ADR-057 (devices, Q-16), ADR-058 (menu).

| Area         | What works                                                                                                        | Where                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Categories   | Names in English and Arabic, order, archive                                                                       | `/menu`                               |
| Items        | From a dish recipe or a stock product (quantity); combos of items, one level; VAT code; archive                   | `/menu/items/[id]`, `menu/service.ts` |
| Prices       | Per channel, optionally per branch, dated and append-only; branch price wins; no price = not sold on that channel | item page, `menu/rules.ts`            |
| Modifiers    | Groups with at-least / at-most; options with price change and optional stock use                                  | `/menu/modifiers`                     |
| Availability | Item not offered at a branch; `menuForBranch` for the cashier app                                                 | item page                             |

Checks: `pnpm check` pass (unit 38 files / 207 tests, 3 new: price
resolution by channel, branch and date; modifier at-least / at-most and
unknown options; price changes never below zero; build);
`pnpm test:integration` 39 files / 248 tests pass (6 new: dish or product
items, preparations and recipe-plus-product refused, unique codes, kind
fixed, database CHECK; channel, branch and dated prices, duplicate date
refused, history cannot be changed, no delivery price = not on the delivery
menu; modifier limits and stock-using options; combos of items only, one
level; withdrawn at one branch, archived everywhere; branch managers read
only, warehouse staff no access, other organizations see nothing);
`pnpm test:e2e` 42 tests pass (new: category, item from a product, dine-in
and takeaway prices, modifier group attached, branch availability toggled).

Found and fixed: the attachment purge test expected "nothing purged" on a
file's last retention day, but the job runs for all organizations and the
test database had older files from earlier runs; the test now checks that
this file is kept that day and purged the next.

Limitations: no images, time-based menus or
happy-hour prices; store apps wait for developer accounts (ADR-057).

## Open items closed before POS (delivered)

Rules: DECISIONS.md ADR-052 – ADR-056.

| Area                  | What works                                                                                                                 | Where                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Exchange revaluation  | Open foreign supplier and customer balances at a closing rate; stored, fixed, cancellable; journal entry reversed next day | Payables → Exchange revaluation, `revaluation.ts` |
| Landed costs          | Entered in any document currency, converted at the day's rate, base allocated to stock                                     | receipt page, `landed-costs.ts`                   |
| B2B in currencies     | Customer currency; orders, invoices (rate, base totals, margin in base), receipts (rate, realised difference) per currency | `b2b/service.ts`, `b2b/receivables.ts`            |
| B2B accounting export | Documents CSV with currency/rate/base and cost; balanced base journal with exchange and revaluation lines                  | B2B → Customer balances, `b2b/accounting.ts`      |
| Virus scanning        | ClamAV `INSTREAM` when `CLAMAV_URL` is set; infected or unscannable uploads refused; files labelled checked / not checked  | `attachments/scanner.ts`, docker-compose `clamav` |

Checks: `pnpm check` pass (unit 37 files / 204 tests; new: revaluation
rule, clamd INSTREAM framing, clean/infected replies, unreachable scanner;
build); `pnpm test:integration` 38 files / 242 tests pass (new: payables
revaluation 60 USD booked 2,910 → 3,000 EGP = 90 loss, once per date,
fixed, cancel and re-post, journal entry and next-day reversal; USD
freight 10 × 49 = 490 EGP added to stock; USD customer invoice at 48.5 =
388 EGP with margin 268, output VAT in base, EGP receipt cannot settle it,
USD receipt at 50 records a 12 EGP gain; customer revaluation +12; B2B
documents export and balanced journal; virus scanning against a **real
ClamAV 1.x daemon** — clean file stored as checked, EICAR refused with
nothing stored and the attempt audited, unreachable scanner refuses the
upload); `pnpm test:e2e` 41 tests pass (new: rates pasted as CSV, USD
invoice, revaluation previewed and posted). An existing E2E test found two
"Bank …" fields after the new receipts account was added; the new label
was renamed instead of changing the test.

Note: the real-daemon run used a local EICAR signature, because this
environment blocks the official signature download; CI uses a protocol
stand-in unless `CLAMAV_TEST_URL` is set.

Limitations: no live rate feed; attachments still stored in PostgreSQL
(object storage waits for the hosting decision, Q-03); stock and cost of
goods are not journaled (periodic approach, ADR-039).

## Attachments (delivered)

Rules: DECISIONS.md ADR-051 (Q-08).

| Area      | What works                                                                                                  | Where                                    |
| --------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Files     | PDF/JPEG/PNG/WebP up to 3 MB on orders, receipts, supplier invoices, payments/credit notes and stock counts | attachments card on those pages          |
| Access    | View/download by who may see the document; add by who may work on it; download-only with safe headers       | `attachments/service.ts`, download route |
| Retention | Kept 3 years; uploader may remove a mistaken file within an hour; daily purge keeps the record              | `pnpm attachments:purge`                 |

Checks: `pnpm check` pass (unit 36 files / 201 tests, 3 new: type from
content, safe names, 3-year date incl. 29 February, removal window;
build); `pnpm test:integration` 35 files / 230 tests pass (6 new: stored
and returned byte for byte with hash and retention date; exactly 3 MB
accepted, 3 MB + 1 and HTML-as-PDF refused; view-only and other-warehouse
users, other tenants; counter attaches to a count; only the uploader within
an hour may remove; database refuses edits and size mismatches; purge after
retention keeps the record); `pnpm test:e2e` 40 tests pass (new: attach and
download a PDF on an order, wrong type refused with the reason on the
field, 2.5 MB accepted, over 3 MB refused).

Found and fixed: the upload form showed only "Please correct the
highlighted fields" for a refused file type, because the rule is reported
on the file field; it now shows the reason under the field (caught by the
new E2E test).

Limitations: no virus scanning or previews; stored in PostgreSQL until a
hosting decision; the one-hour removal window is an assumption to confirm.

## Foreign-currency purchasing and exchange rates (delivered)

Rules: DECISIONS.md ADR-050 (Q-05, Q-11).

| Area       | What works                                                                                                                        | Where                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Rates      | Enter or paste (CSV) rates per currency and date; latest per currency; history; at most 7 days old when used                      | Purchasing → Exchange rates, `fx/` |
| Documents  | Supplier default currency; orders, receipts, invoices, payments and credit notes in USD, EUR, SAR, EGP or a GCC currency          | procurement, invoices modules      |
| Base value | Approval on base total; stock valued at price × rate; invoice and payment base amounts fixed; realised exchange difference stored | `rateFor`, `realisedDifference`    |
| Reports    | Balances per supplier and currency with base equivalent and base totals; statements per currency; VAT and exports in base         | payables, VAT summary, export      |

Checks: `pnpm check` pass (unit 35 files / 198 tests, 4 new: rate choice
incl. 7-day limit, conversions and rounding, realised differences,
allowed currencies; build); `pnpm test:integration` 34 files / 224 tests
pass (6 new: rates kept per date, all-or-nothing CSV, permission and tenant;
GBP refused; no rate and stale rate refused; USD order approved by its
1,225 EGP base total; receipt valued 1,225 EGP; USD invoice at the
invoice-date rate 48.5 = 1,212.50 EGP; EGP invoice refuses a USD receipt;
VAT summary in base; balance per currency with base equivalent; USD
payment at 49 refuses an EGP invoice and records a 12.50 loss; documents
export with currency, rate and base; journal needs the exchange account and
balances in EGP with the difference lines); `pnpm test:e2e` 39 tests pass
(new: rate entered, USD supplier, order with rate and base total, receipt,
stock value 1,225 EGP). All earlier tests pass unchanged: base-currency
documents behave as before (rate 1).

Limitations: no period-end revaluation of open foreign balances; landed
costs and B2B sales stay in base currency; no live rate feed (none is
connected or claimed).

## Approval matrix — per-layer limits, purchase orders and stock counts (delivered)

Rules: DECISIONS.md ADR-049 (Q-04 refined, Q-12).

| Area     | What works                                                                                                                             | Where                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Settings | Up to 3 branch layers + head office, each "required above" its own amount, separately for orders (total) and counts (difference value) | Settings → Approvals, `approvals/service` |
| Orders   | Chain from the layers the total exceeds; nothing applies = approved on submit                                                          | `submitOrder`, `approvals/rules.ts`       |
| Counts   | Difference value at submission; chain as for orders; counter never approves; send back to recount; last step posts                     | `inventory/counts.ts`                     |
| Screens  | Steps with who/when on orders and counts; reason when you cannot sign; needs-attention per level                                       | `components/approvals/steps.tsx`          |

Checks: `pnpm check` pass (unit 34 files / 194 tests; the approval
rules moved to `approvals/rules.test.ts` with per-layer limits); `pnpm
test:integration` 33 files / 218 tests pass (new: limits per layer give
1, 1, 2 and 3 steps for totals 100, 500, 600 and 3,000; invalid limits and
non-admins refused; count difference value 10 → branch + head office,
counter and head office refused at the branch step, nothing posted before
the last step, sent back, recounted to 5 → one step, posted; unknown cost →
all layers with distinct people; no difference → no approval; database
refuses the counter's approval); `pnpm test:e2e` 38 tests pass (approval
chain now set on Settings → Approvals).

Changed behaviour: the single approval limit and the "branch steps / head
office" settings are replaced by the matrix; existing settings were
converted by the migration (the old limit on each layer).

Limitations: no delegation; requisitions have no approval of their own.

## Q-04 — Multi-level purchase approval (delivered)

Rules: DECISIONS.md ADR-049.

| Area      | What works                                                                                                                             | Where                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Settings  | Branch approvals 0–3 (default 2) and head office yes/no (default yes), applied above the approval limit                                | Settings → Purchasing                     |
| Chain     | Fixed at submission; branch steps by branch- or warehouse-scoped approvers, last step organization-wide; different person each step    | `approveOrder`, `procurement/rules.ts`    |
| Rejection | By anyone who may sign the current step; back to draft; resubmission starts a new round; history kept                                  | `rejectOrder`, `purchase_order_approvals` |
| Screens   | Steps with who/when on the order; button only for whoever may sign the current step, otherwise the reason; "needs attention" per level | order page, `analytics/attention.ts`      |

Checks: `pnpm check` pass (unit 33 files / 194 tests, 2 new: chain from
settings, who may sign each level; build); `pnpm test:integration` 32 files
/ 215 tests pass (1 new and 2 updated: three-step chain with branch,
warehouse and organization approvers, head office and other branches
refused at branch steps, author and second signature refused, rejection
at head office restarts the chain, history of both rounds, database
refuses an approval by the author; the single-approver test now sets that
mode explicitly; "needs attention" shows the order to the branch approver
first, then to head office); `pnpm test:e2e` 38 tests pass (new: limit 0,
default chain shown in settings, owner orders, two invited branch
managers sign, head office cannot sign a branch step, finance approves
last, steps list all three).

Found and fixed: cancelling an order waiting for approval left its pending
step set, which the new database check refused; cancel now clears it.

Limitations: one chain per organization (no amount bands), no delegation,
requisitions have no approval of their own. Organizations that had set an
approval limit now get the default chain on their next submissions; set
branch approvals to 0 and head office to "not required" for the old
single-approver rule.

## M10a — Integration framework (delivered)

Rules: DECISIONS.md ADR-048; guide: docs/INTEGRATIONS.md.

| Area       | What works                                                                                                                           | Where                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Connectors | Create (owner/admin), secret shown once and stored encrypted, rotate, enable/disable; request log and delivery list per connector    | `/settings/integrations`, `integrations/service` |
| Inbound    | `POST /api/integrations/inbound/<id>`: HMAC + 5-minute window, Idempotency-Key, rate limit; sales import as the creator; 4xx reasons | route handler, `handleInboundSales`              |
| Outbound   | `purchase_order.approved`, `goods_receipt.posted`, `sales_invoice.issued` queued in the same transaction; signed POST; 5 retries     | `emitEvent`, `pnpm integrations:deliver`         |
| Safety     | https only, private addresses refused on save and at connect time (DNS rebinding), no redirects, ids and totals only in payloads     | `integrations/http.ts`, `crypto.ts`              |

Checks: `pnpm check` pass (unit 33 files / 192 tests, 6 new: encryption,
signatures, retry schedule, URL rules; connect-time address guard and no
redirects against a local server; build); `pnpm test:integration` 32 files /
214 tests pass (11 new: secret stored only encrypted and absent from lists
and audit; validation and refused addresses; owner/admin only, other
tenants see nothing; inbound unknown id, wrong/stale/missing signature,
missing key and bad body all refused and logged with no stock change;
signed sales imported once, repeated key returns the first result; import
errors 422; disabled connector 403; rotated secret replaces the old; removed
creator 403; PO approval queues a signed event delivered to a local
receiver and verified; six attempts with backoff then FAILED, manual retry
delivers; goods receipt event; nothing queued when disabled);
`pnpm test:e2e` 37 tests pass (new: create inbound connector, secret shown
once, signed request imports sales, bad signature 401, repeat flagged
duplicate, request log, stock 10 → 7).

Found and fixed: the first version checked the outbound address before
sending but let the HTTP client resolve DNS again, and a pooled keep-alive
socket skipped even the connect-time check; the new unit test caught the
second. Now checked on the dialled IP with no connection reuse. My own
encryption unit test was flaky (its "tampering" sometimes changed nothing);
it now always flips a real byte.

Limitations: no named third-party connector (POS brands, Xero, WhatsApp,
OCR) — none is claimed until tested against its sandbox; inbound accepts
our format only; the worker is a separate process you schedule; no payload
versioning yet.

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
