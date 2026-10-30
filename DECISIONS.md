# Food Ambassador — Decisions and Assumptions

Status values: **Accepted** (in effect), **Proposed** (default we will use
unless the product owner says otherwise), **Open** (needs an answer before the
milestone listed).

---

## Architecture decision records

### ADR-001 Modular monolith — Accepted (M0)

One Next.js app + one PostgreSQL database, organized by business domain with
enforced module boundaries (ARCHITECTURE.md §2). Rationale: strong
transactional consistency across inventory, procurement and finance is far
easier in one database; team size and load do not justify distributed systems.
Revisit if a module needs independent scaling or deployment.

### ADR-002 Stack and versions — Accepted (M0)

Node 22, pnpm 10, Next.js 16.4 (App Router, TypeScript strict), React 19.3,
Tailwind CSS 4, PostgreSQL 16, Prisma ORM **7.10** with `@prisma/adapter-pg`,
Zod 4, decimal.js, Vitest 5, Playwright 1.63. Exact versions are pinned in
`package.json` and the lockfile.

- Prisma 8 exists only as release candidates at the time of writing, so the
  latest stable major (7) was chosen. Upgrade when 8 is GA.
- Playwright is pinned to the version of the browsers available in the
  development/CI image.

### ADR-003 Decimal-only numerics — Accepted (M0)

`NUMERIC` columns and `decimal.js` for quantities, costs and money; JS numbers
are rejected for non-integers (`toDecimal`). Scales in DATA_MODEL.md §1.4.
Rounding: half-up, once, at persistence boundaries.

### ADR-004 Next.js Cache Components disabled — Accepted (M0)

The scaffold enabled `cacheComponents` and `partialPrefetching`. Both were
turned off: almost every page is per-tenant/per-user, and a mis-keyed shared
cache entry would be a cross-tenant leak. Dynamic rendering per request is the
safe default. Re-enable only with a documented caching policy and tests.

### ADR-005 Inventory as an append-only ledger with a locked projection — Accepted (M0 design, implemented M2)

Stock is never edited; it is the sum of immutable ledger entries. A
`stock_balances` projection is updated in the same transaction under row locks,
with CHECK constraints preventing negative stock and a deterministic
`posting_key` unique constraint preventing double posting. Corrections are
reversals/adjustments. Full rules in DATA_MODEL.md §4.

### ADR-006 Tenant isolation layers — Accepted (implemented M1)

1. **Application layer**: a `TenantContext` (resolved server-side from the
   session + an `ACTIVE` membership in the org named by the URL slug) is
   required by every service; every query filters by `organizationId`; lookups
   by ID that miss — including other tenants' IDs — return `NOT_FOUND`.
2. **Composite foreign keys** `(organization_id, x_id)` make cross-tenant
   references impossible even for code that bypasses RLS.
3. **PostgreSQL row-level security**: `withTenantTx` sets
   `app.organization_id` and `SET LOCAL ROLE fa_tenant` for the transaction;
   policies on all tenant tables restrict reads and writes to that org, and
   `fa_tenant` has no access to credentials/sessions. The M1 spike worked
   cleanly (one extra round-trip per transaction), so it was adopted.
   System operations (sign-up, invitation acceptance, membership lookup) use
   `withSystemTx` explicitly and filter by the authenticated user.

### ADR-007 Authentication library — Accepted (M1)

**Better Auth 1.7** for email/password sign-in, scrypt password hashing,
database sessions (7-day expiry, refreshed daily) in httpOnly cookies, and
rate limiting. Only its authentication features are used; organizations,
memberships and RBAC are our own tables. Sign-in/sign-up run as server actions
that call `auth.api` directly and apply the same rate limits as the HTTP
endpoints.

### ADR-008 Background jobs — Proposed (decide when first needed)

PostgreSQL-backed job table + worker process from the same codebase before
introducing Redis/queues.

### ADR-009 Identifiers — Accepted (M0 design)

UUIDv7 primary keys; per-org human-readable document numbers.

### ADR-010 Tenant addressing in URLs — Accepted (M1)

Path-based: `/o/{orgSlug}/...`. The slug only selects the organization; access
is granted by membership lookup on the server.

### ADR-011 Locale handling — Accepted (M1)

`next-intl` without locale routing. Locale = `fa_locale` cookie (set at
sign-in from the user profile and by the language switcher, which also saves
it to the profile), else the browser's Accept-Language, else English.
`<html lang dir>` follows the locale; layouts use logical CSS properties;
Latin values (codes, emails) are wrapped in `.ltr-value` inside Arabic text.

### ADR-012 Invitations by link, no email yet — Accepted (M1)

No email provider is configured, so an invitation produces a single-use link
(256-bit token, stored only as a SHA-256 hash, 7-day expiry) shown once to the
inviter to share. The accepting account's email must match the invitation.
Email delivery is Q-10.

### ADR-013 Database roles — Accepted (M1)

The app connects with one role that owns the schema and runs migrations
(`DATABASE_URL`). The first migration creates the NOLOGIN role `fa_tenant`
and grants it to the migrating role, which is what allows `SET LOCAL ROLE`.
Therefore **the role that runs migrations must be the role the app connects
with** (or be granted `fa_tenant` manually). The migrating role needs
`CREATEROLE` the first time (managed PostgreSQL services allow this).

### ADR-014 Client IP for rate limiting — Accepted (M1)

`X-Forwarded-For` is client-controlled except for entries appended by your
own proxies. `proxy.ts` takes the entry `TRUSTED_PROXY_HOPS` from the end,
overwrites the internal `x-client-ip` header with it, and both the auth
actions and Better Auth read only that header. Set `TRUSTED_PROXY_HOPS=0`
when the app is exposed directly (all clients then share one bucket — safe
but strict).

### ADR-015 Next.js server actions for UI mutations — Accepted (M1)

Forms post to server actions (CSRF-protected by Next's Origin check). Every
action re-resolves the TenantContext from the session and the URL slug —
never from hidden form fields — then calls the same service functions the
future `/api/v1` handlers will use. Creation forms send an idempotency key
generated per logical submission (reused on retry, discarded on success).

### ADR-016 Immediate transfers, no in-transit stage — Accepted (M2; extended by ADR-026)

Transfers post TRANSFER_OUT and TRANSFER_IN in one transaction. This fits
transfers within a site and short same-day moves. Inter-branch transfers with
a dispatch/receive gap (stock "on the truck") need a transit stage — a
per-organization transit warehouse (A-08) with DISPATCHED → RECEIVED
documents — planned with M3 receiving. Until then, stock is never "lost"
between sites, but a transfer is assumed to arrive when posted.

### ADR-017 Stock count method — Accepted (M2)

Counts cover AVAILABLE stock. The system quantity is captured per line at the
moment it is counted and the adjustment is counted − that quantity, so
movements during a multi-hour count neither get lost nor double-counted, and
the warehouse need not be frozen. The UI shows the system quantity only after
a line is counted (blind count). Posting requires `inventory.count.approve`;
separation of counter and approver is supported by permissions but not
enforced as a rule.

### ADR-018 Permissions added by data migrations — Accepted (M2)

New permissions reach existing organizations through SQL data migrations,
while new organizations get them from `SYSTEM_ROLE_TEMPLATES`. A unit test
(`permission-migrations.test.ts`) fails if the two disagree. Customized
system roles keep their customizations; migrations only add.

### ADR-019 Monotonic UUIDv7 — Accepted (M2)

`uuidv7()` uses RFC 9562's 12-bit counter so IDs created in one process are
strictly increasing even within a millisecond. Document lines are ordered by
ID; random sub-millisecond ordering previously made a transfer's OUT/IN lines
appear in random order (caught by an intermittent test failure).

### ADR-020 Translation keys in validation — Accepted (M2)

All validation and business-rule errors (including decimal parsing and CSV
row errors) carry translation keys, never English sentences, so every message
is localized. Messages may use values from the error details (e.g.
`{available}` for INSUFFICIENT_STOCK).

### ADR-021 Moving weighted average valuation — Accepted (M3, decides Q-01)

Stock is valued at a moving weighted average cost per product × warehouse,
in the organization's base currency. Every ledger entry stores its unit cost
and signed value change, so any stock value can be traced to the movements
that produced it.

- **Inbound** movements add value at their own unit cost (receipt price,
  opening balance cost). A movement with no cost of its own (count gain,
  adjustment without a cost) uses the current average. If no average has
  ever been known it adds quantity at zero value, and the product is flagged
  _cost missing_ until it is revalued. Costs are never guessed.
- **Outbound** movements (consumption, write-off, transfer out, negative
  adjustments) leave at the current average. Reversals of inbound movements
  remove the value they added (ADR-024).
  The last unit out takes the exact remaining value, so value never goes
  negative and is zero whenever quantity is zero.
- **Reversals of outbound movements** put stock back at the cost it left with.
- **Transfers** carry the source average to the destination warehouse.
  Location and status changes inside one warehouse do not change value.
- **Revaluation** sets a new average for the stock on hand through its own
  document (permission `inventory.valuation.revalue`), so value changes are
  never direct edits.
- The average is kept after stock reaches zero and is used for the next
  movement that has no cost of its own.
- Each lot's receipt cost stays on its ledger entries for reference;
  FIFO / specific-lot costing is not offered.

### ADR-022 Full point of sale in scope — Accepted (decides Q-14)

Food Ambassador will include its own point of sale and customer channels
(cashier, tables, waiter app, kitchen display, payments, tax e-invoicing,
online ordering, loyalty, promotions, gift cards), not only a back office
fed by another POS. The work is planned as milestones POS1–POS5 after M4
(PROJECT_PLAN.md) because sales consume stock through recipes.

Constraints that follow from this decision:

- Selling in Saudi Arabia requires ZATCA Phase 2 e-invoicing, and Egypt
  has its own e-receipt system. The POS must not be used for live sales in a
  market until that market's e-invoicing work (POS4) is done and tested.
- Card payments run through a certified payment provider and terminals
  (Q-15). Food Ambassador never stores card numbers, so its own PCI scope
  stays minimal.
- The cashier must keep taking orders through short network outages
  (offline queue with idempotent sync), which is why it is a separate
  client on the same order engine.
- POS connectors for other systems (e.g. Foodics) remain possible later
  (M10) but are no longer the main way sales arrive.

### ADR-023 Purchasing and receiving rules — Accepted (M3b; defaults for Q-04, Q-05, Q-09)

- **Approval (Q-04 default):** one optional approval limit per organization.
  No limit (the default) means submitting approves the order. With a limit,
  orders above it wait for approval by someone with `purchasing.approve` who
  neither created nor submitted the order. Multi-level approval is not
  built; it can be added when a customer needs it.
- **Over-receipt (Q-09 default):** 0 %. Each organization can set a
  tolerance; accepted quantity per line may never exceed ordered ×
  (1 + tolerance).
- **Currency (Q-05 default):** orders are in the base currency only.
- **Rejected goods never enter stock.** A receipt line records received =
  accepted + rejected, with a reason for any rejection. Only accepted
  quantity is posted (AVAILABLE, or QUARANTINE when flagged for
  inspection). Goods rejected later go through quarantine → reject as before.
- **Receipts post when created** (no draft) at the price charged, which may
  differ from the order price; the difference is kept for supplier
  performance. Expired or recall-held lots cannot be accepted.
- **Temperature is required** when accepting chilled or frozen products
  (standard receiving check); the value is recorded, but no limits are
  enforced because acceptable ranges depend on the product and market (Q-02).
- **Receipt reversal** happens only from purchasing (`purchasing.manage`):
  it reverses the stock document and reduces the order's received
  quantities in one transaction. It is refused once the stock has been
  used, or when the order is closed or cancelled.
- **Concurrency:** every order change and every receipt locks the order
  row, so parallel receipts cannot over-receive.
- **Supplier performance** is computed only from posted receipts; a rate is
  shown as "not enough data" rather than 0 % or 100 % when nothing can be
  measured.
- Lots stay unique per (organization, product, lot code); the supplier is
  known from the receipt line. Adding the supplier to the lot key is
  deferred until a customer receives the same lot code from two suppliers.

### ADR-024 Reversing an inbound entry removes the value it added — Accepted (M3b, amends ADR-021)

ADR-021 took reversed inbound stock out at the current average. That leaves
the value of a wrong-price receipt behind: reversing 10 units received at
100 into stock of 10 units at 10 removed 550 instead of 1,000. From M3b a
reversal of an inbound entry removes exactly the value that entry added,
capped at the value on hand; if the cap is reached while units remain, they
are left at zero value and flagged cost missing. Outbound reversals and
paired documents (transfers, status changes) are unchanged. History
replayed by the M3a migration keeps the earlier rule (it only affected
development and test data).

### ADR-025 Categories and reorder levels — Accepted (M3c; default for Q-13)

- **Categories (Q-13 default):** one flat list per organization, optional
  on each product. Archived categories cannot be newly assigned; products
  keep theirs. A hierarchy can be added later without changing products.
- **Reorder levels** are set per product × warehouse as minimum and maximum
  in the product's base unit (entered in any convertible unit).
- **Suggestion:** when usable stock (AVAILABLE, not expired, not on recall
  hold, minus reservations) plus stock still to arrive on open orders
  (draft, awaiting approval, approved, partly received) is at or below the
  minimum, order up to the maximum, rounded up to whole purchase units and
  at least the supplier's minimum order.
- **Supplier:** the preferred supplier of the product, or the only one;
  otherwise the buyer chooses. Draft orders are created one per supplier at
  the supplier's last known price. Lines without a supplier or a known price
  are skipped and listed, never priced by guess. Suggestions are always
  recomputed on the server when orders are created.

### ADR-026 Shipments with an in-transit stage — Accepted (M3c, extends ADR-016)

Immediate transfers stay for moves within a site. Moves with a gap between
leaving and arriving use **shipments** (`SHP-` numbers):

- **Draft** at the source: lines pick a specific stock line (product, lot,
  location) and a quantity in any convertible unit. Only users with
  `inventory.transfer` at the source can edit, dispatch or cancel; the
  destination can be any active warehouse of the organization.
- **Dispatch** (`DSP-` document) moves the quantity from AVAILABLE to a new
  `IN_TRANSIT` status **at the source warehouse**. Value stays with the
  source (no new transit warehouse — this replaces assumption A-08), so the
  stock-value report always shows stock on the truck where it left from.
  Expired or recall-held lots cannot be dispatched.
- **Receive** (`TRR-` document) needs `inventory.transfer` at the
  destination. Every line is answered with the received quantity: received
  stock goes from IN_TRANSIT at the source to AVAILABLE at the destination
  carrying its value; any shortage is written off from IN_TRANSIT with a
  required reason (damaged, lost, short-shipped, other). Receiving more than
  was dispatched is refused.
- **Cancel**: a draft is just cancelled; a shipment in transit is recalled
  with a document that returns the stock to AVAILABLE at the source.
- Shipment documents cannot be reversed from the documents screen; the
  shipment's own actions are the only way to change them. IN_TRANSIT stock
  cannot be adjusted, written off, transferred or status-changed by hand.
- Shipments are visible to users who see stock at either end.

### ADR-027 Organization-wide read of master data — Accepted (M3c)

`catalog.view` and `suppliers.view` granted by a branch- or warehouse-scoped
role apply to the whole organization. Products, units and suppliers are
shared master data, not stock; without this, a branch storekeeper could not
post anything, because postings must read the product. Stock, costs and
documents stay scoped. Found by a scoped-user integration test.

### ADR-028 Landed cost — Accepted (M3c, extends ADR-021)

- A **landed cost** is a charge (freight, customs duty, insurance, handling,
  other) in the base currency added to one posted goods receipt that put
  stock in. Each charge is its own `LCA-` document; several can be added.
- **Allocation** over the receipt's accepted lines: by **line value** at the
  charged price (default), or by **quantity** when all those lines share one
  base unit. Shares are rounded to money scale and always add up to the
  amount exactly (largest remainder).
- **Valuation (moving average, ADR-021):** the share of a line is added to
  the product × warehouse value only for units still on hand —
  min(on hand, received) ÷ received of it. The rest relates to stock already
  used and is recorded as **expensed** (for finance in M7), never spread over
  other stock. Quantity never changes; the average is recomputed (kept as
  is while costs are missing). This is an approximation: average costing
  does not track which units are from which receipt.
- Needs `inventory.valuation.revalue` at the receipt's warehouse.
  Append-only; a landed cost cannot be reversed (correct it with a
  revaluation), and a receipt with landed costs can no longer be reversed.
- Not yet: charges in a foreign currency (Q-05), allocation by weight or
  volume (needs product weights), one charge over several receipts, and
  linking the charge to a carrier's invoice (M7).

### ADR-029 Purchase requisitions — Accepted (M3c)

- A **requisition** (`REQ-` number) asks for goods for one warehouse, with
  lines (product, quantity in any convertible unit, note), an optional
  needed-by date and a note. One line per product.
- New permission **`purchasing.request`** (scopable), granted by data
  migration to Administrator, Operations Manager, Procurement, Warehouse and
  Branch Manager. Requesters edit drafts, submit, and cancel while nothing
  is ordered. Requisitions are visible with `purchasing.view` or
  `purchasing.request` at the warehouse.
- Statuses: DRAFT → SUBMITTED → PARTIALLY_ORDERED → ORDERED; a buyer can
  REJECT a submitted one (nothing ordered) or CLOSE a partly ordered one,
  always with a reason; a requester can CANCEL.
- **Ordering:** a buyer (`purchasing.manage` at the warehouse) picks a
  supplier and the open lines; one draft purchase order is created for the
  requisition's warehouse in the requested quantities and units, at prices
  the buyer enters. The supplier's last price is offered only when quoted in
  the same unit — never converted or guessed. The order goes through the
  normal approval (ADR-023). Requisitions themselves need no approval
  (Q-04 still open).
- Each line links to its order line. Removing that order line from a draft,
  or cancelling the order, frees the line to be ordered again; a short-closed
  or received order keeps it.
- Requisitions do not count as "on order" for reorder suggestions (ADR-025).

### ADR-030 Recipes and versions — Accepted (M4a)

- A **recipe** has a code, English/Arabic name and a type: **DISH** (served,
  costed per portion; portions required) or **PREPARATION** (sauce, dough,
  stock; usable as a sub-recipe, costed per yield unit).
- Content lives in numbered **versions**: DRAFT → ACTIVE → RETIRED. At most
  one active and one draft per recipe (partial unique indexes). Only drafts
  change — enforced in the service and by database triggers. Activating
  retires the previous version and stores a cost snapshot. A new draft
  copies the active (or latest) version; a draft other than version 1 can be
  discarded.
- A version's **yield** is a quantity in a unit of fixed size (kg, l, each…);
  cooking loss is part of the yield. Each **ingredient** is a product or a
  preparation, with a net quantity in any unit that converts (product
  conversions for products; fixed-size units of the same dimension for
  sub-recipes) and a **waste fraction** (trim loss): gross = net ÷ (1 − w).
- **Sub-recipes** resolve to their active version at costing time. A recipe
  can never contain itself directly or through others: checked when adding a
  sub-recipe and again on activation, under an organization-wide lock.
  Recipes used by active or draft versions cannot be archived.
- Permissions: `recipes.view` (organization-wide even from scoped roles,
  like ADR-027), `recipes.manage`, `recipes.costs.view`.

### ADR-031 Recipe cost sources and snapshots — Accepted (M4a, extends ADR-021)

- Three sources per product, per base unit:
  1. **AVERAGE** — stock value ÷ quantity over stock on hand that has a
     known cost (ADR-021), in one warehouse or the whole organization;
  2. **LAST_PURCHASE** — price on the latest posted goods receipt (landed
     cost not included);
  3. **STANDARD** — a manual cost with an effective date (append-only
     history; the latest effective on the calculation date applies).
- The user picks a source; it is tried first, then the others in the order
  above. Each line records the source actually used. A line with no cost in
  any source is reported as missing and left out of the totals — never
  estimated. Unit mismatches and missing sub-recipe versions are reported the
  same way.
- Line cost = gross quantity in the base (or yield) unit × unit cost, at
  money scale; a version's cost per yield unit (6 dp) feeds its parents.
- **Snapshots** store the totals in NUMERIC columns and the complete
  line-by-line breakdown (decimal strings, sources and references), the
  policy, warehouse and date, so a past cost is reproducible after prices
  change. One is stored on activation (stock average, organization-wide);
  more can be saved by hand. Snapshots are append-only.

### ADR-032 Selling prices, food cost targets and menu tools — Accepted (M4b)

- **Selling price** per dish in the base currency, **excluding VAT** until
  tax handling (M7), with an effective date; append-only history; the price
  in effect today (organization time zone) is used. One price per dish for
  now; branch and channel prices come with the POS (POS1).
- **Target food cost** (cost ÷ price) for the organization, optionally
  overridden per dish (0 < target < 100 %). There is no default target: until
  one is set, dishes show "no target" instead of an invented threshold.
- **Status per dish:** INCOMPLETE when any ingredient has no cost (never
  compared with the target — it would look better than it is), else
  NO_PRICE, else NO_TARGET, else ABOVE_TARGET when cost ÷ price > target,
  else OK (exactly at target is within it). Price for target = cost ÷
  target, rounded up to 0.01.
- **Price simulator:** a what-if unit cost for one product is applied to
  every active dish that uses it, also through sub-recipes; the result is
  shown before/after and nothing is stored or posted.
- **Bulk replacement:** replaces a product with another in the active
  version of selected recipes by creating a new version each (quantity ×
  factor, same unit); recipes with an open draft, not using the product, or
  whose unit does not convert for the new product are skipped and reported.
  The new versions stay drafts or are activated at once (with snapshots).
- **Method** text belongs to the version and is locked with it; the recipe
  card shows costs only to users with `recipes.costs.view` who ask for them.

### ADR-033 Lot traceability from recorded facts — Accepted (M6a)

- A trace is built only from what was recorded: ledger entries of the lot,
  goods receipt lines (supplier, order, delivery note, temperature) and
  shipments. Nothing is inferred to fill holes.
- **Backward:** the receipts that brought the lot in, with supplier contact.
  **Forward:** current stock by warehouse, location and status, shipments,
  and every movement in time order. Totals: brought in, left the business
  (write-offs, consumption, returns), on hand.
- **Gaps are reported explicitly:** stock that entered without a supplier
  (opening balance, positive adjustment or count) and outbound use of the
  same product without a lot in a warehouse where the lot was present.
  Until sales and production consume stock (M7), the trace states that
  consumption is not recorded.
- `traceability.view` is organization-wide (a lot crosses branches); scoped
  roles do not get it.

### ADR-034 Recalls — Accepted (M6a)

- A recall (`RCL-` number) has a title, reason and scope of lots — chosen
  by search or "all lots received from a supplier (and product)".
- **DRAFT is a simulation:** the page shows the affected stock by place and
  status, quantities in transit, suppliers and receipts; nothing changes.
- **Activation** (`recalls.manage`, all warehouses regardless of the user's
  scope): the lots get **recall hold**, the stock at that moment is stored,
  and AVAILABLE and QUARANTINE stock moves to **ON_HOLD** through status
  change documents (one per warehouse, linked to the recall). Recall-held
  lots cannot be transferred, dispatched or released; shipments in transit
  arrive ON_HOLD.
- **Closing:** DISPOSED writes off the ON_HOLD stock of the lots (reason
  RECALLED, documents linked) and keeps the hold; RELEASED lifts the recall
  hold (unless another live recall holds the lot) and leaves the stock
  ON_HOLD for a person with release permission to free after checking — a
  recall never releases stock to use automatically. A draft can be
  cancelled. Every step is audited; the report is printable.
- The application role may update only `inventory_lots.recall_hold`; lots
  stay otherwise immutable.

### ADR-035 Food safety records, checklists and corrective actions — Accepted (M6b)

- **Monitoring points** per branch (fridge, freezer, hot holding, cooking,
  ambient, other) with at least one temperature limit (°C, inclusive). The
  limits are set by the organization — no regulatory values are assumed
  (they depend on the market, Q-02).
- **Records:** temperature readings against a point (judged on the server
  against the limits at that moment, which are copied onto the record), and
  pass/fail hygiene, cleaning, pest-control and other checks. Records are
  evidence: never edited or deleted. Out of spec or failed requires the
  immediate action taken and opens a non-conformance (MEDIUM) in the same
  transaction.
- **Checklists:** organization-wide templates with yes/no and number items
  (optional range); items are retired, not deleted. A run is completed in
  one submission for a branch, every item answered; answers keep the item
  text and range as they were. Failures open one non-conformance per run
  (HIGH when more than one item failed).
- **Non-conformances** (`NC-`): branch, title, description, severity
  (LOW…CRITICAL), source (manual, record, checklist), status OPEN →
  INVESTIGATING (root cause) → ACTION_PLANNED (first action) → CLOSED.
  **Corrective actions** have an optional owner (an active member) and due
  date, are done with a note and **verified by someone else** (also a DB
  check). Closing requires every action verified; open actions past their
  due date are overdue.
- Permissions `foodsafety.view`, `foodsafety.record`, `foodsafety.manage`,
  all branch-scopable; templates are shared and managed by anyone with
  `foodsafety.manage` somewhere.

### ADR-036 Sales import and recipe-based consumption — Accepted (M7a)

- Sales arrive as **CSV files** per warehouse (no live POS connection is
  claimed): date, external id (unique per sold line), item code, optional
  item type, quantity, optional net amount (as given, excluding VAT — no tax
  is calculated until Q-02) and channel.
- **Item:** a recipe code — a DISH is sold in portions, a PREPARATION in its
  yield unit — or a product SKU (sold in its base unit). A code that is both
  needs `item_type`. Recipes need an active version; the version used is
  stored on the line.
- **Idempotent:** an external id is posted at most once (partial unique
  index over active lines; imports are serialized per organization). Lines
  already imported are skipped and counted, so a file can be uploaded again.
- **All or nothing:** every row is validated, recipes are exploded (gross
  quantities with waste, sub-recipes through their active versions), and the
  stock plan is checked before anything is written. Any problem — unknown
  item, no active version, unit that does not convert, not enough usable
  stock — rejects the file with every problem listed. Stock never goes
  negative.
- **Posting:** one CONSUMPTION document per import; per product, AVAILABLE
  stock is taken first-expired-first-out, expired and recall-held lots
  excluded. Its value at moving average is the import's cost of sales.
  Consumption shows in lot traceability.
- **Reversal** happens from the sales import (generic reversal is refused):
  stock is restored and the lines become inactive, so the same external ids
  can be imported again from a corrected file.
- Permissions `sales.view`, `sales.import` (warehouse-scopable). Refunds and
  negative quantities are not supported yet.

### ADR-037 VAT setup for Saudi Arabia, Egypt and the GCC — Accepted (answers Q-02 for these markets)

- **One VAT country per organization:** SA, AE, BH, OM, QA, KW or EG. A
  country preset creates the organization's own codes — STD (standard rate
  with its history), ZERO, EXEMPT, OOS — which it can extend; re-applying
  adds missing rates only. Which items are zero-rated or exempt is the
  organization's decision; nothing is assigned automatically.
- **Preset rates** (checked 2026-11-02):

  | Country       | Standard rate history                     | VAT number format check                       |
  | ------------- | ----------------------------------------- | --------------------------------------------- |
  | Saudi Arabia  | 5 % from 2018-01-01; 15 % from 2020-07-01 | 15 digits, first and last 3 (ZATCA BR-KSA-40) |
  | UAE           | 5 % from 2018-01-01                       | 15 digits (TRN)                               |
  | Bahrain       | 5 % from 2019-01-01; 10 % from 2022-01-01 | 15 digits                                     |
  | Oman          | 5 % from 2021-04-16                       | not confirmed — letters/digits only           |
  | Egypt         | 14 % from FY 2017/18                      | 9 digits (secondary sources)                  |
  | Qatar, Kuwait | no VAT in force — no codes created        | —                                             |

  Sources: KPMG GCC VAT comparison; Baker McKenzie GCC VAT framework update
  (2026); KSA Ministerial Decision (Official Gazette 2020-05-15); Oman Royal
  Decree 121/2020; Egypt VAT Law 67/2016 and later amendments; ZATCA
  e-invoicing rule BR-KSA-40. Format checks never prove registration — only
  the tax authority's lookup does.

- **Rates are dated and append-only:** a change in the law is a new rate
  with its effective date; every sale uses the rate on its own date, and
  stores code, rate, net, VAT and gross.
- **Rounding:** VAT per line, half-up to the currency's minor unit (2
  decimals for SAR, AED, EGP, QAR; 3 for BHD, KWD, OMR — from ICU data).
  From net: VAT = net × rate. From gross: VAT = gross × rate ÷ (1 + rate),
  net = gross − VAT, so the parts always add up.
- **Registration:** VAT is charged only when the organization is VAT
  registered, has a default sales code and a valid-format number;
  registering is refused in countries without VAT.
- **Sales import** (amends ADR-036): `net_amount` or `gross_amount` (not
  both) and an optional `tax_code`; the code is the file's, else the dish's,
  else the default; no rate on the sale date is an error.
- **Selling prices** (amends ADR-032): with "prices include VAT" on, a price
  is stored as including VAT; food cost % and margin always use the net
  price at today's rate of the dish's code.
- **VAT summary:** output VAT from imported sales by code and rate for a
  period — not a VAT return. Input VAT from supplier invoices: ADR-038;
  ZATCA Fatoora and Egypt ETA e-invoicing/e-receipts remain POS4.
- Changing the setup needs `org.settings.manage`.

### ADR-038 Supplier invoices with a 3-way match — Accepted (M7b)

- **Invoice** (`PI-` number): supplier, the supplier's own invoice number
  (unique per supplier among invoices that are not cancelled), invoice
  date, due date (defaults to invoice date + the supplier's payment terms)
  and the **total as printed**. DRAFT → POSTED, or CANCELLED with a reason.
  Base currency only (Q-05 default).
- **Goods lines** come only from **posted receipt lines of the same
  supplier** — quantity in the receipt's unit, invoice unit price. The
  order price and the price charged on receiving are copied onto the line.
  **Charge lines** (delivery, packaging …) have a description and a net
  amount.
- **Match per goods line:**
  - quantity: what is still open on the receipt line = accepted quantity −
    everything on other invoices that are not cancelled (drafts included,
    so two drafts cannot both claim the same delivery). More than open =
    QUANTITY_VARIANCE.
  - price: |invoice price − order price| ≤ order price × tolerance =
    matched, else PRICE_VARIANCE. The tolerance is set in purchasing
    settings (default 0 %). The price difference (invoice − order) ×
    quantity is shown for every line.
  - **Total:** the printed total must equal the sum of the line totals,
    rounded to the currency's minor unit.
  - Any variance or a total that does not match makes the invoice an
    **EXCEPTION**; everything is recomputed whenever lines or the header
    change.
- **Exceptions** are approved with a note by **someone other than who
  entered the invoice** (`invoices.manage`); any later change to lines or
  total clears the approval. Posting needs at least one line and, for an
  exception, an approval.
- **VAT per line:** the product's purchase VAT code, an override, or the
  organization's default purchase code, at the rate in force on the
  **invoice date**; computed from net and rounded per line like sales
  (ADR-037). The invoice date cannot change while there are lines, so rates
  stay consistent. Lines store code, rate, net, VAT and gross.
- **Input VAT** in the VAT summary: posted invoices by invoice date, per
  code and rate; reclaimable only when the organization is VAT registered
  (otherwise shown as part of the cost). With both sides the page shows
  output − input as an estimate — not a VAT return.
- **Stock is not touched:** invoices do not change stock or its value.
  Price differences are reported only; charging them to stock (like landed
  cost, ADR-028) is a later decision.
- Invoicing is serialized per supplier (advisory lock) so concurrent
  entries cannot over-invoice a receipt line. `invoices.view` /
  `invoices.manage` are organization-wide permissions (admin, operations
  manager and finance manage; procurement and analyst view).

### ADR-039 Supplier payables: payments, credit notes, balances, export — Accepted (M7c)

- **Settlements** are payments (`PAY-`, method: bank transfer, cash,
  cheque, card, other; reference) and supplier credit notes (`SCN-`, the
  supplier's credit note number — unique per supplier unless voided — net
  amount, VAT code and a reason). A credit note's VAT is computed like an
  invoice line at the rate on its date. Amounts may not have more decimals
  than the currency. Recording needs `payments.manage` (admin, finance) —
  separate from entering invoices, so the person who enters an invoice need
  not be able to pay it.
- **Allocation:** a settlement is applied to posted invoices of the same
  supplier, by amounts per invoice or **earliest due first** (then invoice
  number). An invoice cannot receive more than is open; a settlement cannot
  apply more than it has. What is not applied stays **on account** and can
  be applied later. Allocations are insert-only.
- **Fixed once recorded:** a settlement is never edited; it can only be
  **voided** with a reason (database trigger), which reopens the invoices
  it paid. A posted invoice with payments or credits applied cannot be
  cancelled until they are voided.
- **Balance** per supplier on a date = posted invoices dated up to then −
  payments and credit notes dated up to then. **Aging** buckets the open
  amount of each invoice by days past its due date (invoice date if none):
  not yet due, 1–30, 31–60, 61–90, over 90. Voiding counts from the moment
  it happens: a voided document is excluded from every date.
- **Statement** per supplier and period: opening balance, invoices,
  payments and credit notes with running balance, open invoices, and
  settlements not yet applied.
- **Input VAT** (amends ADR-038): credit notes reduce input VAT in the
  period of their date, per code and rate.
- **Accounting export** (CSV, per period, `invoices.view`):
  - documents — one row per invoice and VAT rate, credit note and payment,
    with supplier VAT number and reference; amounts at the currency's
    decimals.
  - journal — balanced debit/credit lines using the organization's **own
    account codes** (payables, purchases, input VAT, bank/cash), entered in
    purchasing settings; nothing is assumed, and the export is refused until
    they are set. Invoice: Dr purchases (net), Dr input VAT, Cr payables;
    without VAT registration the VAT is part of purchases. Credit note: the
    reverse. Payment: Dr payables, Cr bank.
  - Files are generic; no ERP or bank integration is claimed (Q-06 open).
    A re-export reflects voids since the last one.

---

## Business assumptions (recorded, not invented rules)

| ID   | Assumption                                                                                                                                                                                                                                    | Status                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A-01 | One organization = one customer legal/commercial entity; branches and warehouses belong to exactly one organization.                                                                                                                          | Proposed               |
| A-02 | A user can belong to several organizations with different roles.                                                                                                                                                                              | Accepted (M1)          |
| A-03 | Self-service sign-up creates a new organization with the signer as Owner; joining an existing org is by invitation only.                                                                                                                      | Accepted (M1)          |
| A-04 | One base currency per organization; no multi-currency documents in the MVP.                                                                                                                                                                   | Proposed               |
| A-05 | Stock is owned at warehouse level; storage locations are optional sub-divisions.                                                                                                                                                              | Proposed               |
| A-06 | Negative stock is never allowed in the MVP.                                                                                                                                                                                                   | Accepted (requirement) |
| A-07 | Expiry is evaluated against the calendar date in the branch's time zone; stock expiring today is still usable today.                                                                                                                          | Proposed               |
| A-08 | ~~Inventory in transit is held in a per-organization transit warehouse.~~ Replaced by ADR-026: in-transit stock stays at the source warehouse with status IN_TRANSIT.                                                                         | Superseded             |
| A-09 | Nutrition values and allergen absence are never inferred; missing data is shown as unknown.                                                                                                                                                   | Accepted (requirement) |
| A-10 | Initial suggested roles (Owner, Administrator, Operations Manager, Procurement, Warehouse, Food Safety/Quality, Finance, Branch Manager, Read-only Analyst) are system templates per organization; permission sets are editable except Owner. | Proposed               |

## Open questions

| ID   | Question                                                                                                                                                                | Needed by                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Q-01 | ~~Inventory valuation method~~ — **Decided:** moving weighted average per product × warehouse (ADR-021).                                                                | M3                        |
| Q-02 | ~~Target launch markets~~ — **Decided for VAT:** Saudi Arabia, Egypt and the GCC (ADR-037). Still open: allergen/label rules and data residency per market.             | M5 (labels), M8 (hosting) |
| Q-03 | Hosting provider and region / data-residency requirements.                                                                                                              | M8 (pilot)                |
| Q-04 | Purchase approval policy — **default in place** (ADR-023): one optional approval limit; author cannot approve. Confirm, or ask for multi-level approval.                | M3                        |
| Q-05 | Foreign-currency supplier invoices — **default in place** (ADR-023): base currency only. Confirm for the pilot.                                                         | M7                        |
| Q-06 | Which POS / accounting systems do pilot customers use (for import formats and exports)?                                                                                 | M7                        |
| Q-07 | Is SSO (Google/Microsoft) or 2FA required for the pilot?                                                                                                                | M1 (nice to know)         |
| Q-08 | Attachment retention period and maximum file size.                                                                                                                      | M6                        |
| Q-09 | Over-receipt tolerance — **default in place** (ADR-023): 0 %, configurable per organization.                                                                            | M3                        |
| Q-10 | Which email provider should send invitations, password resets and notifications? Until then there is **no self-service password reset**.                                | M2 (before pilot)         |
| Q-11 | Should base currency ever be changeable before any transactions exist? Currently fixed at creation.                                                                     | M2                        |
| Q-12 | Should counting and approving a stock count require two different people (segregation of duties)? Currently allowed to be the same user.                                | M8 (pilot)                |
| Q-13 | Product categories — **default in place** (ADR-025): flat list, optional per product. Confirm, or ask for a hierarchy.                                                  | M3                        |
| Q-14 | ~~Scope versus Foodics~~ — **Decided:** option C, full point of sale in scope (ADR-022, milestones POS1–POS5).                                                          | —                         |
| Q-15 | Payment provider and card terminals per market (e.g. a local acquirer in KSA, UAE, Egypt)? Needed before POS3.                                                          | POS3                      |
| Q-16 | POS devices: which hardware (iPad/Android tablets, Windows terminals), receipt printers and cash drawers must be supported, and how long must the cashier work offline? | POS1                      |
| Q-17 | First market for live POS sales (decides which e-invoicing system POS4 builds first: ZATCA, Egypt ETA, UAE). Related to Q-02.                                           | POS4                      |
| Q-18 | Which delivery platforms must send orders into the POS (e.g. HungerStation, Jahez, Talabat, Careem)?                                                                    | POS5                      |
