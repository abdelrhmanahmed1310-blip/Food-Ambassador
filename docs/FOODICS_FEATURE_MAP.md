# Foodics capability map and gap analysis

Last updated: 2026-10-29

This document lists the capabilities that Foodics (foodics.com, a restaurant
point-of-sale and management platform used widely in Saudi Arabia, the UAE
and Egypt) describes publicly. Each one is mapped against Food Ambassador.
The descriptions are our own summaries of Foodics marketing pages, help-centre
article titles, changelog entries and partner listings. No Foodics text,
branding or UI is reused. We have not used the product, and step-by-step
behaviour inside help articles was not verified.

Status legend: ✅ have · 🟡 partial · ⬜ planned (in an existing milestone) ·
🆕 not in the plan · ⛔ outside the product's scope unless a decision changes
it (Q-14).

## The key difference

Foodics is mainly **front of house**: a cashier app on in-store devices,
ordering channels, payments and the back office behind them. Food Ambassador
is **back office**: suppliers, stock, recipes, food safety, traceability and
cost. Supy, for example, connects to Foodics rather than replacing it.

So "all Foodics functionality" splits into two groups:

1. **Back-office features** (inventory, purchasing, production, costing,
   reports). These fit Food Ambassador and are mostly already planned.
2. **Point-of-sale and ordering features** (cashier, payments, kitchen
   screen, online ordering, loyalty, gift cards, tax e-invoicing). Building
   these means building a POS: offline-capable device apps, card payment
   hardware and certification, and ZATCA Phase 2 e-invoicing compliance in
   Saudi Arabia. That is a different product with its own regulatory risk,
   so it needs an explicit decision (Q-14) before it enters the plan.

## 1. Back office — inventory and purchasing

| Capability                                                               | Food Ambassador                                                 | Status | Milestone |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- | ------ | --------- |
| Inventory items, units, suppliers per item                               | Products, units, conversions, barcodes; suppliers planned       | 🟡     | M2 / M3   |
| Purchase orders: draft → submit for review → approve / reject            | Planned with approval rules (Q-04)                              | ⬜     | M3        |
| Import items into a purchase order                                       | Not explicit; CSV import exists for products and opening stock  | 🆕     | M3        |
| Receiving purchases, returns to supplier                                 | Receiving planned; supplier returns not explicit                | 🟡     | M3        |
| Transfer orders (request) and transfer send / receive                    | Immediate transfers only; request + in-transit planned          | 🟡     | M3        |
| Inventory count and quick spot checks                                    | Full counts with blind counting; no "spot check" of a few items | 🟡     | M3        |
| Quantity adjustments with reasons                                        | Adjustments and write-offs with reasons                         | ✅     | M2        |
| Production (turn ingredients into a prepared item)                       | Not in the plan (proposed M9, central kitchen)                  | 🆕     | M9        |
| Link menu ingredients to inventory items (consumption on sale)           | Planned: recipe-based consumption from sales                    | ⬜     | M4 / M7   |
| Costing methods (e.g. average, fixed cost)                               | Waiting on Q-01                                                 | ⬜     | M3        |
| Inventory reports: counts, purchases, suppliers, transfers, cost control | Inventory dashboard exists; these reports planned               | 🟡     | M8        |

## 2. Back office — menu

| Capability                                                    | Food Ambassador                                                 | Status | Milestone |
| ------------------------------------------------------------- | --------------------------------------------------------------- | ------ | --------- |
| Menu builder: categories, products, modifiers, combos, groups | Recipes are planned; a sellable menu (modifiers, combos) is not | 🆕     | M4 / M7   |
| Price tags (different prices per branch or channel)           | Not in the plan                                                 | 🆕     | M7        |
| Allergens on menu items                                       | Planned, with explicit "unknown" and approval                   | ⬜     | M5        |
| Timed events (time-based prices or availability)              | Not in the plan                                                 | ⛔     | Q-14      |
| Menu groups per device                                        | POS-only                                                        | ⛔     | Q-14      |

## 3. Back office — organization, finance and reporting

| Capability                                          | Food Ambassador                                              | Status | Milestone |
| --------------------------------------------------- | ------------------------------------------------------------ | ------ | --------- |
| Branches, users, roles and permission-gated screens | Branches, warehouses, roles, scoped permissions              | ✅     | M1        |
| Arabic and English                                  | Full RTL Arabic                                              | ✅     | M1        |
| Accounting (purchases, supplier payments)           | Supplier invoices, settlements and accounting export planned | ⬜     | M7        |
| Sales reports, branch comparison, BI dashboards     | Planned with real figures only                               | ⬜     | M8        |
| AI assistant over the data                          | Not in the plan                                              | 🆕     | backlog   |
| App marketplace / public API for partners           | Not in the plan (proposed M10, integrations)                 | 🆕     | M10       |
| Delivery-platform order intake (via aggregators)    | Not in the plan                                              | ⛔     | Q-14      |

## 4. Front of house (point of sale)

None of these exist, and none are in the plan. All are ⛔ pending Q-14.

| Capability                                                | What building it would involve                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Cashier app (orders, tables/seating, split bills, shifts) | Device app that keeps working offline and syncs later; printer and cash-drawer support |
| Waiter app, pay at table, self-ordering kiosk             | More device clients on the same order engine                                           |
| Kitchen display screen                                    | Live order routing to kitchen stations                                                 |
| Payments (cards, wallets, terminals)                      | Payment provider and terminals, PCI DSS scope, settlement reconciliation               |
| Online ordering website / app                             | Customer-facing storefront, delivery zones, online payment                             |
| Customers, loyalty points, coupons, promotions, discounts | Customer data (privacy obligations), promotion rules engine                            |
| Gift cards                                                | Stored-value liability accounting                                                      |
| ZATCA Phase 2 e-invoicing (Saudi Arabia)                  | Signed XML invoices, cryptographic stamps, QR codes, device onboarding with ZATCA      |
| All-in-one handheld device                                | Hardware partnership                                                                   |

## Options for Q-14

> **Decided 2026-10-29: option C — full point of sale in scope** (DECISIONS.md
> ADR-022). The POS is planned as milestones POS1–POS5 after M4 (recipes),
> because every sale consumes stock through its recipe. The comparison below
> is kept for the record.

| Option                                               | What it means                                                                                                                                                                                                                                    | Effect on plan                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **A. Back office that works with POS** (recommended) | Build every back-office feature above, plus a sellable menu (modifiers, combos, price per branch/channel) that maps to recipes. Take sales from Foodics and other POS systems through tested connectors (M10), and from file imports until then. | Adds menu + price tags to M4/M7; Foodics connector first in M10                                 |
| B. Add a POS later                                   | Option A now. Design the sales and menu model so a POS can be built on it after the pilot.                                                                                                                                                       | Same as A, plus a future milestone                                                              |
| C. Full POS now                                      | Build the front-of-house list in section 4.                                                                                                                                                                                                      | Several new milestones before the pilot, payment and ZATCA certification work, much larger risk |

Recommendation: **A**. It delivers the back-office value soonest, lets
customers keep the POS they already have, and avoids payment and e-invoicing
certification before there is a pilot.

## Proposed additions if A or B is chosen

| Item                                                          | Milestone |
| ------------------------------------------------------------- | --------- |
| Import items into purchase orders (CSV)                       | M3        |
| Returns to supplier                                           | M3        |
| Spot checks (count a few items without a full count)          | M3        |
| Sellable menu: categories, items, modifiers, combos → recipes | M4        |
| Price per branch / channel                                    | M7        |
| Foodics sales connector (first POS connector)                 | M10       |

## Sources

- [Foodics — all-in-one POS](https://www.foodics.com/rms-pos/)
- [Deliverect — Foodics integration](https://www.deliverect.com/en/integrations/foodics)
- [Foodics loyalty](https://www.foodics.com/foodics-loyalty)
- [Foodics help centre — inventory](https://help.foodics.com/hc/en-us/categories/4404592488466-Inventory)
- [Foodics help centre — inventory management master guide](https://help.foodics.com/hc/en-us/articles/14275405575452-Master-Guide-on-Inventory-Management)
- [Foodics help centre — inventory dashboards in BI](https://help.foodics.com/hc/en-us/articles/22114426480668-What-are-the-Inventory-Dashboards-in-Foodics-BI)
- [Foodics knowledge base — purchase and transfer orders](https://foodics.helpjuice.com/96013-purchase-orders-transfer-orders)
- [Foodics help centre — menu](https://help.foodics.com/hc/en-us/categories/4404592453266-Menu)
- [Foodics changelog — menu section](https://changelog.foodics.com/discover-the-enhanced-menu-section-on-the-console-4G1Eyc)
- [Foodics changelog — inventory](https://changelog.foodics.com/label/62416)
- [Foodics — ZATCA e-invoicing phase 2](https://www.foodics.com/zatca-e-invoicing-2nd-phase/)
- [Foodics help centre — accounting](https://help.foodics.com/hc/en-us/sections/12328492668060-Foodics-Accounting-Basic-Functions-Features)
