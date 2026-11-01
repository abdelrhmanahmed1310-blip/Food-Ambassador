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
  neither created nor submitted the order. Multi-level approval:
  superseded by ADR-049 (Q-04 decided).
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

### ADR-040 Nutrition, allergens and labels — Accepted (M5a)

- **Nothing is inferred** (A-09). A nutrient left empty is unknown; an
  allergen with no statement is UNKNOWN, never "free from".
- **Allergens tracked:** the 14 of EU Regulation 1169/2011 Annex II for
  every product; the 8 categories of Codex CXS 1-1985 §4.2.1.4 (the basis of
  most Gulf and Egyptian rules) are marked. Which list a market's label must
  use stays open (Q-02); tracking all 14 never hides one.
- **Statements** per product and allergen: CONTAINS, MAY_CONTAIN
  (cross-contact), FREE_FROM, or back to UNKNOWN, with source (supplier
  specification, lab, food database, manual), reference and note.
  Append-only: a new statement supersedes the current one (history kept,
  database trigger). **FREE_FROM needs a reference, can never come from a
  food database, and counts only after a second person verifies it**
  (`nutrition.manage`, not the author). CONTAINS and MAY_CONTAIN count at
  once, verified or not.
- **Nutrition profiles** per product, per 100 g or 100 ml: energy kcal/kJ,
  fat, saturates, carbohydrate, sugars, fibre, protein, salt, sodium (g),
  each nullable. Plausibility checks (saturates ≤ fat, sugars ≤
  carbohydrate, ≤ 100 g per 100 g). Supplier specifications and lab
  results need a reference. Append-only and verified by a second person,
  like statements. No value is derived from another (e.g. salt from
  sodium).
- **Recipe roll-up** over the active version and its active sub-recipes,
  with **net quantities as eaten** (trim waste excluded). A product counts
  in its profile's basis through its base unit or a product conversion
  (e.g. 1 each = 50 g); otherwise it is missing. Per nutrient: unknown
  unless every ingredient has it. Per portion; per 100 g/ml of the finished
  recipe only when its yield is a weight or volume (cooking losses are not
  modelled). A recipe part that cannot be expanded makes every value
  unknown and removes every "free from". Allergens: any CONTAINS →
  contains; else any MAY_CONTAIN → may contain; else FREE_FROM only if
  every ingredient has a verified FREE_FROM; else unknown.
- **Labels** are snapshots of the calculation (values rounded after the EU
  2012 tolerance guidance, exact values kept; ingredient list by edible
  weight; contains / may contain). Generation is refused until: the recipe
  expands fully, energy, fat, saturates, carbohydrate, sugars, protein and
  salt are known, no allergen is unknown, every profile is verified, there
  are portions or a weight/volume yield, and every ingredient has a weight.
  A label waits for review by someone with `labels.approve` other than its
  author; approval is refused if the data changed since (hash of versions,
  profiles and statements). One pending and one approved label per recipe;
  approving replaces the previous one. Only approved, unchanged labels print.
  The layout is generic; market label rules remain Q-02.
- **Allergen matrix:** every active recipe against the 14 allergens.
- Permissions: `nutrition.view`, `nutrition.manage`, `labels.approve`
  (quality and operations managers approve).

### ADR-041 Ingredient library from USDA FoodData Central, Open Food Facts and Wikidata — Accepted (M5b)

- **All three sources**, each for what it is good at: USDA FoodData Central
  for generic ingredients' nutrition (Foundation, SR Legacy, Survey,
  Branded); Open Food Facts for packaged products by barcode, with their
  listed allergens and traces; Wikidata for English and Arabic names.
- **Copies with provenance:** a library record keeps its source id, data
  type, source link, licence and attribution, and notes on how values were
  read. Per organization (tenant data like everything else), unique per
  source and id; a later file updates the copy. A file (by content hash) is
  imported once. Up to 2,000 records per import (one transaction); full
  downloads go through `pnpm library:import`, split into atomic,
  idempotent parts.
- **Read, never filled in:** values are taken only from the fields the
  source publishes per 100 g/ml, by FDC nutrient number and unit (energy
  208, else 958/957 with a note; carbohydrate 205, else 205.2 with a note;
  sugars 269 or 269.3; sodium 307 mg → g) or Open Food Facts' `_100g`
  fields. Nothing is derived (no salt from sodium), and allergens are never
  read from ingredient text. A value in an unexpected unit is left out with
  a note.
- **Using a record for a product** (`nutrition.manage`): values become a
  new DATABASE profile, unverified until a second person checks it
  (ADR-040), linked to the record; refused over a supplier-specification or
  lab profile and when the values fail the plausibility checks. Open Food
  Facts allergens become CONTAINS / traces MAY_CONTAIN only where nothing is
  known yet; a database never sets FREE_FROM, never overrides a statement,
  and contradictions (e.g. the product is declared free from milk but the
  record lists milk) are reported for a person to resolve. A Wikidata
  Arabic name fills a product's empty Arabic name only.
- **Licences:** FDC and Wikidata are CC0. Open Food Facts is ODbL 1.0
  (contents DbCL): attribution is shown on every record, and a database
  derived from it that is made public must be offered under ODbL — so the
  library is per organization and not republished.
- **Live lookup** (search the sources from the app) is not built: this
  environment cannot reach the hosts, and nothing is claimed without
  testing against the real services. File formats follow the sources'
  published documentation; validate against a real download when one is
  imported.

### ADR-042 Reports: waste, actual food cost and branch comparison — Accepted (M8a)

- **Only recorded data, no estimates or sample figures.** Reports are
  tables with exact amounts and CSV downloads; a ratio is shown only when
  both sides are known.
- **Waste** = write-offs net of their reversals; **stock differences** =
  manual adjustments and count differences net of reversals (a negative
  amount is stock found). Both at the ledger's stock value, by business
  date in the organization's time zone, by reason, product and warehouse.
  Movements with no known cost count as zero and are flagged.
- **Actual food cost** = cost of sales of sales imports (the stock value
  their recipe-based consumption used, ADR-036) ÷ their net sales. An
  import holds one cost for the whole file, so it counts in a period only
  when **all** its sales dates fall inside it; imports that straddle the
  boundary are listed, never split. Food cost % is shown only when every
  sales line has a net amount.
- **Branch comparison:** per branch, net sales, cost of sales, food cost %,
  waste, stock differences, and (cost + waste + differences) ÷ net sales.
  Monthly food cost % for the last 12 months uses imports within one month.
- **Access:** values need `inventory.valuation.view`, sales figures
  `sales.view`, each where the user holds them (a branch manager sees only
  their branch). No new permission.
- Not yet: cost per sales line (needed to split a file by day), theoretical
  vs. counted usage per product beyond the count differences, supplier
  price trends (purchase price history exists per supplier item, M3c).

### ADR-043 "Needs attention" instead of stored notifications — Accepted (M8b)

- What is waiting is **computed when the page is opened** from the current
  data, so it can never be stale or out of sync, and nothing is stored or
  sent. (Push or e-mail notifications need an e-mail provider, Q-10, and
  background jobs, ADR-008.)
- Items, each shown only to users who can act on it, at their sites:
  expired stock still available and stock expiring within 7 days
  (`inventory.view`); quarantine awaiting a decision
  (`inventory.quarantine.release`); products whose usable stock (available,
  not expired, not on recall hold) is below the reorder minimum
  (`purchasing.view`); purchase orders to approve that the user did not
  submit (`purchasing.approve`); requisitions waiting (`purchasing.manage`);
  submitted counts (`inventory.count.approve`); invoice exceptions entered
  by someone else (`invoices.manage`); overdue supplier invoices with the
  open amount (`invoices.view`); labels and nutrition/allergen data to
  verify, made by someone else (`labels.approve`, `nutrition.manage`); open
  non-conformances and overdue corrective actions (`foodsafety.manage`);
  active recalls (`recalls.manage`).
- Shown on the overview (first six) and on its own page, most urgent first.

### ADR-044 Pilot readiness: backups, integrity check, security baseline — Accepted (M8c)

- **Backups** are `pg_dump` custom-format files with a SHA-256 checksum
  (`pnpm db:backup`), daily and before every deploy, stored off the database
  host, encrypted and access-limited (they hold every tenant's data).
- **Restores** go only into a new, empty database (`pnpm db:restore`): the
  checksum must match, the target must have no tables, the tenant role is
  recreated, the restore is one transaction, and the integrity check runs
  after it. A live database is never overwritten; a single organization
  cannot be restored on its own (shared tables) — documented manual
  procedure instead.
- **Integrity check** (`pnpm db:verify`): RLS and policy on every tenant
  table, balances = ledger, values = ledger + revaluations + landed costs,
  no negative or over-reserved stock, all migrations applied. Counts only,
  never data. Run after restores and migrations and daily.
- **Drill** before the pilot and quarterly, recorded in docs/OPERATIONS.md.
- **Security baseline:** services check permissions even where a page
  already does; `frame-ancestors 'none'`, `base-uri`/`form-action 'self'`,
  `object-src 'none'` and HSTS in production. Restricting script sources
  needs per-request nonces and is left open, like password reset and 2FA
  (Q-10, Q-07) and an external penetration test — see
  docs/SECURITY_REVIEW.md.

### ADR-045 Central kitchen production — Accepted (M9a)

- A **PREPARATION** recipe can name the stock product it produces
  (`recipes.output_product_id`, CK: preparations only); its yield unit must
  convert to the product's stock unit.
- A **production order** (`PRD-`) fixes recipe, active version, site and
  planned quantity (yield unit). Completing it posts one `PRO-` PRODUCTION
  document: the ingredients of the planned quantity — gross, with waste, as
  for sales (ADR-036) — are taken FEFO from usable stock (never expired or
  recall-held; shortages refuse the whole batch), and the actual output
  enters stock with **exactly the value the ingredients took**
  (`costFromLines`, no rounding drift). Yield variance = actual − planned.
- **Lot rules:** a lot-tracked output gets a lot (default: the order
  number); its expiry is the product's shelf life from today, but never
  later than the earliest expiry of an ingredient lot used — an explicit
  later date is refused.
- **Genealogy** from the ledger: a produced lot lists the lots it was made
  from (ingredients without a lot are shown as gaps); an ingredient lot
  lists the batches it went into. (Recalls do not yet follow genealogy
  automatically: recall the output lots too.)
- Reversal only from the order (generic reversal refused), and only while
  the whole output is still in stock; cancel only while planned. Status
  transitions are enforced by a trigger.
- **Plan** per site: open branch requisitions for each output product (not
  yet ordered from a supplier) + topping up to the reorder maximum when
  stock would fall below the minimum − usable stock − already planned,
  rounded up to whole batches.
- Permissions `production.view` / `production.manage`, scoped to sites.

### ADR-046 Branch requests fulfilled from the central kitchen — Accepted (M9b)

- A submitted requisition line is met **either** by a purchase order line
  (M3c) **or** by a shipment from own stock (`purchase_requisition_lines.
shipment_id`, CK: not both). The buyer (`purchasing.manage` for the
  requesting site, `inventory.transfer` at the source) chooses the source
  warehouse; usable stock there is picked FEFO into one **draft shipment**
  to the requesting warehouse — dispatch and receipt then work as any
  shipment (ADR-026). Nothing is picked if a line is short.
- The requisition becomes partly or fully ordered either way; cancelling the
  shipment opens its lines again. The production plan (ADR-045) counts only
  lines met by neither.

### ADR-047 B2B customers, deliveries, sales invoices and receivables — Accepted (M9b)

- **Customers** (code, names, VAT number, payment terms). **Sales orders**
  (`SO-`): draft lines at net prices per unit with an optional VAT code (none
  = the default sales code), confirmed, then delivered in one or more
  deliveries; cancel only without deliveries.
- **Deliveries** take usable stock FEFO from the order's warehouse as a
  CUSTOMER_DELIVERY document (`DN-`, the delivery note number) with a new
  movement type, so B2B sales stay out of the restaurant food cost and
  waste reports. Cost of goods is recorded per line. Reversal only from the
  delivery and only while it has no invoice; generic reversal is refused.
- **Sales invoices** (`SI-`): one per delivery, at the order prices, VAT per
  line at the rate on the invoice date when the organization is VAT
  registered (ADR-037 rounding), due date from the payment terms; gross
  margin = net − cost of goods. Fixed once issued (trigger); cancel only
  without receipts. Output VAT appears in the VAT summary. The printout is
  not an e-invoice (ZATCA / ETA: POS4).
- **Receipts** (`RCT-`) applied to invoices earliest due first, voidable;
  customer balances and aging as for suppliers (ADR-039). Overdue customer
  invoices appear in "needs attention".
- Organization-level `b2b.view` / `b2b.manage` (B2B is run by head office).
- Not yet: customer credit notes and returns, price lists, credit limits,
  invoicing several deliveries at once, B2B journal export.

### ADR-048 Integration framework: connectors, signed webhooks, outbox — Accepted (M10)

- **Connectors** per organization, managed by owners and admins
  (`integrations.manage`). Two kinds in our own documented format
  (docs/INTEGRATIONS.md): an **inbound sales webhook** and an **outbound
  event webhook**. Named third-party connectors (POS brands, Xero, WhatsApp,
  OCR) are not built or listed until tested against the provider's real
  sandbox (ADR-022, PROJECT_PLAN M10).
- **Secrets**: one per connector, random, shown once; stored AES-256-GCM
  encrypted with `INTEGRATION_ENCRYPTION_KEY` (or a key derived from
  `AUTH_SECRET` by HKDF when unset), last four characters as a hint; never in
  audit records or logs. Rotation replaces it at once.
- **Signatures**: HMAC-SHA256 over `timestamp.body`, constant-time compare,
  5-minute window, both directions.
- **Inbound**: the connector is found by an unguessable public id (the only
  lookup before the tenant is known); then rate limit (120/min), active
  check, signature, mandatory Idempotency-Key, body validation. Sales are
  posted by the existing sales import (no second code path into the
  ledger) **as the connector's creator with their current permissions**;
  creating one requires `sales.import` on its warehouse. Every request is
  logged (`integration_events`: status, outcome, body hash and size, not
  the body); one ACCEPTED event per key (partial unique index), repeats
  return the first outcome.
- **Outbound**: a transactional outbox. `emitEvent` inserts
  `outbound_deliveries` in the same transaction as the business change
  (PO approved, goods receipt posted, sales invoice issued), one per
  subscribed active connector, unique per event, so an event exists exactly
  when the change committed. A worker (`pnpm integrations:deliver`) claims
  due rows with a lease (`FOR UPDATE SKIP LOCKED`), POSTs, and retries after
  1 min, 5 min, 30 min, 2 h, 12 h before FAILED; manual retry keeps the
  event id. At-least-once: receivers deduplicate on `X-FA-Event-Id`.
- **SSRF**: https only, no credentials in the URL, no redirects; host
  addresses in private/loopback/link-local/CGNAT/multicast ranges refused
  on save and on the IP dialled at send time (custom DNS lookup, no
  connection reuse), defeating DNS rebinding. A development-only flag
  allows private http targets.
- Payloads carry ids, numbers and totals only.
- Not yet: per-connector event filters beyond type, payload versioning,
  inbound formats other than ours, a job runner inside the app (the worker
  is a separate process, ADR-008).

### ADR-049 Approval matrix: branch layers then head office, each with its own limit — Accepted (Q-04, Q-12)

- **Decision (Q-04, refined):** purchase orders pass up to three **branch
  layers** and then a **head-office layer**. **Each layer has its own
  limit** and is required only when the amount is above it (0 = any
  amount; empty = layer not used). Example: branch 1 above 0, branch 2
  above 5,000, head office above 20,000 — a 3,000 order needs one branch
  approval, a 25,000 order all three. No applicable layer = approved on
  submit. Configured under Settings → Approvals (`approval_layers`); this
  replaces the single approval limit of ADR-023.
- **Decision (Q-12):** stock counts use the same matrix, configured
  separately; the amount is the **value of the differences** (Σ |counted −
  system| × average cost, base currency) at submission. Counts without
  differences need no approval. If a differing item has no known cost, every
  configured layer applies (never under-approve on unknown values).
- **Who signs:** branch layers need the approval permission
  (`purchasing.approve` / `inventory.count.approve`) granted for the
  document's own branch or warehouse — an organization-wide grant is head
  office and does not count; the head-office layer needs it
  organization-wide. Each step is a different person and never the
  document's creator or submitter (service check, unique index, database
  trigger). Branch Managers hold `purchasing.approve`.
- **Flow:** the chain is fixed at submission; steps are signed in order;
  the last one approves the order (and emits `purchase_order.approved`) or
  posts the count. Whoever may sign the current step may send it back with
  a reason (order → draft; count → open for recounting); resubmission starts
  a new round. Every signature is kept and audited. "Needs attention" counts
  only documents whose next step the user may sign.
- Not covered: delegation/holiday cover, approval of requisitions.

### ADR-050 Foreign-currency purchasing and exchange rates — Accepted (Q-05, Q-11)

- **Decision (Q-05):** purchase orders, receipts, supplier invoices,
  payments and credit notes may be in **USD, EUR, SAR, EGP, AED, KWD, QAR,
  BHD or OMR**, or the base currency. **Decision (Q-11):** the base currency
  stays fixed at creation; everything is also stated and reported in it.
- **Rates** (`exchange_rates`): base-currency units for one unit of a
  currency on a date, entered under Purchasing → Exchange rates or pasted as
  CSV (all rows checked first), by owners, admins and finance (`fx.manage`).
  A document uses the latest rate on or before its date, at most **7 days**
  old; otherwise it is refused (no rate is ever guessed). **No live rate
  feed is connected** or claimed; one can be added as a connector (ADR-048).
- **Each document keeps its own currency and the rate it used**, so later
  corrections never change posted documents:
  - supplier: default currency (null = base); last prices are kept in it;
  - order: currency (default the supplier's); at submission the rate and
    base total are fixed, and the **approval limits apply to the base total**
    (ADR-049);
  - receipt: the order's currency and the rate on the receipt date; **stock
    is valued at price × rate** (moving average stays in base, ADR-021).
    Landed costs stay in base currency;
  - invoice: currency (default the supplier's), receipt lines only in the
    same currency, VAT rounded to that currency's unit, **rate and base
    totals fixed when posted** (invoice date);
  - payment / credit note: currency (default the supplier's), rate on its
    date, base amounts; applied only to invoices in the same currency
    (service and database trigger). Each allocation stores the **realised
    exchange difference** = amount × (settlement rate − invoice rate)
    (positive = loss).
- **Reporting in base currency:** balances per supplier _and currency_ with
  a base equivalent (open invoices at their rates, unapplied settlements at
  theirs) and base totals; statements per currency; input VAT summary from
  base amounts; supplier price variance in base; the documents export
  carries currency, rate and base columns; the journal is in base currency
  with exchange differences posted to an exchange-difference account
  (required once any exists).
- Period-end revaluation: ADR-052; landed costs: ADR-053; B2B: ADR-054.
  Not yet: a live rate feed.

### ADR-051 Attachments: 3 MB, kept 3 years — Accepted (Q-08)

- **Decision (Q-08):** files up to **3 MB** each, **kept 3 years** from
  upload. After that a daily job (`pnpm attachments:purge`) deletes the
  content and keeps the record (name, size, SHA-256, dates).
- On purchase orders, goods receipts, supplier invoices, payments / credit
  notes and stock counts. Whoever may see the document may see and download
  its files; whoever may work on it (manage the order, receive, enter
  invoices, record payments, count) may add files. Nothing crosses
  organizations (row-level security and service checks).
- **Types:** PDF, JPEG, PNG, WebP, detected from the file's first bytes —
  never from its name or the browser. Names are cleaned (no paths or control
  characters) and get the detected extension. Downloads are always served
  as attachments with `nosniff` and a sandboxing CSP, so a file can never
  run as a page of this site.
- **Removal (assumption, to confirm):** only a mistaken upload, by its
  uploader, within one hour; otherwise files stay for the retention period.
  Records are fixed in the database (trigger) and the stored size must match
  the bytes.
- **Storage:** PostgreSQL (`attachment_contents`, apart from the metadata),
  so files are in the same backups and tenancy model; object storage can
  replace it after the hosting decision (Q-03). Server actions accept 4 MB
  bodies for this; other uploads keep their own lower limits.
- Virus scanning: ADR-055. Not yet: previews, attachments on other
  documents (food safety records, recipes).

### ADR-052 Period-end exchange revaluation — Accepted

- On a chosen date, each supplier's **open balance per foreign currency**
  (invoices − settlements, booked at the documents' own rates, as in the
  balances report) is valued at the rate on that date (same 7-day rule,
  ADR-050). The difference is an **unrealised** exchange gain or loss
  (+ = the payable grew = loss).
- Stored as a **revaluation** (`REV-`, `fx_revaluations` + lines: open
  amount, booked base, rate and its date, revalued base, difference),
  fixed by trigger, one per date unless cancelled (with a reason). By
  owners, admins and finance (`fx.manage`); visible to `invoices.view`.
- The journal export posts it on its date (exchange-difference account
  against payables) and **reverses it the next day**, so every period
  starts from booked values and realised differences (ADR-050) stay
  correct; the reversal appears in the period that contains the next day.
- Customer balances are revalued in the same run (ADR-056): their
  difference is kept apart (+ = the amount due grew = gain) and exported
  in the receivables journal.

### ADR-053 Landed costs in foreign currencies — Accepted

- A landed cost (freight, duty, insurance, handling, other) may be entered in
  any document currency (ADR-050); it is converted at the rate on the
  posting date and the **base amount** is allocated and posted to stock as
  before (ADR-028). The entered currency, amount and rate are kept on the
  charge (`landed_costs.currency`, `entered_amount`, `exchange_rate`,
  `rate_date`); amounts must fit the currency's unit.
- Allocation by value uses the receipt's own prices (one currency per
  receipt), so the shares are unaffected.

### ADR-054 B2B sales in foreign currencies — Accepted

- Customers have a default currency (null = base; USD, EUR, SAR, EGP or a GCC
  currency, ADR-050). Sales orders are priced in a currency (default the
  customer's). Deliveries are valued at cost in base currency as before.
- **Sales invoices** are in the order's currency: VAT and rounding in that
  currency's unit, the **rate on the invoice date** fixed with base totals
  (`net/tax/gross_amount_base`); **margin = net in base − cost**.
- **Customer receipts** have a currency (default the customer's), the rate on
  their date and a base amount; they settle only invoices of the same
  customer and currency (service and database trigger). Each allocation
  stores the realised difference = amount × (receipt rate − invoice rate)
  (+ = gain for receivables).
- Customer balances are per customer and currency with a base equivalent at
  the documents' rates and a base total; output VAT in the VAT summary is in
  base, each line at its invoice's rate.
- Revaluation of customer balances and the B2B accounting export: ADR-056.

### ADR-055 Virus scanning of attachments with ClamAV — Accepted

- When `CLAMAV_URL` (tcp://host:port of a ClamAV daemon) is set, every upload
  is streamed to clamd (`INSTREAM`) before it is stored. **Infected → refused**
  and nothing is stored (the attempt and signature name are audited);
  **scanner unreachable or erroring → refused** (fail closed), so no
  unchecked file slips in while scanning is configured. Clean files are
  stored as `CLEAN` with the scan time.
- When unset, files are stored as `NOT_SCANNED` and shown as "not
  virus-checked". Production should run clamd with current signatures
  (`freshclam`); docker-compose has an optional `clamav` service.
- Access is checked before scanning, so the scanner cannot be used by
  people who may not add files to the document.
- Verified against a real clamd 1.x in development with a local EICAR
  signature (the official signature download was blocked by the
  environment's network policy); CI uses a protocol stand-in unless
  `CLAMAV_TEST_URL` points at a daemon.

### ADR-056 B2B accounting export and revaluation of customer balances — Accepted

- **Accounts** (purchasing settings): customer receivables, sales, output
  VAT (when VAT registered), bank for customer receipts, and the exchange
  account (ADR-050).
- **Documents export** (B2B → balances): sales invoices and customer
  receipts of the period with document currency, rate, base amounts and
  the invoice's cost of goods.
- **Journal export** in base currency, balanced: invoice — Dr receivables
  gross, Cr sales net, Cr output VAT; receipt — Dr bank, Cr receivables,
  plus the realised difference (gain: Dr receivables, Cr exchange; loss the
  other way); revaluations — the customer differences on the date and
  reversed the next day. Cost of goods and stock are not journaled here,
  as for purchases (periodic approach, ADR-039).
- **Revaluation** (ADR-052) now includes open customer balances in foreign
  currencies (with `b2b.view`); each line is for one supplier or one
  customer (CHECK), and the run keeps payables and receivables totals apart.

### ADR-057 POS devices: tablets, web app and mobile app from one codebase — Accepted (Q-16)

- **Decision (Q-16):** the point of sale runs on **tablets, in the browser
  (web app) and on phones (mobile app)**.
- **How:** one responsive, installable web app (PWA) for the cashier screens:
  tablet layout first, phone layout for waiters and small counters, and the
  same pages in a desktop browser. It works offline with a local order queue
  that syncs idempotently when the connection returns (POS1c).
- **App stores:** iOS and Android apps are the same web app wrapped with
  Capacitor (POS1d), so there is one codebase and no feature drift. Building
  and publishing them needs Apple and Google developer accounts and a
  macOS / Android build machine, which this environment does not have; the
  wrapper is added and tested when those exist.
- **Printing (default until told otherwise):** 80 mm receipts printed from
  the browser print dialog; direct ESC/POS printing and cash drawers come with
  the native wrapper or a print bridge, tested on real hardware first.

### ADR-058 POS menu — Accepted (POS1a)

- **Menu categories** and **menu items** (code, names, category, order, VAT
  code). An **item** uses exactly one active **dish recipe** (its
  ingredients are used from stock when sold) or one **stock product** (with a
  quantity in its base unit, default 1). A **combo** is made of items (one
  level: no combo in a combo) and has its own price. Database CHECKs hold
  these rules too.
- **Prices** per **channel** (dine-in, takeaway, delivery), optionally per
  **branch**, from a date; append-only (trigger), entered including or
  excluding VAT according to the organization's setting at the time. The
  price in effect is the branch's own, else the all-branches one; no price on
  a channel = not sold there. Kept apart from recipe prices, which drive the
  food-cost report (ADR-032).
- **Modifier groups** (choose at least / at most) with **options**: a price
  change (may be negative; the line never goes below zero) and optionally a
  recipe or product used per option (quantity required).
- An item can be **withdrawn at a branch** (not offered or sold out) or
  archived everywhere. `menuForBranch` gives what a branch sells on a channel
  today, for the cashier app.
- Permissions: `menu.view` (organization-wide read, like recipes) and
  `menu.manage` (admins and operations managers).

### ADR-059 POS selling — Accepted (POS1b)

- **Registers** belong to a branch and use one of its warehouses for stock.
  A register has at most one **open shift** (unique index); the shift has an
  opening float, cash in / cash out with a reason, and is closed by counting
  the drawer: expected cash = float + cash sales − cash refunds + cash in −
  cash out; the difference is recorded. The shift page is the **X report**
  while open and the **Z report** once closed (sales by channel and method,
  VAT, voids, refunds, cash).
- **Orders** are counter service in POS1b: the device submits a complete,
  paid order. Its **id is generated on the device**, so a retry after a lost
  response returns the same order and never charges twice (the base for the
  offline queue, POS1c). Tabs, tables and kitchen tickets are POS2.
- The server **recomputes every price** from the menu (ADR-058) on the
  order's business date in the branch's time zone, checks options against
  their groups, and refuses the order if the total the cashier saw differs
  (`ORDER_PRICES_CHANGED`). An order time from the device must fall within
  the open shift.
- **VAT per line**: the item's code, else the recipe's, else the default sales
  code, at the rate on the business date; none when the organization is not
  registered. Base currency only (Q-11).
- **Payments**: cash (cash received ≥ amount, change recorded) or card
  ("external terminal" until POS3); payments must equal the total exactly.
- **Stock**: dish recipes are exploded per portion, products by their
  quantity, combos per component, options by their recipe or product, then
  used FEFO from the register's warehouse through a CONSUMPTION document. A
  sale is **never refused for missing stock and stock never goes negative**:
  what the system does not show on hand becomes a **shortfall**, listed under
  needs attention and posted from the shortfall page once the stock is
  recorded (its cost is then added to the order). A recipe without an active
  version, or one that cannot be exploded, refuses the sale.
- **Void**: `pos.void`, only while the order's shift is open and before any
  refund; the stock it used goes back (reversal of its documents, including
  shortfalls already posted), open shortfalls are cancelled. Voiding reverses
  inventory documents, so a custom role with `pos.void` also needs
  `inventory.view` at that warehouse (all system roles with `pos.void` have
  it).
- **Refund**: `pos.refund`, by line and quantity, paid from an open shift at
  a register of the same branch, cash or card, with a reason. Amounts are
  proportional to the line (the last part takes the remainder, so a line
  never refunds more than it charged). Food is not returned to stock.
- Sales records are fixed in the database: an order may only change its
  status, void and refund fields and cost; lines only their refunded
  quantity; payments, refunds and cash movements are insert-only; CHECKs
  hold the money arithmetic.
- **Reports**: POS sales count in the food cost report (orders by business
  date; net less refunds) and in the VAT summary (refunds reduce output VAT
  in the period they are paid).
- **Receipts** print from the browser at 80 mm (ADR-057). A receipt shows the
  VAT number and "simplified tax invoice" when registered, but it is **not a
  ZATCA or ETA e-invoice**: QR codes, signing and clearance are POS4.
- Permissions: `pos.sell`, `pos.void`, `pos.refund`, `pos.view` (scopable to
  a branch) and `pos.manage` (registers). A new **Cashier** role has
  `pos.sell` and `menu.view`; cashiers use the register's warehouse stock
  through `pos.sell` without being able to browse inventory.

### ADR-060 Cashier app offline — Accepted (POS1c)

- **Installable web app** (ADR-057): a web app manifest (standalone, icons
  including a maskable one) and a service worker, so the app installs from
  the browser on tablets, phones and desktops. Store apps remain POS1d.
- **Service worker scope is deliberately small**: build files
  (`/_next/static`, content-hashed) cache-first; the till page
  (`/o/…/pos/registers/…/sell`) network-first with the last copy used when
  offline; manifest and icons. Every other page and every API call goes to
  the network as usual. Cached till pages hold the menu and register name,
  never sales; they are deleted on the sign-in page (after sign-out).
- **Every paid order is saved on the device first** (IndexedDB) and then
  sent to `POST /o/<org>/pos/sync`; it leaves the device only when the
  server has it (or answers that it already does). Without a connection the
  cashier keeps selling; the screen shows online/offline, how many orders
  wait, and sends them oldest first every 15 s, when the connection returns
  or on "Send now". The device-generated order id makes every resend safe.
- The sync endpoint is a route handler, not a Server Action, so queued orders
  still send after a new version is deployed (and native apps can use it,
  POS1d). It uses the session cookie and accepts only same-origin JSON
  requests (Origin check and JSON content type) — a cross-site form can send
  neither.
- **Priced as the till saw it**: the device sends the time its menu was
  loaded (`menuAsOf`); prices created after it, and items, options,
  categories and modifier groups withdrawn after it, do not apply to that
  order. The menu time must fall within the order's shift (not before it
  opened, not after the order), so an old menu cannot be replayed to get old
  prices. The till reloads its menu every 5 minutes while idle.
- **Orders belong to the shift they were taken in**: the device sends its
  shift. An order taken before the shift closed but sent after is still
  recorded in that shift; the Z report keeps the expected cash recorded at
  the close and lists "orders sent after closing" and their cash separately,
  which explains the cash difference. An order timed after the close is
  refused. The register page warns when the device still holds orders for
  that register before the shift is closed.
- **Only the person who took the order sends it**: queued orders carry the
  cashier's user id; under another person's session they are not sent (the
  server also refuses them) and wait for that cashier to sign in again. A
  signed-out device keeps everything.
- **Refused orders are never dropped silently**: an order refused on its
  first send (nothing recorded) returns to the cashier with the reason, as
  before. One refused later (e.g. sold offline after the shift was closed
  elsewhere) is listed on the till with the reason, to retry or — after
  confirmation — discard.
- Not in POS1c: printing a receipt for an order still on the device (it can
  be printed once sent); background sync while the app is closed; stock and
  shortfalls are posted when the order reaches the server, not when it was
  sold; tax rates are taken by date only (a rate added later for the same
  day would apply).

### ADR-061 Store apps — Accepted (POS1d)

- **Capacitor 8 shells for Android and iOS** in `mobile/` (its own package
  and lockfile; the web app's dependencies are untouched). They load the
  hosted web app (`MOBILE_SERVER_URL`, https only) instead of bundling it:
  one code base, every deployment reaches the apps at once, and the POS1c
  service worker keeps the till offline. A bundled copy would need
  server-rendered pages to work without a server, which they do not.
- Capacitor rather than a Trusted Web Activity: one tool for both stores and
  room for native plugins the POS will need (receipt printers, cash drawer,
  card terminals — POS3).
- **iOS**: the web app's host is the app-bound domain
  (`WKAppBoundDomains`, `limitsNavigationsToAppBoundDomains`), which WKWebView
  requires for service workers. **Both**: only the web app's host opens
  inside the app; https only; no mixed content; web view debugging off.
- **Per build, never committed**: server URL, app id (permanent once
  published), version code/name. Placeholders (`app.example.invalid`,
  `com.example.foodambassador`) make debug builds possible; release builds
  refuse them.
- If the web app cannot be reached and nothing is cached, the app shows an
  offline page (English and Arabic) with "Try again".
- The apps add `FoodAmbassadorApp/1` to the user agent. The web app uses it
  for display only (never for access decisions): print buttons say where to
  print, because in-app web views have no print dialog.
- CI builds an Android debug APK and an unsigned iOS simulator build on every
  change under `mobile/`. Signing and store upload need the organization's
  developer accounts (docs/MOBILE_RELEASE.md) and are not automated yet.

### ADR-062 Tables and checks — Accepted (POS2a)

- POS2 is split: **POS2a floor and tables** (this ADR) and **POS2b kitchen
  display** (stations, routing, bump times, ready status).
- **Floors** belong to a branch and name the warehouse their kitchen uses;
  **tables** sit on a floor's grid (column, row) with a seat count. Set up
  with `pos.manage`.
- A **check** (tab) is opened at a free table (one open check per table,
  unique index) or with a name and no table (bar, pick-up). Waiters
  (`pos.tables`, new **Waiter** role) add items with seat, course (1–9),
  note and "hold"; **send** sends every unsent item not on hold; **fire
  course N** sends that course's items. Unsent items can be changed or taken
  back; a **sent item cannot change** (database trigger) — it is **voided**
  with a reason (`pos.void`), and what it used is **written off** as
  "prepared, not sold" (a WRITE_OFF in the stock ledger, so it shows with
  waste). Seats and notes may change until paid.
- **Paying** (`pos.sell`, at a register with an open shift in the check's
  branch) records an ordinary order (ADR-059) through the same engine, so
  prices, VAT, stock use, receipts, voids, refunds and reports are unchanged;
  order and order lines keep the check and check line they paid. Stock is
  used at payment, from the floor's kitchen warehouse. Ways to pay:
  everything left; chosen items and quantities; one seat's items (several
  receipts); split evenly = one order with several payments that add up to
  the cent. The check closes when every item not voided is paid. A retry
  with the same order id returns the same order and pays nothing twice.
- Prices: a check shows today's menu price; the order is priced when paid
  (and refused if the total changed since the screen was loaded).
- **Move** a check to a free table; **merge** a check into another of the
  same branch before anything is paid (guests added, items renumbered);
  **cancel** a check nobody paid once no sent item remains.
- Checks need the server (shared across devices); they are not queued
  offline like counter sales (ADR-060). The floor plan and the check screen
  refresh by themselves.

### ADR-063 Kitchen display — Accepted (POS2b)

- **Stations** per branch (code, name, target minutes 1–240, sort order);
  at most one **default** station per branch (partial unique index). Set up
  with `pos.manage`.
- **Routing**: a menu **item** route wins over its **category** route, which
  wins over the branch's default station; with none, the item makes no
  ticket (e.g. drinks served from the bar without a screen). One route per
  category and per item at a branch; setting a new one replaces the old.
- **Tickets** are created in the same transaction as the event that puts
  food in the kitchen: **sending** check items (ADR-062) and **paying a
  counter order** (ADR-059 — including orders sent later from an offline
  till, ADR-060, which reach the kitchen when they sync). One ticket per
  station per event; items keep name, quantity, options, note, seat and
  course as sent. Paying a check makes no ticket (its items were sent).
- Items **voided** after reaching the kitchen (a check item, or a voided
  counter order) stay on the ticket struck through, so the cook stops.
- **Kitchen screen** per station (`pos.kitchen`, new **Kitchen** role):
  open tickets oldest first, refreshed every 5 seconds; each shows the time
  waited against the station's target — warning from 75 %, late at the
  target. **Bump** marks a ticket ready (a second tap does nothing);
  **recall** brings the last bumped ticket back.
- **Status back**: a check item is "preparing" until every ticket holding
  it is bumped, then "ready"; the floor plan shows how many tickets each
  table has in the kitchen; the register's order list shows preparing or
  ready for counter orders.
- **Preparation times**: sent to bumped, per station — count, average,
  90th percentile and late tickets over the last 24 hours on the station's
  screen.
- Not in POS2b: a "served" step, item-level bumping, kitchen printers
  (needs hardware, Q-16), and push updates (screens poll).

### ADR-064 ZATCA e-invoicing for the point of sale — Accepted (POS4a; validation pending)

- **Q-17 decided: Saudi Arabia is the first market**, so POS4 builds ZATCA
  Phase 2 ("integration phase") first. POS4a covers **simplified** (B2C)
  documents from the point of sale; standard (B2B) invoices and clearance
  are POS4b.
- **Receipts** of an organization registered for VAT in Saudi Arabia carry a
  **QR code**: Phase 1 (seller name, VAT number, time, total, VAT as
  tag-length-value, base64) until the register's unit is onboarded, then the
  Phase 2 QR of the signed document (adds hash, signature, public key and
  the certificate's signature). The Phase 1 encoding reproduces ZATCA's
  published guideline example byte for byte.
- **One e-invoicing unit (EGS) per register**: a secp256k1 key (sealed with
  AES-256-GCM, never leaves the server) and a CSR with ZATCA's extensions
  (certificate template per environment; SN, VAT number, invoice types
  "0100", address, business category). Onboarding with the portal's OTP:
  compliance CSID → compliance checks with a signed sample invoice, credit
  note and debit note → production CSID. Each step is saved so a failure
  can be retried.
- **Documents**: once a unit is active, every paid order gets a signed
  **simplified tax invoice** (388), and every refund or void a **credit
  note** (381) referencing the invoice with the reason — in the same
  transaction. UBL 2.1 XML written directly in canonical form; invoice hash =
  SHA-256 of the document without UBL extensions, signature reference and
  QR; ECDSA over the hash bytes; XAdES signed properties; invoice counter
  (ICV) and previous-invoice hash (PIH) chained per unit with the unit row
  locked. Documents are immutable and never deleted (triggers).
- **Reporting** within 24 hours: `pnpm zatca:report` (scheduled) or "Report
  now"; 200 reported, 202 reported with warnings, 400 rejected (ZATCA's
  answer kept for review), anything else retried with backoff.
- Requires VAT registration in Saudi Arabia and the **Saudi riyal as base
  currency** (base currency is fixed, Q-11); otherwise refused.
- **Validation status**: the development environment's network policy
  blocks `gw-fatoora.zatca.gov.sa`, so nothing has been sent to ZATCA yet.
  Verified here: the Phase 1 QR against ZATCA's example, the CSR with
  OpenSSL (`req -verify`), signatures with the public key, and the
  application's flows against a simulated ZATCA. To verify before live use:
  the hash and signed-properties digest as ZATCA's validator computes them,
  line amounts and rounding rules (BR-KSA), exemption reason codes for
  zero-rated or exempt items, and the API responses. Use the developer
  portal or simulation environment until then.

### ADR-065 Card payments and settlement reconciliation — Accepted (POS3a)

- POS3 is split: **POS3a** (this ADR) needs no payment provider; **POS3b**,
  the terminal or gateway connection (payment sent to the terminal, result
  back, provider refunds), waits on **Q-15** (provider and terminals per
  market).
- **Card details** may be recorded on a card payment from the terminal slip:
  scheme (mada, Visa, Mastercard, American Express, other), terminal ID,
  approval code and the **last 4 digits only** — a database CHECK refuses
  anything else, so a full card number can never be stored (no card data in
  scope of PCI DSS). None of these are allowed on cash payments.
- **Tips** on card payments are charged on top of the order: they are not
  sales and carry no VAT; the shift report shows them separately (owed to
  staff). Cash tips are not recorded.
- Card **refunds** may record the terminal's refund reference.
- **Settlement reconciliation** (`payments.manage`): finance imports the
  acquirer's settlement file (CSV: date, approval code, amount; optional
  terminal and fee; up to 2 MB; the same file cannot be imported twice).
  Each settled line is matched to an unsettled card payment with the same
  approval code, the same terminal when both are known and within 2 days:
  equal amount (sale share + tip) = matched, otherwise "different amount";
  no candidate = "no such sale". A payment is paid out once (unique index).
  The period report shows card sales, tips, settled amount, fees,
  differences and card payments not settled (flagged after 3 days).

### ADR-066 Payments in Saudi Arabia: terminals by acquirer, pay-by-QR with Moyasar — Accepted (POS3b; Moyasar validation pending)

- **Q-15 decided (Saudi Arabia)** on the user's instruction to choose what
  fits best:
  - **In-store cards** use the mada terminal the merchant gets from its own
    bank or acquirer, recorded on the till with the slip's details (POS3a,
    ADR-065). This works with every Saudi bank now. A direct terminal (ECR)
    integration is added for the acquirer a restaurant actually uses (for
    example Geidea or the bank's provider) once its ECR specification and a
    test terminal are available — these protocols are per acquirer and not
    public, so none is built speculatively.
  - **Pay by QR at the table** (and later online ordering, POS5) uses
    **Moyasar**: Saudi, SAMA-licensed, mada, Apple Pay, STC Pay and cards,
    free sandbox, REST API with amounts in halalas.
  - **SoftPOS** (tap to pay on the Android app) is an option for later.
- Each organization saves its own Moyasar **secret key** (test `sk_test_` or
  live `sk_live_`, checked against the mode), sealed with AES-256-GCM and
  never shown again (`org.settings.manage`).
- On a check, "Pay by QR" creates a Moyasar invoice for everything left or
  chosen items (the server prices them and refuses a changed total), shows
  its QR and link, and checks it every 4 seconds. When Moyasar reports it
  paid — with the amount the link asked for — the payment is recorded on
  the check as a card payment (scheme and last 4 digits from Moyasar,
  reference `moyasar:<payment id>`) through the same check payment (ADR-062),
  with the order id fixed on the link so it is recorded once. A different
  amount or a payment that cannot be recorded keeps the reason on the link
  for a manager. An unpaid link can be cancelled here (the guest must not
  use it).
- **Validation status**: `api.moyasar.com` is blocked by the development
  environment's network policy; the client follows Moyasar's invoices API
  and is tested against a simulated Moyasar. Test with a Moyasar test key
  before going live.

### ADR-067 Discounts, promotions and coupons — Accepted (POS5a)

- **Promotions** take a percentage off chosen menu items or categories,
  optionally by channel, ISO weekday, a local time window at the branch
  (an end before the start runs past midnight) and dates. When several fit
  an item, the highest percentage applies; promotions do not stack.
- A promotion is **never edited, only archived** (database trigger): tills
  queue orders offline priced with the promotions they had loaded, so the
  server applies the promotions that were live at the order's `menuAsOf`
  (created before it, not archived before it), at the time each item was
  ordered — the order time at the counter, the time the item was added on a
  check (a happy hour still applies when the check is paid later).
- **Order discounts** come off the whole order after promotions: a
  **manual** percentage or amount needs the new permission `pos.discount`
  (administrators, operations and branch managers) and a reason; a
  **coupon** code (percentage or amount, dates, optional maximum uses) can
  be used by any cashier. One order discount per order; an amount larger
  than the order is capped at the order.
- The order discount is spread over the lines in proportion to what is left
  of each after its promotion (the last line takes the rounding), and each
  line's VAT is taken out of its discounted amount: VAT is charged on what
  the guest pays. Stored per line (`discount_amount`, `promotion_id`) and
  per order (`promo_discount`, `order_discount`, reason, coupon). Refunds,
  credit notes and the ZATCA invoice use the discounted line amounts
  (invoice line price = discounted net ÷ quantity).
- An order discounted to nothing takes **no payment** (it still uses stock,
  goes to the kitchen and is counted in the shift); any other order still
  needs payments equal to its total.
- The same pure rules (`modules/pos/discounts.ts`) run on the till and the
  server, so the till shows the total the server charges; a till that
  crosses a promotion's start or end between showing and paying is told to
  check the new total.
- Coupons are **checked online** when the cashier applies them and taken
  (locked, use counted) inside the order's transaction; codes are not sent
  to devices in advance. An order queued offline with a coupon that is used
  up by the time it syncs is refused and listed for the cashier.
- Pay by QR (ADR-066) applies promotions but no order discount.
- Shift X/Z reports show promotions and order discounts given.

### ADR-068 Customers, loyalty points and gift cards — Accepted (POS5b)

- A **customer** is a guest who gave a phone number (E.164; Saudi numbers
  may be typed as 05…). Cashiers find a customer by the exact number and
  may add one at the till (`pos.sell`); the customer list, edits, point
  corrections and erasure need `customers.view` / `customers.manage`
  (administrators, operations and branch managers, organization-wide).
- **Consent (PDPL):** agreement to receive offers is asked, never assumed,
  and stored with its time. **Erasure** removes name, phone and email for
  good and sets the points to zero; orders and the points ledger stay,
  anonymous. Audit entries record no personal data.
- **Loyalty** (one setting per organization): points per unit of currency
  paid (after discounts, whole points), the value of a point, and a minimum
  to spend. Points are kept in an insert-only ledger; the customer's
  balance is the sum and never below zero. Spending points is the order's
  discount (an amount off, exclusive with a coupon or manual discount), so
  VAT is charged on what the guest pays — to be confirmed with the
  customer's tax adviser before go-live. A void returns spent points and
  takes back earned ones; a refund takes back the refunded share of what was
  earned. Points already spent are not taken below zero.
- **Gift cards** are stored value, a liability: selling one is not a sale
  (no VAT, no stock) and its money is counted in the shift's cash or card
  totals; VAT is charged on the orders it pays for (multi-purpose voucher
  treatment — to be confirmed with the tax adviser). A card is spent as a
  payment (`GIFT_CARD`), alone or with cash or card; the balance is locked
  and checked in the order's transaction. A void puts the money back on the
  card; refunds are paid in cash or by card.
- The **code is a bearer secret**: 15 random digits and a Luhn check digit,
  shown once when sold, stored only as an HMAC-SHA256 with the integration
  key (so `INTEGRATION_ENCRYPTION_KEY` must not change once cards are sold)
  and the last 4 digits. Finance (`payments.manage`) sees the cards, what
  is owed on them, and can block a lost card. No expiry is applied (no
  rule was given).
- Customers, points, coupons and gift cards need the till **online**; such
  orders are sent at once and never queued on the device.
- ZATCA payment means: 48 card, 10 cash, 1 (not defined) when only gift
  cards paid or nothing was due.

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

| ID   | Question                                                                                                                                                                                                              | Needed by                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Q-01 | ~~Inventory valuation method~~ — **Decided:** moving weighted average per product × warehouse (ADR-021).                                                                                                              | M3                        |
| Q-02 | ~~Target launch markets~~ — **Decided for VAT:** Saudi Arabia, Egypt and the GCC (ADR-037). Still open: allergen/label rules and data residency per market.                                                           | M5 (labels), M8 (hosting) |
| Q-03 | Hosting provider and region / data-residency requirements.                                                                                                                                                            | M8 (pilot)                |
| Q-04 | ~~Purchase approval policy~~ — **Decided:** two branch approvals, then head office (ADR-049); configurable per organization.                                                                                          |
| Q-05 | ~~Foreign-currency supplier invoices~~ — **Decided:** USD, EUR, SAR, EGP and the GCC currencies with exchange rates; reported in the base currency (ADR-050).                                                         |
| Q-06 | Which POS / accounting systems do pilot customers use (for import formats and exports)?                                                                                                                               | M7                        |
| Q-07 | Is SSO (Google/Microsoft) or 2FA required for the pilot?                                                                                                                                                              | M1 (nice to know)         |
| Q-08 | ~~Attachments~~ — **Decided:** up to 3 MB per file, kept 3 years (ADR-051).                                                                                                                                           |
| Q-09 | ~~Over-receipt tolerance~~ — **Decided:** 0 % (ADR-023); still configurable per organization.                                                                                                                         |
| Q-10 | Which email provider should send invitations, password resets and notifications? Until then there is **no self-service password reset**.                                                                              | M2 (before pilot)         |
| Q-11 | ~~Changeable base currency~~ — **Decided:** fixed at creation; documents in other currencies are converted to the base currency for all reporting (ADR-050).                                                          |
| Q-12 | ~~Count approval~~ — **Decided:** stock counts use the approval matrix like purchase orders, by value of differences; counter never approves (ADR-049).                                                               |
| Q-13 | Product categories — **default in place** (ADR-025): flat list, optional per product. Confirm, or ask for a hierarchy.                                                                                                | M3                        |
| Q-14 | ~~Scope versus Foodics~~ — **Decided:** option C, full point of sale in scope (ADR-022, milestones POS1–POS5).                                                                                                        | —                         |
| Q-15 | ~~Payment provider and card terminals~~ — **Decided for Saudi Arabia:** acquirer mada terminals recorded on the till (ECR integration per acquirer when known), pay by QR with Moyasar (ADR-066). Other markets open. | POS3                      |
| Q-16 | ~~POS devices~~ — **Decided:** tablets, web app and mobile app from one installable web app; store apps by wrapping it (ADR-057). Printers: 80 mm via the browser until hardware is chosen.                           |
| Q-17 | ~~First market for live POS sales~~ — **Decided:** Saudi Arabia; POS4 builds ZATCA Phase 2 first (ADR-064).                                                                                                           | POS4                      |
| Q-18 | ~~Delivery platforms~~ — **Decided:** HungerStation, Jahez and Keeta first, through one plug-and-play adapter design so any platform with the same concept is added as an adapter (POS5c).                            | POS5                      |
| Q-19 | Store apps: the app id (permanent once published, e.g. `com.<company>.foodambassador`) and who owns the Apple and Google developer accounts (organization enrolment). Needed before the first store upload (ADR-061). | POS1d release             |
