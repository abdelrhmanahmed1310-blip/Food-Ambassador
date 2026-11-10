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

### ADR-069 Delivery platform orders: plug-and-play adapters — Accepted (POS5c; native adapters pending platform specifications)

- **Q-18 decided:** HungerStation, Jahez and Keeta first, and any platform
  with the same concept through the same design.
- **What is public:** HungerStation's partner API and Jahez's integration API
  are given to integrators on request (Delivery Hero integration team;
  integration@jahez.net); Keeta publishes an Open Delivery–based API whose
  credentials follow an NDA. None of them could be read or tested from the
  development environment, so **no platform payload format is invented**.
- **Design:** a delivery connector (one per platform and register) receives
  signed, idempotent requests at its inbound address (ADR-048 checks,
  shared with the sales webhook). An **adapter** per platform turns the
  request into **canonical events** (`order.placed`, `order.cancelled`;
  docs/DELIVERY.md). Today every platform uses the canonical format —
  directly, or through integration middleware that many restaurants already
  use. A native adapter is one file implementing `parse` (and the platform's
  signature check) from its specification; it is marked native only after
  testing against the platform's sandbox. Everything after the adapter is
  shared.
- **Item mapping:** platform item ids → menu items, modifier ids → modifier
  options, per connector (`menu.manage`). An order with unmapped ids waits
  as NEEDS_MAPPING and lists them; mapping moves it to PENDING.
- **Accepting** (cashier with `pos.sell` at the register's branch, or
  automatically when set and possible) records a POS order whose id is the
  delivery order's (retry-safe): channel DELIVERY, the **platform's prices**
  (VAT included; our promotions do not apply), the restaurant-funded
  discount as the order discount, one payment `DELIVERY_PLATFORM` with the
  reference `<platform>:<order id>`, a kitchen ticket labelled with the
  platform and its code, stock, VAT and ZATCA as any order. Devices can
  never send a platform payment. A total that does not equal the items less
  the discount is refused with its reason. Rejecting needs a reason.
- **Cancellation by the platform** closes a waiting order, voids an
  accepted one while its shift is open, and otherwise marks it for a
  manager to refund.
- **Privacy:** only a first name or label is kept for the counter; no phone
  or address is stored.
- Platform money is shown apart in the shift report (owed by the platforms,
  not cash or card). ZATCA payment means for such orders: 1 (not defined) —
  to confirm when ZATCA validation runs.
- Not yet: telling the platform that an order was accepted, is ready or was
  rejected (needs each platform's API — a native adapter — or the
  middleware); menu sync to platforms; reconciliation of platform payouts.

### ADR-070 Online ordering and self-order kiosks, paid at the counter — Accepted (POS5d)

- An **ordering channel** is a public page for one branch with an
  unguessable address: a **web** page for pick-up (take away, or delivery by
  the restaurant) or a **kiosk** in the restaurant (eat in and/or take
  away). Set up by `pos.manage`; orders are placed under the creator's
  access (they must be able to open checks there), like connectors.
- A guest's order becomes a **named check** at the branch (source WEB or
  KIOSK, the guest's name, and for the web a mobile number to reach them).
  Prices, options and VAT always come from the server; an order larger than
  the page's limit, an item not on sale, or a channel the page does not take
  is refused and leaves nothing behind. A resend with the same key returns
  the same order.
- Staff see open guest orders (`pos.tables`): **accept** sends the items to
  the kitchen; **reject** cancels the check with a reason the guest sees. A
  channel may send orders to the kitchen at once (typical for kiosks).
- **Payment is at the counter**, as for any check (cash, card, gift card,
  pay by QR). Paying online before ordering waits until Moyasar is
  validated (ADR-066).
- The guest follows the order on a **status page** of its own (another
  unguessable address): received → preparing → ready (kitchen bumped) →
  collected, or cancelled with the reason.
- **Abuse limits:** 5 orders per 10 minutes per address on the web (60 on a
  kiosk), 300 per channel; a maximum order total per page; closing a page
  stops its address.
- **Privacy:** the guest's phone is kept only while the order is open and
  cleared when the check is paid or cancelled.

### ADR-071 Guest orders: online prepayment, pick-up times, promotions shown, manual ready — Accepted (POS5e; Moyasar validation pending)

- **Payment mode per page:** at the counter, online before ordering, or
  the guest's choice. Online payment uses the organization's Moyasar key
  (ADR-066) and a register whose open shift records it. The Moyasar invoice
  carries the guest's status page as its return address and expires after
  30 minutes.
- **The kitchen starts only after the payment is confirmed with Moyasar
  by the server** (the invoice is read back from Moyasar's API; the guest's
  return to the page proves nothing). It is then recorded once on the check
  as a card payment, and — if the page sends orders at once — goes to the
  kitchen; otherwise staff accept it.
- **Unpaid orders expire** after 30 minutes and are cancelled. An order
  whose payment reached Moyasar but could not be recorded (no open shift,
  another amount) is **never expired**: staff see the reason.
- A paid online order cannot be rejected: it is voided and refunded
  (refunds through Moyasar's dashboard until refunds are integrated).
- **Pick-up times:** a page may offer slots within its opening hours
  (local time at the branch, past midnight allowed), every 5–60 minutes,
  at least the preparation time from now, today or up to 7 days ahead; "as
  soon as possible" is offered while open. The server accepts only an
  offered slot (5 minutes' grace). Accepted orders for later are **held**
  and released to the kitchen at their preparation time before pick-up.
- **Fulfilment is separate from payment:** received → (scheduled) →
  preparing → ready → collected. Ready comes from the kitchen screens when
  every ticket is bumped, or from staff ("Ready") where there are none.
  An order paid at the counter is collected when paid; one paid online is
  marked handed over by staff. The guest's phone is cleared at hand-over.
- **Promotions on the guest page** use the same rules as the till and the
  check (ADR-067), at the time of ordering, so the guest sees the price the
  counter charges.
- Not yet: a Moyasar webhook (payments are confirmed when the guest
  returns or the staff list refreshes), refunds through Moyasar, slot
  capacity limits, SMS/WhatsApp notices.

### ADR-072 ZATCA standard (B2B) tax invoices with clearance — Accepted (POS4b; ZATCA validation pending)

- Sales invoices to businesses (B2B, ADR-044) are **standard tax
  invoices** in Saudi Arabia: each is sent to ZATCA for **clearance**, and
  ZATCA's cleared, stamped document — with its QR — is the legal invoice
  given to the buyer. Simplified invoices (B2C, POS) stay reported
  (ADR-064).
- A **back-office e-invoicing unit** (one per organization, not tied to a
  register) issues them: its CSR declares standard invoices ("1000"), and
  onboarding signs three standard samples (invoice, credit note, debit
  note) with a clearly labelled sample buyer. Its counter and hash chain
  are separate from the registers'.
- E-invoicing starts when that unit is onboarded; invoices before stay as
  they were.
- **Buyer details** on the B2B customer: VAT number (or CR number when not
  VAT registered) and, for Saudi buyers, the national address (street,
  4-digit building number, district, city, 5-digit postal code). An
  invoice to a buyer with incomplete details is **refused** (nothing is
  invoiced), since ZATCA would reject it.
- The XML adds the buyer party, the supply date (the delivery), the
  standard type (0100000), and VAT in SAR: invoices in another currency
  carry the VAT total in SAR as well (BR-KSA-68), from the invoice's
  exchange rate (ADR-054).
- **The invoice date is the day of issue** while e-invoicing (ZATCA's issue
  date is the moment of issue); backdated invoices are refused.
- Clearance runs right after invoicing; if ZATCA does not answer, the
  scheduled job retries with back-off ("Clear now" retries at once). A
  rejected invoice keeps ZATCA's messages and must be cancelled and
  reissued; the page says when an invoice is not cleared yet.
- A **cancelled** e-invoiced invoice is corrected by a standard credit note
  (cleared the same way); invoices are never deleted.
- Not yet: debit notes and partial credit notes for B2B (price corrections),
  and clearance switched off by ZATCA (HTTP 303 "reporting only") — handled
  as a retry today.

---

### ADR-073 Optional two-step sign-in with an authenticator app — Accepted

- Any user can turn on **two-step sign-in** (TOTP, RFC 6238: 6 digits,
  30 seconds) on _Security_ (`/account/security`). It is per user, not per
  organization: one sign-in reaches every organization the user belongs to.
  The setting is optional for now (Q-07); an organization-wide "required"
  switch can be added on top later.
- Built on Better Auth's `twoFactor` plugin. Turning it on needs the
  password; it takes effect only after the first code from the app is
  confirmed, so a mistyped setup cannot lock the user out.
- **Ten backup codes** are shown once at setup; each works once, in place of
  a code, when the phone is lost. Turning it off needs the password.
- Sign-in with the password then asks for a code before a session is made
  (`/sign-in/two-factor`). Code checks are rate-limited per IP (our counter
  and Better Auth's), and Better Auth locks the account's codes after
  repeated failures.
- The TOTP secret and backup codes are stored **encrypted** with the auth
  secret in `two_factors`, which the tenant role (`fa_tenant`) cannot read.
- Not covered: password reset still waits for an email provider (Q-10), so a
  user who loses both phone and backup codes is reset by an operator.

### ADR-074 Strict Content Security Policy with per-request nonces — Accepted

- Every page response carries a CSP whose `script-src` is
  `'self' 'nonce-<random>' 'strict-dynamic'`: only scripts carrying that
  request's nonce run, and they may load the app's own chunks. Inline event
  handlers, injected `<script>` tags in markup and `eval` (production) are
  refused, so an HTML-injection bug cannot run code.
- `src/proxy.ts` makes a fresh 128-bit nonce per request and sets the policy
  on the request (Next.js reads the nonce from it and stamps its own
  scripts) and on the response. All pages render per request already
  (ADR-004), so nothing is cached with a stale nonce.
- Other directives: `default-src 'self'`, `img-src 'self' data: blob:` (QR
  codes drawn in the browser), `connect-src`/`worker-src 'self'` (service
  worker, ADR-060), `object-src 'none'`, `frame-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `upgrade-insecure-requests` (production).
- Styles keep `'unsafe-inline'`: React `style` attributes (floor plan,
  recipe indents) cannot carry nonces; style injection cannot run code.
- The development server adds `'unsafe-eval'` (React's error overlay).
- Routes with their own, stricter policy keep it: attachment downloads send
  `default-src 'none'; sandbox` (ADR-051), so the proxy does not set the page
  policy on them (it would replace theirs).
- The static error page (`_global-error`) has no nonce; it still shows, but
  its "try again" button needs a reload.

### ADR-075 Delivery platform payout reconciliation — Accepted

- Platforms pay restaurants in batches, net of commission and fees. Finance
  imports each **settlement statement** (POS → Delivery orders → Payouts)
  for one platform connection, with its reference (unique per connection),
  the order period, the payment date and, optionally, the amount that
  actually reached the bank.
- One **canonical CSV** for every platform: `order_id, description, gross,
commission, fees, vat_on_fees, net`. Platforms' own statement formats are
  partner-only, so they are not guessed: the platform's export is renamed to
  these columns. Rows for the same order (an order and a later refund) are
  added together; rows without an order are adjustments and need a
  description. Every row must add up (net = gross − commission − fees − VAT
  on fees, to the cent) or nothing is imported.
- Each line is **matched** with the order received: matches, amount differs
  (more than 0.01 from our recorded total), order not received, cancelled
  order, never accepted, already paid by another statement, or adjustment.
  The statement also lists **accepted orders of its period that no
  statement pays for** (period days in the organization's time zone), the
  effective commission rate and bank minus statement.
- **Confirming** matches again (another statement may have been confirmed
  since), marks the orders it pays as settled — an order is settled by at
  most one line, enforced by a unique index — and fixes the statement (a
  database trigger refuses changes and deletion). Drafts can be deleted.
- Permissions: import, confirm and delete with `payments.manage`; view with
  that or `invoices.view` (the Finance role). Organization-wide.
- Not yet: posting commission and VAT on fees to the accounting export, and
  native statement formats per platform (with partner specifications).

### ADR-076 Hosted demo on Render (Frankfurt) — Accepted (demo only)

- A **demo** instance runs on Render from `render.yaml` (a Blueprint): one
  web service (Node 22, `next start`) and a managed PostgreSQL 16, both in
  Frankfurt, the closest Render region to Saudi Arabia and Egypt. The
  database accepts connections from Render services only.
- Before each deploy Render runs the migrations and the idempotent `[DEMO]`
  seed. Render runs everything with `NODE_ENV=production`, where the seed
  refuses to run, so the Blueprint opts in with `ALLOW_DEMO_SEED=true`; the
  seed also requires `SEED_PASSWORD` then, so no well-known password is online. `AUTH_SECRET` and `SEED_PASSWORD` are generated by Render; the demo
  users' password is read in the service's Environment tab and is not
  written to the logs. `APP_URL` defaults to the address Render assigns.
- Rehearsed here on an empty PostgreSQL 16 server whose user owns the
  database without being a superuser (as on managed PostgreSQL): migrations,
  seed, health and readiness checks, sign-in and tenant isolation pass. Not
  yet run on Render itself. The migrations create the `fa_tenant` role, so
  the database user needs permission to create roles.
- **Memory (2026-11-05):** the web service runs on Render's Standard plan
  (2 GB). Measured here, the app server uses about 350–500 MB once
  serving pages and the demo seed about 430 MB, too close to Starter's
  512 MB. The start and pre-deploy commands call `node`, `prisma` and
  `tsx` directly (an `npx` or `npm` wrapper costs about 80 MB each), and
  the server's heap is capped at 1.5 GB.
- **Build memory (2026-11-05):** Render stopped a build at its 8 GB build
  limit; here the build peaked at 4.5 GB with Next's in-process TypeScript
  pass running beside compilation, and build workers grow with the
  machine's cores. Render now runs the full `pnpm typecheck` first as its
  own step (about 2 GB; a type error still fails the deploy), then
  `next build` with `LOW_MEMORY_BUILD=1` (`next.config.ts`), which skips
  only its duplicate TypeScript pass and uses two workers. Nothing is left
  out: source maps stay on and the app is the same build. Measured here:
  about 4 GB at peak for the whole sequence. On that build the full E2E
  run passed 98 of 101; the three (two sign-ups on the cold server, one
  till discount) pass on rerun, the discount one three times in a row. Local, CI and Docker builds are unchanged.
- **Not production.** No real customer data goes on the demo. Production
  hosting and data residency stay open (Q-03); attachments are not
  virus-scanned there (no ClamAV), and payment, ZATCA and delivery
  integrations stay unvalidated.

### ADR-077 Brand look: red, white and black, Supy-style shell — Accepted

- The interface follows the brand logo (`public/brand/logo-en.webp`, and
  `logo-ar.webp` in Arabic — the logo follows the interface language): crimson
  red (`--primary #a3151b`, lighter red in dark mode) for actions, links
  and the active page; black for the sidebar; white cards on a warm light
  grey. Colours are CSS tokens in `src/app/globals.css`, so the whole app
  changes from one place; danger stays a distinct, outlined red.
- Layout modelled on Supy: a full-height black sidebar with the logo on a
  white tile, icons per section (lucide-react) and collapsible groups (the
  group of the current page opens by itself), and a slim white top bar with
  the organization switcher, language, user, Security and Sign out.
  Phones keep the menu button and show Security and Sign out as icons
  (their names stay for screen readers).
- Shared components (cards, tables, badges, buttons, inputs) were
  restyled in place, so every page follows without page-by-page changes;
  no business logic changed. Right-to-left (Arabic) uses logical
  properties, so the sidebar moves to the right.

### ADR-078 Overview dashboard, touch-friendly POS and a demo restaurant — Accepted

- **Overview dashboard.** Above the existing counts, users who may see
  sales get: net sales today, orders today, average ticket today, net sales
  for the last 14 days, a bar chart of net sales per business day, and the
  five best sellers by net. Users who may also see stock value get food
  cost %, waste and discounts for the same 14 days (from the food cost
  report). All figures come from paid POS orders in the warehouses the user
  may see, refunds deducted on the order's day; days without orders are
  zero, and nothing is estimated. The chart is server-rendered SVG (no
  script, no chart library) with a hidden data table for screen readers;
  days run left to right in both languages.
- **Touch-friendly POS.** Larger item tiles with the price in red, press
  feedback and a badge with the quantity already in the order (hidden from
  the button's accessible name), 44 px quantity buttons, tiles that size
  themselves to the space (no overflow on tablets), and a narrower order
  panel on tablets. The sidebar marks only the closest page as current.
- **Demo restaurant.** The `[DEMO]` seed adds, to Gulf Catering, an Olaya
  burger branch (`RUH-BRG`): Saudi VAT (ZATCA's published sample VAT
  number), seven menu items with kit products and opening stock, a till
  with an open shift, a grill station, a dining room with eight tables, a
  drinks promotion, loyalty points, a pick-up ordering page, and eight
  sample orders taken through the real till services. Idempotent.

### ADR-079 HR area: HRIS first, then phased capabilities — Accepted (HR1 built)

- One **HR** tab holds the eleven HR capabilities. The HR overview shows,
  for each, whether it is available, partly available or planned (with its
  phase); nothing planned is shown as if it worked.
- **HR1 (built): HRIS.** Departments (optional parent), employees
  (automatic number EMP-00001 or the organization's own, names in English
  and Arabic, nationality, national ID / iqama, job title, branch,
  department, manager, employment type, hire date, optional link to a
  sign-in account), status active / on leave / left, and employee documents
  (iqama, national ID, passport, work permit, health certificate, driving
  licence, contract) with expiry states — expired, expiring within 30 days,
  valid. Org chart from the reporting line; reporting loops are refused;
  someone who still manages people cannot leave until they are reassigned;
  rehiring clears the termination. Employees need not be users.
- **Access:** `hr.view` and `hr.manage`, both grantable per branch (a branch
  manager sees their branch's staff). ID and document numbers are personal
  data: only `hr.manage` for the employee's branch sees them, and they are
  never written to the audit log. Tenant isolation as everywhere (RLS +
  organization filters).
- **Phases:** HR2 time and attendance, leave and approvals (HR
  automation), onboarding checklists; HR3 recruitment and workforce
  planning (positions per branch); HR4 payroll — only after the country
  rules are confirmed (Q-20); HR5 performance, engagement and learning
  (training and food-handler certificates); HR6 HR analytics across the
  modules.

### ADR-080 Time and attendance: every way of clocking in — Accepted (HR2a built)

- All clock-in methods work side by side and end as the same immutable
  **punch** (in or out, time, branch, source):
  - **Branch tablet**: a secret link per tablet (switchable off); staff
    enter their employee number and a 4–6 digit **PIN** (stored with scrypt,
    set by HR, never shown). Wrong number and wrong PIN look the same; five
    wrong PINs lock it for 15 minutes; taps are rate-limited per tablet and
    address. Only active employees clock in.
  - **Phone**: staff whose account is linked to their employee record use
    "My attendance". If the branch has a location and radius (20–5000 m),
    the phone must be inside it; only the **distance** is stored, never the
    coordinates. The site's permissions policy allows location for itself.
  - **Fingerprint or face devices**: a connector per device (signed webhook,
    ADR-048) posting `{"punches": [{id, employeeNumber, at, kind?}]}`;
    repeats are ignored by the device's id, unknown numbers are reported.
    Vendor formats (e.g. ZKTeco) need their specifications; not built.
  - **HR**: adds a missed punch with a reason, or voids a wrong one with a
    reason. Punches are never edited (database trigger); both are audited.
- A tap or punch without a kind alternates with the employee's previous
  punch. **Timesheets** pair punches into sessions per local day (a night
  shift counts for the day it began) and flag a missing clock-out or
  clock-in instead of guessing; today's open clock-in is not an issue.
- Access: `hr.view` sees the board and history; `hr.manage` (per branch)
  sets PINs, tablets, locations and devices, adds and voids punches.
- Next in HR2: rosters and shifts (lateness, overtime), leave with
  approvals, onboarding checklists.

### ADR-081 Leave with approvals — Accepted (HR2b built)

- **Leave types** per organization (code, names, optional country, paid,
  uses a yearly entitlement). "Add common leave types" adds annual, sick,
  unpaid, Hajj, maternity, paternity, emergency, bereavement, marriage and
  exam leave — names and paid flags only, all editable. **Entitlement days
  are never preset**: they depend on the law (Q-20 countries) and the
  contract, and HR sets them per employee and year.
- **Balance** = entitlement − approved − pending days (types that use an
  entitlement). Days are calendar days, both ends included; a request lies
  within one calendar year (split otherwise); overlapping pending or
  approved requests are refused; requests beyond the balance are refused.
- **Requests** come from the employee ("My leave", linked account) or from
  HR for an employee. **Approval**: the employee's direct manager through
  their own linked account, or `hr.manage` for the branch. **Nobody decides
  their own leave**, whatever their role. Dates, type and days never change
  after the request (trigger); only the decision does.
- **Cancelling**: the employee or HR while pending; HR also after approval
  as long as the leave has not started. Every step is audited.
- Not yet: working-day counting per country weekend and public holidays,
  half days, carry-over and accrual rules (need the policy), attachments
  such as sick notes.

### ADR-082 Enterprise layer: organization = group, companies = legal entities, brands — Accepted (F1a built)

- Decided by the owner (D1): an **organization** is the group (tenant: users,
  roles, shared master data); a **company** is a legal entity of the group
  (code, trading and legal names, country, VAT and CR numbers); a **brand**
  groups branches commercially. Every **branch belongs to one company** and
  may carry one brand.
- Each organization has exactly one **default company** (partial unique
  index); new branches join it when no company is chosen, so every existing
  flow keeps working. New organizations get one at sign-up. The migration
  created one per existing organization from its current tax settings
  (country, VAT number) and ZATCA settings (legal name, CR) — blank where
  unknown, never invented — and assigned every branch to it.
- A branch **stays with its company** (its documents will carry the
  company, F1b). Companies are archived only with no active branches and
  never while default; archiving a brand clears it from its branches.
- **F1a limit:** companies share the group's base currency, VAT settings and
  e-invoicing (ZATCA seller). **F1b** moves currency, VAT and ZATCA to the
  company and stamps money documents with their company, enabling e.g. a
  Saudi company in SAR and an Egyptian one in EGP in one group, with
  consolidated reporting.
- Managed with `org.settings.manage`; RLS and composite tenant keys as
  everywhere; all changes audited.

### ADR-083 Company on money documents — Accepted (F1b step 1 built)

- POS orders, purchase orders, goods receipts, B2B sales orders, sales
  invoices and supplier invoices carry `company_id`. The **database sets
  it** on insert from the document's site (branch, or warehouse → branch,
  or delivery → sales order), so no code path can forget it, and a trigger
  refuses any later change. Existing documents were backfilled.
- **Supplier invoices** have no site: the user picks the billed company
  (default company when not chosen). A supplier invoice matches only
  receipts and orders of its own company — checked by the service (clear
  message) and by a database trigger (defence in depth). The receipts
  offered for matching are filtered by the invoice's company.
- The overview dashboard filters by company (sales and cost figures from
  the same company's branches; "whole group" by default).
- Prisma declares the column optional so inserts can omit it; the database
  column is NOT NULL and always filled by the trigger.
- **Next (F1b step 2):** VAT settings and the ZATCA seller per company
  (POS and invoices use their company's). **Step 3:** per-company currency
  with group consolidation through the exchange-rate tables — its design
  will be presented before building.

### ADR-084 VAT per company — Accepted (F1b step 2a built)

- **Codes stay shared, rates are per country.** `tax_rates.country` tags
  each rate with the country whose companies use it; existing rates were
  tagged with the organization's VAT country. A rate's uniqueness is now
  (code, country, start date), so Saudi 15 % and Egyptian 14 % live under
  the same `STD` code.
- **Each company has its own VAT registration** (`companies.vat_registered`
  with its country and VAT number; a database check requires both when
  registered). A company can be registered only in a country with VAT in
  force, with a number in that country's format, and once that country's
  rates exist (apply its preset on the VAT settings page first).
- **The default company's registration is the VAT settings page's**: saving
  VAT settings updates it, and the companies page does not edit its VAT
  fields. Applying a second country's preset adds that country's rates and
  leaves the group's VAT country unchanged.
- **Every VAT calculation uses the document's company**: POS orders and the
  till's menu (branch → company), supplier invoice lines (billed company),
  B2B invoices (sales order's company), sales imports (warehouse's branch).
  Recipe food-cost pricing and supplier credit notes (no document
  company yet) use the default company. A company that is not registered
  charges no VAT. The POS receipt shows the selling company's VAT number.
- New rates take a country (default: the group's VAT country), so a rate
  change in one country never reaches another country's companies.
- **Step 2b** (ADR-085): ZATCA seller settings and units per company.
  **Step 3:** per-company currency (ADR-086).

### ADR-085 ZATCA per company — Accepted (F1b step 2b built)

- **Seller settings are per company.** `zatca_settings` is keyed by
  (organization, company): each company registered for VAT in Saudi Arabia
  has its own legal name, CR number, national address, business category
  and ZATCA environment. Existing settings moved to the default company.
  The form starts from the company's legal name and CR number.
- **Every e-invoicing unit belongs to one company** (`zatca_devices.company_id`,
  set by the database): a register's unit takes its branch's company; the
  back-office unit is made for a chosen company, **one office unit per
  company**. A unit never changes company (trigger). The CSR carries that
  company's legal name and VAT number.
- **Documents use their company's unit and seller:** POS invoices and
  credit notes sign on the register's unit with the branch's company as
  seller; B2B standard invoices clear on the office unit of the sales
  invoice's company. Each unit keeps its own counter and hash chain, so
  numbering and chaining are per company (and per register).
- **Receipts** before onboarding carry the Phase 1 QR with the selling
  company's name and VAT number.
- A company not registered for VAT in Saudi Arabia cannot have a unit.
  ZATCA still needs the Saudi riyal as base currency (per-company currency
  is step 3).
- The ZATCA page shows one company at a time (company selector when the
  group has more than one).

### ADR-086 Currency per company — Accepted (F1b step 3 built: 3a, 3b, 3c)

Design approved 2026-11-02. Stock transfers are between branches in the same
country for now, so no inter-company transfer is built.

- **Each company keeps its books in its own currency** (`companies.currency`,
  the group's by default; a supported document currency). It can change only
  while the company has no stock and no money documents (service rule and a
  database trigger).
- **The context knows both currencies**: `groupCurrency` (the
  organization's) and `baseCurrency` (the currency a service keeps amounts
  in — the group's, or a company's via `companyContext` / `inCurrency`).
  Exchange rates stay stored against the group currency; `rateFor` in a
  company's currency uses the cross rate through the group currency, with
  the same no-guess rules (missing or stale rates are refused).
- **Stock** is valued in the warehouse's company's currency (warehouse →
  branch → company) and never moves between companies with different
  currencies (service check and database trigger on transfers and
  shipments).
- **Purchasing and payables (3b)**: orders default to the supplier's
  currency, else the company's; receipts, landed costs and supplier
  invoices book base amounts in the company's currency. Payments, credit
  notes and customer receipts belong to a company (default when not chosen)
  and settle only that company's invoices (service and database). Supplier
  and customer balances are per company and currency, each row's base in
  its company's currency. The FX revaluation, the VAT return and the
  accounting journals are per company, in its currency. Purchase-order and
  stock-count approval limits are in the group currency, so the totals are
  converted before choosing the approval chain.
- **Sales (3c)**: the till, online ordering, checks, payment links, sales
  imports, B2B orders and invoices work in the branch's (or warehouse's)
  company's currency. A menu price for all branches and option price
  changes are in the group's currency, so a branch of a company in another
  currency sells at its own branch prices and does not offer options that
  change the price. Loyalty points and fixed-amount coupons are valued in
  the group's currency: they are not spent there, and purchases there earn
  no points. Gift cards are in the selling register's company's currency
  and spent only in that currency (service and database).
- **Group figures are converted, never guessed** (`currencyConverter`):
  balances at the rate on the date (stock value today, balances on their
  "as of" date), flows at the average of the period's rates (sales, cost,
  waste). A currency without a usable rate is left out and named on the
  page. One company's figures stay in its own currency (overview and food
  cost by company, one warehouse's valuation, per-company VAT and
  journals). Recipe costs are in the group currency.
- **ZATCA** needs the company's currency to be SAR (no longer the group's).
- **Known limits:** card settlement files and delivery payout
  reconciliation are organization-wide and assume one currency per file;
  the supplier "last price" is kept in the supplier's currency or, without
  one, as entered. Per-branch prices for modifier options and loyalty in
  several currencies are not built.

### ADR-087 Job runner and notification centre — Accepted (F2a built)

- **Jobs live in PostgreSQL** (`jobs`): no new infrastructure. A worker
  (`pnpm jobs:run`, every minute from a scheduler or `--watch`) first adds
  the recurring jobs that are due — webhook delivery every minute, ZATCA
  reporting every 10 minutes, the attachment purge daily, and each
  organization's attention digest once a day after 06:00 local time — then
  claims due jobs one at a time (`FOR UPDATE SKIP LOCKED`, so several
  workers can run), runs each outside the claim and records counts only.
  Dedupe keys make scheduling idempotent. Failures retry after 1 min, 5 min,
  30 min, 2 h, 12 h; when the attempts are used up the job is FAILED and the
  organization's administrators are notified. A job left RUNNING for 15
  minutes (a crashed worker) is queued again. The existing scripts
  (`integrations:deliver`, `zatca:report`, `attachments:purge`) still work
  on their own.
- **Notifications are written in the same transaction as the change**, so
  one exists exactly when its change does (an invoice exception, which is a
  refusal, is notified in its own transaction once per invoice).
  Recipients come from the same grants that let them act: approvers at the
  required level and site (the approval matrix), HR for the branch or the
  direct manager for leave, invoice managers for exceptions, administrators
  for failed jobs — never the person who acted. Kinds: purchase order
  waiting / approved / sent back, stock count waiting / posted or sent
  back, leave requested / decided, invoice exception, daily attention
  digest, job failed.
- **Each user chooses the kinds** they get (all on by default). The bell in
  the header shows the unread count; opening a notification marks it read
  (only the user's own) and goes to the record. Messages carry only values
  the recipient may already see (document numbers, dates, counts; an
  employee's name for their approvers).
- **In-app only.** Email, SMS and WhatsApp adapters wait for the provider
  decision (D2); nothing is sent outside the app.

### ADR-088 Global search — Accepted (F2b built)

- **One box in the header** (a search icon on small screens) opens the
  search page with results grouped by kind: products (SKU, English or
  Arabic name, barcode), suppliers, B2B customers (code, name, VAT
  number), guests (name or phone — "050 777 1234" finds +966507771234),
  employees (number, name, job title), recipes, menu items, lots,
  purchase orders, goods receipts, supplier invoices (our number or the
  supplier's), sales orders and invoices, POS orders and stock documents.
  Up to six hits per group, each linking to its page.
- **Same permissions as the pages**: a group is searched only when the
  user holds the permission its page needs, and documents and employees
  only at the branches and warehouses where they hold it. Row-level
  security keeps other organizations out as everywhere else.
- **In the database**: "contains" matching (case-insensitive) with
  PostgreSQL trigram indexes (`pg_trgm`) on the searched names, codes and
  numbers — no separate search service to run or keep in sync. Queries
  are 2–80 characters.
- Not built: saved filters / saved views (the audit's `saved_views`),
  ranking beyond "newest first / by code", search inside free text such
  as notes.

### ADR-089 Excel and PDF exports — Accepted (F2c built)

- **Excel from the same rows as CSV.** Every CSV export (products, stock,
  valuation, waste, food cost, payables and receivables documents and
  journals) can be downloaded as `.xlsx` (`?format=xlsx`, an "Excel"
  button beside each CSV link). The workbook is built from the CSV the
  export already produces, so the two can never disagree. Amounts and
  quantities become numbers; identifier columns (codes, SKUs, numbers,
  references, phones, VAT and account numbers) and values with leading
  zeros or more than 15 digits stay text. Import templates stay CSV.
- **PDF documents made on the server** (pdfkit, no browser): the purchase
  order for the supplier and the B2B sales invoice for the customer, with
  the issuing company's letterhead (its e-invoicing seller name, national
  address, VAT and CR numbers — ADR-082/085), the other party, details,
  lines, totals, notes and page numbers. They are read through the same
  services as their pages, so the same permissions apply. Where ZATCA
  e-invoicing applies, the cleared XML stays the legal invoice and the PDF
  is its readable copy (said on the PDF).
- **Arabic**: DejaVu Sans (redistributable, licence in `assets/fonts`) is
  bundled; pdfkit shapes Arabic and orders right-to-left words. Spaces
  between Arabic words are kept as no-break spaces (pdfkit drops plain
  ones), and a label and its value are separate cells — pdfkit misplaces
  punctuation and spaces when Arabic and numbers share a line. Page
  numbers are "1 / 2". Labels follow the user's language.
- Not built: PDFs of other documents (statements, receipts of goods,
  delivery notes) and scheduled report e-mails (need the email provider,
  D2). The existing print pages remain for everything else.

### ADR-090 REST API v1 — Accepted (F2d built)

- **Read-only, versioned** at `/api/v1`, described by a hand-written
  OpenAPI 3.1 document at `/api/v1/openapi.json` (a test checks that every
  described path is served). Resources: companies, branches, warehouses,
  products, suppliers, stock on hand, purchase orders (list and one),
  supplier invoices, B2B sales invoices and POS orders. Writes wait:
  every write in the system is audited against a named person, and API
  writes need that settled (who acts, approvals, idempotency) first.
- **API keys** (`api_clients`): created under Settings → API keys by
  people who manage integrations, with a name, read scopes
  (`sites:read`, `products:read`, `suppliers:read`, `stock:read`,
  `purchasing:read`, `invoices:read`, `sales:read`) and optionally one
  company. The key (`fa_<prefix>_<secret>`) is shown once; only the
  SHA-256 of the secret is stored, compared in constant time. Keys are
  revoked, never deleted; creation and revocation are audited; the last
  use is recorded (at most once a minute).
- **Same rules as the pages**: a key's scopes become read permissions;
  every query runs in the organization's row-level-security transaction;
  a company-limited key sees only that company's documents and sites.
  600 requests per minute per key (429 with Retry-After).
- **Contract**: JSON; amounts and quantities as decimal strings; dates ISO
  8601; cursor pages (`limit` up to 200, `after` = the previous page's
  `nextCursor`, ids are time-ordered); errors `{error: {code, message}}`
  with 401, 403, 404, 429. Changing a shape means a new version.

### ADR-091 Supplier compliance — Accepted (C1a built)

- **Status.** A supplier is `PENDING_APPROVAL`, `APPROVED` or `BLOCKED`.
  Existing suppliers are approved. A new setting under Settings →
  Purchasing, "New suppliers need approval" (off by default, so nothing
  changes for organizations that do not want it), makes new suppliers wait.
  Approval needs the new permission `suppliers.approve` (Administrator,
  Finance) and is never given by the person who added the supplier —
  refused by the service and by a database check. Those who may approve
  are notified (`SUPPLIER_APPROVAL_NEEDED`) and see it under Needs
  attention.
- **What the status stops.** An order to a blocked supplier cannot be
  created or moved to it. An order to a supplier waiting for approval can
  be prepared but not submitted or approved. Blocking also stops approval
  of orders already waiting. Receiving against orders already approved,
  supplier invoices and payments are **not** stopped: goods that arrive
  must be recorded, and amounts owed must still be settled. Blocking needs
  a reason; who, when and why are kept (database check). Lifting a block
  returns the supplier to approved, or to waiting if it was never
  approved and approval is required.
- **Licences and certificates** (`supplier_documents`): commercial
  registration, VAT certificate, municipality licence, food safety (e.g.
  HACCP), halal, ISO, insurance, contract, other (with a title); number,
  issue and expiry dates, files through attachments (ADR-051). A document
  marked **required to buy** must have an expiry date; while it is
  expired, orders cannot be submitted or approved (`SUPPLIER_DOCUMENT_EXPIRED`,
  naming the date). Documents are flagged 30 days before expiry (the HR
  document window, ADR-079) under Needs attention, and so in the daily
  digest (ADR-087). Renewal edits the dates; removal archives; both audited.
- **Bank accounts** (`supplier_bank_accounts`): IBAN (shape, country
  length, ISO 13616 mod-97 check) or an account number with a SWIFT/BIC.
  The number is stored encrypted (AES-256-GCM with the connector key,
  ADR-048) with only its last four characters in clear; it never enters
  the audit log. It is shown masked to those who add, verify or pay
  accounts; the full number is shown on request to those with the new
  permission `suppliers.bank.manage` (Administrator, Procurement,
  Finance) or `payments.manage`, and each look is audited. Account details
  never change after saving (database trigger): a change is a new account
  and the old one archived. A new account is marked verified only by
  someone other than the person who added it (service and database
  check); approvers are notified at once (`SUPPLIER_BANK_ACCOUNT_ADDED`),
  since a changed bank account is the usual supplier-payment fraud.
  Payments do not yet record which account was paid.
- **API**: suppliers carry `status` (ADR-090).

### ADR-092 Requests for quotation — Accepted (C1b built)

- **Flow.** A buyer (`purchasing.manage` at the warehouse) creates a
  request for quotation for one warehouse — title, quotes wanted by, goods
  needed by, note — adds lines (product, quantity, unit that converts to the
  product's base unit; one line per product) and the suppliers to ask
  (never a blocked one, ADR-091; one waiting for approval may quote). "Mark
  as sent" fixes lines and suppliers. Nothing is e-mailed (no provider, D2):
  each supplier's PDF, on the company letterhead and without prices, is
  downloaded and sent by the buyer. Statuses: draft → sent → awarded, or
  cancelled with a reason.
- **Quotations** are entered by a buyer as received, one per supplier
  (corrections replace it, audited): currency (default the supplier's),
  the supplier's reference, quotation date, valid until, lead time, and per
  line a unit price per the requested unit (empty = not quoted) and
  optionally a smaller quantity offered. The supplier's file is attached
  (ADR-051). The database refuses a quotation from a supplier not asked and
  a price for another RFQ's line.
- **Comparison** is in the warehouse's company currency (ADR-086): each
  offer's cost for the requested quantity at today's rate. Offers in a
  currency without a rate are shown but not compared, and the missing
  currencies are named — never guessed. Expired quotations are shown and
  cannot be awarded. The lowest valid offer per line is marked; per
  quotation, the total and whether it covers every line in full.
- **Award.** For each line the buyer picks one offer or none. Choosing an
  offer that is not the lowest valid one, or when another valid offer
  could not be compared, needs a written reason, kept on the line. One
  draft purchase order per supplier is created at the quoted prices in the
  quotation's currency (quantity: as requested, or less if less was
  offered), linked to the quotation; the order then follows the approval
  matrix (ADR-049) and the supplier checks (ADR-091) as any other. The RFQ
  is closed as awarded; unawarded lines are not ordered.
- **Not yet:** a supplier portal or e-mailing the RFQ (needs D2), sealed
  bids, a minimum number of quotes, and splitting one line between
  suppliers.

### ADR-093 Purchase order revisions — Accepted (C1c built)

- **When.** An approved order — before or after goods arrive — that needs
  changing (quantity, price, expected date, an extra line, a line dropped)
  is revised, not edited in place. "Start revision" needs a reason and
  `purchasing.manage` at the warehouse.
- **What happens.** The current version (header and lines, as approved) is
  kept in `purchase_order_revisions` with the reason, who and when; the
  order goes back to draft as revision n + 1. Receiving waits until it is
  approved again (invoices for goods already received go on: their order
  price cannot change): resubmission runs the approval matrix
  (ADR-049) and supplier checks (ADR-091) on the new total, as any order.
  Once approved, its status follows its receipts (approved, part-received
  or received — an order cut down to what arrived is complete).
- **Limits.** A revision keeps the supplier, warehouse and currency (a
  different one is a new order). A line with goods received keeps its
  product, unit and price — receipts and invoices were valued at that
  price — cannot be removed, and cannot be ordered below what was received
  (or below its old quantity when more was accepted within the tolerance).
  The database enforces the same: a trigger on order lines, versions kept
  only for the order's current revision, and revisions one step at a time.
- **If the revision cannot go ahead** (e.g. the supplier is blocked): an
  order with nothing received can be cancelled; a part-received one can be
  closed from the revision draft.
- **History.** The order page lists every revision with its reason and
  what changed (lines added, removed, quantity and price changes, expected
  date, total). The PDF and the approval webhook carry the revision number;
  the buyer sends the new PDF to the supplier (no e-mail yet, D2).

### ADR-094 Supplier returns — Accepted (C1d built)

- **What.** Goods sent back to a supplier after they were accepted (a
  quality problem found later, damage, expiry, wrong item, a recall, too
  much delivered). Refusals at the door stay on the receipt (rejected
  quantity, ADR-023); a supplier return is its own document, `RTS-YYYY-n`.
- **From receipts.** A return is started from a posted receipt (the "Return
  goods" button) and may take lines from any posted receipt of the same
  supplier, warehouse and currency. Each line keeps the receipt line's
  product, lot, unit and charged price; the quantity cannot exceed what was
  accepted less what earlier posted returns sent back. The line says whether
  the goods come from available stock or quarantine. Expired and
  recall-held lots can be returned.
- **Posting** (`purchasing.receive` at the warehouse) takes the goods out of
  stock in the inventory module: one `SUPPLIER_RETURN` document with
  `RETURN_TO_SUPPLIER` entries from the receipt's location, valued at the
  warehouse's average cost like any issue (ADR-021). The expected credit is
  quantity × charged price, excl. VAT, in the receipt currency; any gap
  between that and the stock value is the price variance of those goods.
  Returns are serialized per supplier, and the database refuses returning
  more than was accepted.
- **Credit.** Someone with `invoices.manage` links the supplier's credit note
  (recorded under Payables, ADR-039; same supplier and currency — database
  check). The return is then credited. Posted returns without a credit note
  appear under Needs attention.
- **Reversal.** If the supplier refuses the goods, a posted, uncredited
  return is reversed from its page: the stock comes back as it left
  (inventory reversal) and the quantity becomes returnable again. The
  generic ledger reversal refuses return documents, and a receipt with
  posted returns cannot be reversed.
- **Return note** PDF for the supplier, on the company letterhead, with
  receipts, lots and prices.
- **Not yet:** a return reduces neither the quantity that can be invoiced
  nor the supplier's balance by itself — the credit note does; returning
  goods that were moved to another location (the return takes them from the
  receipt's location); supplier collection and transport documents.

### ADR-095 Spend and purchase price variance — Accepted (C1e built)

- **Source: what was received.** Both reports read posted receipts'
  accepted lines (reversed receipts drop out), valued at the price charged
  and the receipt's own exchange rate — the same value the stock took
  (ADR-050/086) — less goods returned in the period (ADR-094, at the
  receipt's price and rate, dated when posted). Supplier invoices are not
  the source: they can lag, and the 3-way match already ties them to these
  receipts (ADR-038). Amounts exclude VAT.
- **Currency.** One company's report is in its currency; the group's is
  converted at the period's average rates (as food cost, ADR-086).
  Currencies without a rate are named and left out, never guessed.
- **Spend** (Reports → Spend): received, returned and net by supplier (with
  share and the amount paid over order prices), by product category (with
  the number of suppliers; categories bought from one supplier are marked
  single source), by branch and by month; the top five suppliers' share of
  net spend.
- **Price variance** (Reports → Price variance): per receipt line,
  (charged − ordered price) × accepted quantity at the receipt's rate —
  paid over and under order prices, net, by supplier and as a share of its
  spend, and the lines off the order price (largest first, linked to the
  receipt). And per product, the average price per base unit against the
  previous period of the same length, for products bought in both, with
  the impact on the quantity bought now. No standard cost is invented: the
  baselines are the approved order price and the price actually paid
  before.
- **Who.** Anyone with `purchasing.view`, for the warehouses where they
  hold it. CSV and Excel exports.
- **Not yet:** spend from invoices or payments, budgets per category,
  contract price compliance.

### ADR-096 HACCP plans — Accepted (C2a built)

- **Plan.** Per product or process (code, name, scope and description,
  intended use, team), for one branch or the whole organization. Process
  steps in order; hazards at each step — biological, chemical, physical,
  allergen — with likelihood and severity scored 1–5 by the team (the
  product is shown as the risk; no threshold is assumed) and whether the
  team judges the hazard significant.
- **Decision tree.** The Codex Alimentarius HACCP decision tree (Q1 control
  measures exist? Q2 step designed to eliminate or reduce? Q3 could
  contamination reach unacceptable levels? Q4 will a later step remove
  it?). As in ISO 22000, a significant hazard not controlled at a CCP is an
  OPRP, and one that is not significant is left to the prerequisite
  programmes (PRP). A significant hazard with no control measure blocks
  approval (the step must change). The team may classify differently from
  the tree only with a written reason (service and database check).
- **Control points.** Every CCP and OPRP needs a critical limit (text, and
  optionally a measurable minimum / maximum with unit), monitoring (what,
  frequency, who), the corrective action and verification, and records
  kept. A control point can be monitored by the branches' temperature
  checkpoints (ADR-035); a checkpoint is accepted only if its alarm limits
  lie inside the critical limits (°C), so a breach is always flagged.
- **Deviations → corrective action.** A reading out of spec at a checkpoint
  that monitors a control point of an approved plan opens a **HIGH**
  non-conformance, linked to that control point, titled as a CCP / OPRP
  deviation and carrying the critical limit and the planned corrective
  action; the corrective-action workflow is the existing one (ADR-035). The
  plan page shows the open deviations and, per checkpoint, the readings of
  the last 30 days and how many were out of limits.
- **Approval and versions.** A plan is a draft until approved by someone
  other than its author, with a future review date; approval is refused
  while anything is missing (steps, hazards, tree answers, control
  points). Approved plans are fixed (database trigger). A change is a new
  version — a full copy, edited as a draft — and its approval supersedes
  the old one; one approved and one draft version per code at a time.
  Plans due for review appear under Needs attention. The plan prints as a
  PDF table.
- **Who.** `foodsafety.view` to see; `foodsafety.manage` at the branch (or
  organization-wide for an organization plan) to edit and approve.
- **Not yet:** monitoring by checklist items; document control, audits,
  complaints, calibration and the compliance score (rest of C2).

### ADR-097 Document control — Accepted (C2b built)

- **Documents**: policies, standard operating procedures, work
  instructions, forms, manuals, other — a code, a title, one branch or the
  whole organization. The text is held in **versions**; a file (a scanned
  form, a diagram) can be attached to a version while it is a draft
  (ADR-051).
- **Lifecycle.** A version is written as a draft and approved by someone
  other than its author (service and database check), with the date it
  takes effect (today or later) and a review date after it. Approved
  versions never change (database trigger); a change is a new version,
  copied from the one in force, which stays in force until the new one is
  approved and supersedes it. One draft and one approved version per
  document at a time. A document no longer used is **withdrawn** with a
  reason — kept with all its versions, no longer listed as in use.
- **Reading.** Anyone who may see a document confirms they have read the
  version in force; each new version needs reading again. The page lists
  who confirmed and when; the list "to read" and Needs attention show what
  each person has not yet read; documents whose review date has come appear
  for food safety managers.
- **Who.** As HACCP plans (ADR-096): `foodsafety.view` to read (at the
  branch, or anyone for an organization document), `foodsafety.manage` to
  write, approve and withdraw.
- **Not yet:** assigning documents to roles that must read them, links from
  HACCP control points and checklists to their SOPs, rich text.

### ADR-098 Audits and customer complaints — Accepted (C2c built)

- **Audits** (`AUD-`): internal, certification / external, authority
  inspection or customer audit of one branch — auditor, scope, planned
  date. Findings are recorded while it is open: observation, minor, major,
  critical, with the requirement concerned. A minor finding opens a MEDIUM
  non-conformance, a major one HIGH, a critical one CRITICAL, at once and
  linked to the finding (ADR-035); an observation opens none. The audit is
  completed with the date it was carried out (not in the future) and the
  auditor's own result as given (a grade or score — nothing is computed);
  an audit with no findings may instead be cancelled with a reason. A
  completed or cancelled audit and its findings never change (database
  triggers). Planned audits past their date appear under Needs attention.
- **Complaints** (`CMP-`): branch, when received, channel (in person,
  phone, e-mail, website/app, delivery platform, social media, other),
  category, what happened, the order reference, and the product and lot
  when known (the lot is matched to the product's lots and linked to
  traceability). Customer name and contact are optional and kept out of
  the audit log. **Foreign object, illness and allergen** complaints open a
  HIGH non-conformance in the same transaction (database check: they always
  have one); others can open a MEDIUM one on request. Staff who record food
  safety log complaints; managers investigate and resolve (resolution and
  what the customer was told or given). Open complaints appear under Needs
  attention.
- **Not yet:** audit checklists and scoring templates, scheduling recurring
  audits, complaint trends by product and branch (C4), notifying customers.

### ADR-099 Equipment, calibration and maintenance — Accepted (C2d built)

- **Equipment** per branch: code (unique at the branch), name, type
  (thermometer or probe, fridge, freezer, oven, hot holding, scale,
  dishwasher, extraction, other), serial number, location, optionally the
  temperature checkpoint it is or measures (same branch). Calibration and
  maintenance intervals in days are set by the organization — none are
  assumed; empty means not planned. Status: in service, out of service
  (with a reason), retired (with a reason).
- **Calibrations** are evidence: who, when, method, certificate number,
  files (ADR-051); never changed (insert-only). When measured — reference
  value, reading and allowed deviation — the result follows from the
  numbers (|reading − reference| ≤ tolerance, inclusive; also a database
  check); otherwise pass/fail is entered. A pass sets the next date (given,
  else date + interval). A **failure** takes the equipment out of service
  and opens a non-conformance (source equipment; HIGH when it serves a
  checkpoint, MEDIUM otherwise) stating that measurements since the last
  passing calibration are in doubt; a later passing calibration returns it
  to service. It cannot be put back in service by hand while its latest
  calibration failed.
- **Maintenance** (preventive, repair, deep cleaning, inspection) is
  recorded the same way, with its own next date. Staff who record food
  safety record calibrations and maintenance and may take equipment out of
  service; managers register, return to service and retire.
- **Due dates** are flagged 30 days ahead (as documents) and when passed;
  equipment with an interval but no record is due at once. Overdue, due
  soon and out-of-service equipment appear under Needs attention.
- **Not yet:** blocking temperature readings from out-of-service
  thermometers, spare parts and costs, maintenance contracts.

### ADR-100 Compliance score, mock recalls and the batch report — Accepted (C2e built)

- **Compliance score per branch** from recorded facts only, over the last
  7, 30 or 90 days ending today in the branch's time zone. Four parts, each
  passed / counted:
  - records in spec (food safety records);
  - checklist items OK (answers);
  - corrective actions on time (actions due in the period, done by their
    due date);
  - equipment calibrated, as of now (equipment with a planned calibration,
    or out of service, that is in service, passed its last calibration and
    is not overdue; never calibrated counts as not calibrated).
    A part with nothing counted has **no score** rather than 100 %. The
    overall score is the plain mean of the parts that have one — equal
    weights, no hidden factors — rounded half up to a whole percent, and is
    empty when no part has data. Open high and critical non-conformances are
    shown beside it but not scored. The bands (90+ good, 75–89 fair, below 75
    poor) are a display convention of this product, not a standard. Branch
    scope follows `foodsafety.view`.
- **Mock recall** (`MRC-` number; `recalls.manage` to run,
  `traceability.view` to see): a timed drill on one lot that **never
  touches stock**. Starting it records the site running it, the scenario,
  an optional target time set by the user (no default is assumed), and
  copies the lot's book position — brought in, left the business, stock by
  warehouse, location and status, number of trace gaps (ADR-033) and of
  suppliers on record — and starts the clock. The team enters what it
  physically found at every place; completing it stops the clock (elapsed
  seconds stored) and scores it. Problems: target missed (inclusive),
  stock found differs from the book, not fully accounted for
  ((left + found) / brought in ≠ 100 %), trace gaps, origin unknown (no
  supplier receipt and no posted production order). Any problem opens a
  MEDIUM non-conformance (source `MOCK_RECALL`) at the branch that ran it,
  stating the problems, time against target and quantities. A running
  drill can be cancelled with a reason. Completed and cancelled drills are
  frozen by database triggers, as is the book position.
- **Batch report**: one click on a lot's trace page gives a PDF (ADR-089
  layout): the lot and product, expiry, brought in / left / on hand,
  recall hold, every recorded movement (first 500, stated when cut),
  suppliers with receipt, order and delivery-note references, what it was
  made from and went into, shipments, recalls and the gaps — from recorded
  movements only.
- **Not yet:** drills across several lots or a whole supplier, notifying
  customers in a drill, trend of the score over time, weights chosen by
  the organization, POS sales linked to lots in the report.

### ADR-101 Location zones, receiving inspection and directed put-away — Accepted (C3a built)

- **Zones**: every storage location has a use — receiving, quarantine,
  storage, picking or dispatch (existing locations: storage) — next to its
  temperature zone.
- **Receiving area**: a receipt posted without a location lands on the
  warehouse's receiving location when it has exactly one; otherwise as
  before.
- **Receiving inspection**: products can be marked "inspect on receipt";
  their accepted receipt quantities go to QUARANTINE whatever the form
  says (lines flagged on the form do too). Each quarantined receipt line
  gets one inspection: packaging, labelling and condition (yes/no), an
  optional temperature, the accepted quantity (base unit) and a reason for
  any rejected part. Accepting goods that failed a check needs a note. The
  accepted part moves QUARANTINE → AVAILABLE and the rest → REJECTED in
  one status-change document (reason INSPECTION); releasing needs the lot
  to be usable. Inspections are evidence (insert-only, a trigger refuses
  changes); a receipt with an inspection can no longer be reversed. Needs
  `inventory.quarantine.release` at the warehouse. Waiting lines appear
  under Needs attention.
- **Put-away rules** per warehouse: priority (1 first), match on product,
  category and/or storage temperature (none = any product), target
  location. Targets must be active storage or picking locations; a rule's
  temperature must match its location. When suggesting, the first matching
  rule whose location still fits the product's storage requirement wins;
  unfit rules are skipped. Without one, a fitting location already holding
  the product is suggested; otherwise none. Managed with
  `warehouses.manage`.
- **Put-away worklist**: available stock in receiving locations (or
  without a location, in a warehouse that has storage locations). A
  put-away is a transfer between locations in the ledger (`inventory.transfer`)
  and is refused into a location that is not storage/picking or whose
  temperature differs from the product's storage requirement.
- **Not yet:** moving quarantined stock to a quarantine location
  automatically, capacity limits per location, inspection checklists set
  by the organization, an NC raised on rejection, scanning (C3d).

### ADR-102 Pick lists, waves and delivery from picked stock — Accepted (C3b built)

- **Pick list** (`PCK-`) for one confirmed sales order: for each open line,
  which lot to take from which place. Stock is planned first-expiring first
  (expiry, best-before, oldest receipt), then picking before storage before
  receiving areas, then by location code. Quarantine and dispatch areas,
  expired and recall-held lots are never planned. Quantities held by other
  planned lists in the same warehouse are not offered again (planning is
  serialized per warehouse). What cannot be planned is reported as a
  shortage; nothing at all refuses the list. One open list per order.
- **Staging**: each line goes to the warehouse's active dispatch location
  at the product's storage temperature (the first by code); without one
  the list is refused — chilled goods are never staged ambient.
- **Picking**: the picker records what was picked per line (never more
  than planned; less needs a reason). Confirming moves the picked stock to
  the dispatch locations in one TRANSFER document. Lines are then fixed
  (trigger).
- **Delivery**: a picked list delivers exactly its staged lots and places
  in the existing CUSTOMER_DELIVERY flow (ADR-047) with cost of goods per
  line; the order line gets the picked quantity. While an order has an
  open list, a plain delivery or cancelling the order is refused.
- **Cancelling**: a planned list releases its hold; a picked list moves the
  stock back where it was taken from, in a TRANSFER document.
- **Dispatch areas are reserved**: automatic FEFO consumption (POS sales,
  production, plain deliveries) no longer takes stock from dispatch
  locations.
- **Wave** (`WAV-`): several confirmed orders of one warehouse planned
  together (all or nothing), with one pick sheet summing the planned lists
  by place, product and lot in walk order (by location code). Pick sheets
  for lists and waves print as PDFs.
- Planning, picking and cancelling need `inventory.transfer` at the
  warehouse; delivering needs `b2b.manage`.
- **Not yet:** pick lists for branch shipments (they are still built by
  hand), packing and loading confirmation (C3c), scanning (C3d),
  reservations honoured by POS and production before picking, splitting a
  wave between pickers.

### ADR-103 Packing, loads and dispatch — Accepted (C3c built)

- **Packing**: a picked list's stock is packed into numbered units
  (`PKU-`; carton, crate, pallet, bag, other) with their exact contents
  (pick list line and base quantity, never more than picked) and an
  optional gross weight. Packing with no quantities puts everything still
  unpacked into the unit. Units can be unpacked until the list is on a
  load; cancelling a picked list unpacks it. A packing list per order
  prints as a PDF. Packing moves no stock: the goods are already in the
  dispatch location (ADR-102).
- **Load** (`LOD-`): one vehicle trip from a warehouse — vehicle, driver,
  note. Only picked lists of that warehouse whose picked stock is fully
  packed can be put on it; a list can be taken off again while the load
  is open. On a load, a list is delivered or cancelled only through the
  load.
- **Loading confirmation**: each unit is confirmed on the vehicle by its
  id (click) or its number (typed or scanned, case-insensitive); a unit not
  on this load or already loaded is refused.
- **Dispatch** (`b2b.manage` and `inventory.transfer`): only when every
  unit is loaded. The vehicle temperature is required when any product on
  the load is chilled or frozen; it is recorded, not judged, as no vehicle
  limit has been set by the organization. Seal number and note are
  optional. Every list on the load is delivered (ADR-102) in the same
  transaction. A load manifest prints as a PDF.
- **Cancelling** an open load takes its lists off (they stay picked and
  packed) and clears the loading confirmations.
- Dispatched and cancelled loads, and the units of delivered lists, are
  frozen (triggers).
- **Not yet:** printed unit labels with barcodes (C3d), vehicle
  temperature limits and in-transit temperature logging, routes and
  proof of delivery (C7), loads for branch shipments.

### ADR-104 Handheld scanning and labels — Accepted (C3d built; D5 decided: both)

- **D5 decided: both** keyboard-style handheld scanners (Zebra, Honeywell
  and similar, which type the code and press Enter) and phones (the
  camera). No special hardware integration is needed for the first: any
  scanner set to keyboard mode with an Enter suffix works with the scan
  fields. Camera scanning uses the browser's own barcode reader
  (BarcodeDetector: Chrome and Edge on Android, among others); where the
  browser has none, the camera button is not shown and the field is used.
  The site now allows the camera for itself only
  (`Permissions-Policy: camera=(self)`); microphone stays blocked.
- **Validation status:** tested in the browser with simulated keyboard
  input only. Not yet tested on a physical Zebra/Honeywell device or a
  phone camera — to be checked at the pilot. The store apps' web views
  (ADR-061) may need their own camera permission.
- **Scan text** is cleaned before use: control characters (Enter, Tab,
  GS1 group separators) are dropped and spaces trimmed.
- **Labels**: Code 128 (code set B), drawn as SVG from our own encoder
  (no new library), for pack units (unit number, order, customer, n of m)
  and for storage locations (code, name, use, temperature). Printed from
  the browser. The numbers are ours, not GS1 identifiers (no SSCC/GTIN is
  issued).
- **Scan lookup**: one field recognises a pack unit, pick list, load,
  location (by code), product (by barcode or SKU) or lot, within what the
  user may see.
- **Screens** (Inventory → Scanner), sized for phones:
  - _Guided picking_: line by line in walk order — scan the location (must
    match), scan the product (barcode, SKU or lot; must match), confirm the
    quantity (short needs a reason); the result is submitted as one pick
    (ADR-102), which the server checks again.
  - _Loading_: scan each unit onto the vehicle (ADR-103).
  - _Counting_: scan a product barcode, SKU or lot to find its count
    lines, then enter what is counted.
    The field empties and refocuses after every scan, ready for the next.
- **Not yet:** QR codes and GS1-128 data on our labels, label printers
  (ZPL), scanning at receiving and put-away, offline scanning.

### ADR-105 Sales analytics and targets — Accepted (C4a built)

- **Source**: paid POS orders only, net of VAT; refunds are deducted on
  their order's business date (as the dashboard, ADR-078). Imported sales
  files (ADR-036) and B2B invoices are not part of this report yet.
- **Currency**: each branch sells in its company's currency (ADR-086);
  figures are converted into the group's currency, or the chosen
  company's, at the period's average rate. A currency without a rate is
  left out and named on the page — never converted at a guessed rate.
- **Figures**: net sales, orders, average ticket (net ÷ orders); by branch
  (with share), channel, ISO weekday, hour of ordering in the branch's
  time zone, and day.
- **Comparisons**: the period of the same length just before, and the same
  calendar dates one year earlier (29 February → 28 February). Growth is
  (current − base) ÷ base and is shown only when the base is above zero.
- **Targets** (`sales.targets.manage`, new; granted to administrators,
  operations managers and finance): net sales per branch per calendar
  month, set by the organization in the branch's company currency (none
  assumed). For any period, a month's target is shared out evenly over its
  days (amount × days of the period in the month ÷ days in the month).
  Achievement = net ÷ target, shown only when a target exists. Targets are
  listed for every visible branch, with or without a warehouse.
- **Export**: CSV or Excel of branches and days.
- **Not yet:** targets by channel or weekday, weighting targets by weekday
  patterns, forecasts (I1), imported sales and B2B in the same view.

### ADR-106 Stock ageing, turnover and days on hand — Accepted (C4b built)

- **Source**: the stock ledger (quantities and values) and the moving
  average valuation (ADR-021) only; nothing is stored.
- **Ageing** is of stock on hand today, at moving average cost. A lot's age
  is counted from its first receipt (wherever it is now); stock without
  lots is aged first in first out from its recorded arrivals in that
  warehouse (opening balances, receipts, transfers in, production output,
  customer returns, positive adjustments) — what is on hand is taken to be
  the most recent arrivals. On-hand quantity not covered by recorded
  arrivals is shown as "age unknown". Buckets 0–30, 31–60, 61–90, 91–180
  and over 180 days are a display convention of this product. Expired lots
  still on hand are valued separately.
- **Usage** over a period: consumption (recipe use, production, POS) and
  customer deliveries, net of their reversals. Write-offs are reported on
  their own and are not usage. Transfers between warehouses are not usage.
- **Turnover** = usage value ÷ ((opening value + closing value) ÷ 2);
  **days on hand** = closing value ÷ (usage value ÷ days in the period).
  Opening and closing values come from the ledger at the start and end of
  the period (each branch's calendar). Neither is shown without stock or
  without usage.
- **Slow movers**: products with stock on hand and no usage in the period.
  Products whose cost is incomplete (ADR-021) are marked.
- Values are converted into the report currency at the period's average
  rate; currencies without a rate are left out and named. Needs
  `inventory.valuation.view`. CSV and Excel.
- **Not yet:** ageing at a past date, quantity-based turnover, service
  level and stock-out days, ABC classification.

### ADR-107 Menu engineering — Accepted (C4c built)

- **Method**: Kasavana–Smith. Among the items analysed, an item is
  _popular_ when its share of items sold is at least 70 % of an equal
  share (1 ÷ number of items), and _profitable_ when its contribution
  margin per item (average net price − cost per item) is at least the
  sales-weighted average margin. Stars: both; plowhorses: popular only;
  puzzles: profitable only; dogs: neither. The short advice per class is a
  display convention.
- **Sales**: POS lines of paid orders in the period, net of VAT and
  discounts, less refunded quantities (revenue reduced in proportion).
- **Cost**: the standard cost of the item today, not at the time of sale —
  the active recipe version's cost per portion at moving average cost in
  the selling warehouse (ADR-031), or the product's average cost there ×
  quantity per item. Price and cost are taken in the selling warehouse's
  currency and both converted into the report currency at the period's
  average rate. Option price changes are in the price; options' extra
  ingredients are not in the cost.
- **Not classified**: combos, items whose recipe has no active version,
  product items without a cost. They are listed with their sales and the
  reason. Recipes with uncosted ingredients are classified and marked.
- A category filter analyses one menu category at a time (the classes are
  relative to the items analysed). Needs `sales.view` and
  `recipes.costs.view`. CSV and Excel.
- **Not yet:** cost at the time of sale, combos split into components,
  option ingredients, per-branch menus compared side by side.

### ADR-108 Kitchen display performance — Accepted (C4d built)

- **Source**: kitchen tickets (ADR-063) only. A ticket's time runs from
  when it reached its station to when it was bumped; recalled-and-rebumped
  tickets count their last bump. Tickets count on the day and hour they
  were sent, in the branch's time zone.
- **Figures** per station, hour sent and day: tickets sent, median, 90th
  percentile (linear interpolation, as SQL percentile_cont) and average
  time of bumped tickets; share within target; tickets not bumped; items
  and items voided after reaching the kitchen. Right now: tickets on the
  screens and those already past their target.
- **Within target** means under the station's target minutes, the same
  rule as the station screen (reaching the target is late). Targets are
  the stations' current settings — a changed target re-judges past
  tickets; no history of targets is kept yet.
- No figure is shown without bumped tickets. At most 50 000 tickets are
  read per request (the page says so when the period holds more). Needs
  `sales.view` at the branches shown. CSV and Excel.
- **Not yet:** per-item preparation times, staff on shift against
  tickets, target history.

### ADR-109 Cost centres, expense categories and operating expenses — Accepted (C5a built)

- **Categories** are the organization's own (none are created for it); each
  has a code, names and a P&L group: occupancy, utilities, staff,
  marketing, repairs and maintenance, administration, delivery, other.
  **Cost centres** belong to one branch or are shared (head office).
  Both can be archived; archived ones take no new expenses.
- **An expense** belongs to a branch and is in that branch's company's
  currency (ADR-086): date (not in the future), category, optional cost
  centre (of that branch, or shared) and supplier, description, the
  supplier's document number, net and VAT as on the document, gross =
  net + VAT (check). Receipts and invoices are attached (ADR-051, entity
  EXPENSE). Numbered `EXP-`.
- **Never edited**: a trigger refuses any change except the one reversal,
  which needs a reason; reversed expenses stay on record and leave the
  totals.
- **Permissions** (new): `expenses.view` and `expenses.manage`, both
  branch-scopable. Administrators and finance have both, branch managers
  both at their branch, operations managers and analysts view. Categories
  and cost centres need `expenses.manage` organization-wide.
- Lists filter by period, branch and category, with posted totals per
  currency and P&L group; CSV and Excel.
- **Not yet:** VAT on expenses in the VAT summary and accounting export
  (the VAT is recorded, not yet reclaimed through the system), expenses
  in foreign currencies, approval of large expenses, recurring expenses,
  spreading one bill over several months, expenses from supplier invoice
  charge lines.

### ADR-110 Branch budgets and budget against actual — Accepted (C5b built)

- **A budget** is set per branch, calendar month and line, in the branch's
  company currency (ADR-086), net of VAT; nothing is assumed and an empty
  month has no budget. Lines: cost of sales and the expense P&L groups
  (ADR-109). The **sales line is the branch's sales target** (ADR-105) —
  one figure, set on the targets page, not entered twice.
- **Derived rows**: gross profit = sales − cost of sales; total expenses =
  the sum of the groups; operating result = gross profit − total
  expenses. A derived row exists only when one of its parts does.
- **Actuals** (one definition, `branchActualsInTx`, to be reused by the
  branch P&L):
  - sales — paid POS orders net of VAT less refunds (business date),
    active lines of posted sales imports (sale date) and posted B2B sales
    invoices' net in the company currency (invoice date), each to the
    branch of its warehouse;
  - cost of sales — the stock value POS orders used, the stock value of
    an import shared over its months by net amount (by line count when it
    has none), and the cost of goods of B2B invoices;
  - expenses — posted operating expenses' net by P&L group (expense date).
- **Variance** = actual − budget, with its share of the budget; above
  budget is favourable for sales, gross profit and the operating result,
  below budget for cost rows. A line with no budget has no variance.
- **Year to date** runs from January to the current month in the
  branch's time zone (the current month is still open and compared with
  its full budget); past years in full, future years have no actuals.
- **Permissions** (new): `budgets.view` (branch-scopable) and
  `budgets.manage`. Administrators and finance have both; operations
  managers, branch managers (at their branch) and analysts view.
- **Not yet:** budget versions and approval, copying last year or
  spreading a yearly figure over months, prorating the open month,
  budgets per cost centre, foreign-currency budgets.

### ADR-111 Branch profit and loss — Accepted (C5c built)

- **Source**: the shared branch actuals of ADR-110, so the P&L, budget
  against actual and (later) consolidation agree. Two additions to them:
  - **stock losses** — write-offs, adjustments and count differences net
    of their reversals, as in the waste report (ADR-041), on the day in
    the branch's time zone; stock found reduces them. They come after
    gross profit and before operating expenses, and have no budget line
    (budget against actual shows them as actual only);
  - **net sales by source** — the till, sales imports and B2B invoices.
    Imported sales and their stock cost now count on the day sold (cost
    shared by net amount, by line count without one), so any period is
    exact, not only whole months.
- **Rows**: net sales (by source), cost of sales, gross profit, stock
  losses, each expense group, total expenses, operating result
  = gross profit − stock losses − expenses. Every row shows its share of
  net sales; nothing without sales. The operating result is before
  depreciation, interest and tax unless those are recorded as expenses —
  the system has no fixed assets or loans.
- **Columns**: one per branch in its company's currency, and a total per
  company with two or more branches shown. Branches in different
  currencies are never added (consolidation into one currency is C5d).
  With one branch chosen: its months (when the period spans several),
  the period total and the same period last year.
- **Permission** (new): `pnl.view`, branch-scopable — administrators,
  finance, operations managers, analysts, and branch managers at their
  branch. Periods up to three calendar years. CSV and Excel.
- **Not yet:** consolidation across companies and currencies (C5d),
  allocating head-office costs to branches, depreciation, staff costs
  from payroll, a P&L by brand or cost centre, PDF.

### ADR-112 Consolidated group P&L — Accepted (C5d built)

- **Each company's P&L** is the sum of its branches' figures from the
  shared branch actuals (ADR-110, ADR-111), in the company's currency.
- **Conversion** into the group currency (the organization's, ADR-086) at
  the average of the period's rates for that currency, or the latest
  earlier rate when the period has none — the rule every group report
  uses. Each figure is converted, then the derived rows are recomputed. A
  company whose currency has no usable rate is **left out of the group
  total and named** on the report; no rate is assumed.
- **Intercompany**: a customer can be marked as one of the group's own
  companies (`customers.group_company_id`, set on the customer page with
  `b2b.manage`). On consolidation, net sales invoiced to such customers
  come off B2B and total net sales and, by the same amount, off cost of
  sales — the buying company's cost of that stock. This is right when
  the buyer has used or sold the stock in the period (usual for food);
  **profit still held in the buyer's unsold stock is not eliminated**,
  and the report says so. Transfers of stock between companies do not
  exist (ADR-086), so there is nothing else to eliminate.
- **Report**: one column per company (converted), eliminations, group
  total with shares of sales; a table of each company in its own
  currency with its intercompany sales. CSV and Excel.
- **Permission** (new): `pnl.consolidated.view`, organization-wide only —
  administrators, finance, operations managers and analysts.
- **Not yet:** eliminating unrealized profit in stock, intercompany
  purchases matched against the seller's invoices, minority interests,
  closing-rate translation and translation differences, a consolidated
  balance sheet (there is no general ledger), consolidation by brand.

### ADR-113 Import shipments — Accepted (C6a built)

C6 (trade) is built in parts: **C6a** import shipments, HS codes and
origin; C6b trade documents and certificates with expiry and
requirements per country; C6c customs entries (duty, freight, insurance)
feeding landed cost over the shipment's receipts.

- **Products** carry an optional **HS code** (the tariff code the user's
  customs broker uses: 6–12 digits, typed with dots or spaces, stored as
  digits) and **country of origin** (ISO 3166-1 alpha-2). No tariff
  schedule or duty rate is shipped or assumed. The country list comes
  from the runtime's CLDR data, not a list kept in the code.
- **An import shipment** (`IMP-`) is goods from one supplier travelling to
  one warehouse, and belongs to that warehouse's company: transport mode,
  Incoterm (2020), origin, ports, carrier, bill of lading / air waybill,
  vessel or flight, expected departure and arrival.
- **Orders**: approved purchase orders from the same supplier to the same
  warehouse, not fully received; one order may travel on several
  shipments (split deliveries).
- **Containers**: ISO 6346 numbers with the **check digit verified**,
  type, seal, and a set point for reefers only (−60 to 40 °C).
- **Steps**: planned → in transit (needs at least one order) → arrived →
  cleared → closed, each dated (not in the future, not before the
  previous step; the database checks the order of dates). Cancelling
  needs a reason and is possible before arrival only. Details, orders
  and containers change until cleared.
- **Receipts**: after arrival, posted receipts of the shipment's orders
  are linked to it (one shipment per receipt) — the set C6c spreads
  duty and freight over. An order with linked receipts stays on the
  shipment.
- **Late**: past its expected arrival and not yet arrived — shown on the
  list and in Needs attention.
- Files (B/L scans, invoices) attach to the shipment (ADR-051).
- **Permissions** (new): `trade.view` and `trade.manage`, scopable to
  the destination warehouse or branch. Administrators and procurement
  both; operations managers, warehouse, finance and analysts view.
- **Not yet:** documents and certificates with expiry (C6b), customs
  entries and landed cost from the shipment (C6c), carrier tracking
  feeds, demurrage and detention, packing lists per container,
  shipment-level quantities different from the orders.

### ADR-114 Trade documents and requirements — Accepted (C6b built)

- **Document types are the organization's own** (code, names, held for
  each shipment or each product, with or without an expiry date). None
  are created for it and no authority's rules are shipped: what SFDA,
  customs or a halal body asks for is entered by the user.
- **Requirements** say when a type is needed: into a country (the
  importing company's country, ADR-083), from an origin, for products
  whose HS code starts with a prefix (2–12 digits); an empty condition
  matches everything. They are never edited — a change is a new one and
  the old one archived.
- **Matching** (pure, `document-rules.ts`): a product's origin is its
  own, else the shipment's. Unknown facts never match a condition, and
  the checklist names the products without an HS code or origin and says
  when the company has no country, rather than guessing. A shipment-wide
  requirement with no product condition applies to every shipment that
  matches its countries.
- **Documents** are held for one shipment or one product (product
  registrations and permits serve every shipment of that product):
  number, issuer, issue and expiry dates (required when the type has an
  expiry; not before issue), note, scan (ADR-051). Renewal edits the
  number and dates (audited); removal archives with a reason.
- **Checklist** on each shipment: one line per shipment document needed,
  one per product for product documents, with the best document held
  (latest expiry) and its state — held, expiring within 30 days (the
  window of ADR-079/091), expired or missing. **Marking a shipment
  cleared is refused** while any line is missing or expired
  (`SHIPMENT_DOCUMENTS_MISSING`, naming them).
- **Needs attention**: trade documents expired or expiring within 30
  days — product documents, and those of shipments not yet closed.
- **Permissions**: `trade.view` / `trade.manage` (ADR-113). Shipment
  documents follow the shipment's warehouse scope; types, requirements
  and product documents need `trade.manage` for the whole organization.
- **Not yet:** export documents and requirements of destination
  countries for sales, per-container documents, reminders by e-mail
  ahead of expiry, document templates or generation, links to
  authorities' systems (e.g. SFDA, FASAH).

### ADR-115 Customs entries and shipment charges — Accepted (C6c built)

- **Customs entry**: a declaration on an arrived shipment as customs
  assessed it — declaration number (UQ per shipment), date (not in the
  future), broker, customs value, **duty assessed** and **import VAT**,
  all in the shipment company's currency (ADR-086). No duty rate or
  tariff is assumed: the figures come from the declaration. Import VAT
  is recorded, not added to stock (it is not a cost of the goods;
  reclaiming it through the VAT return is not built yet).
- **Shipment charge**: freight, duty, insurance, handling or other,
  entered in any document currency (converted at the rate on the posting
  date, ADR-053), optionally against a customs entry (for duty), on an
  arrived, cleared or closed shipment with at least one linked receipt.
  It is **spread over every line of all the shipment's posted receipts**
  (ADR-113) — by value in the company's currency (each receipt's prices
  × its own rate, so receipts in different currencies weigh fairly) or
  by quantity when all lines share a base unit — with the largest
  remainder rounding of ADR-028, then **posted per receipt as landed
  costs** through the inventory module: only the share for stock still
  on hand is added to its value, the rest is recorded as relating to
  stock already used. One charge makes one `LCA-` document per receipt,
  linked to it. The orders are locked in id order, as for receipts.
- Needs `inventory.valuation.revalue` at the warehouse (as any landed
  cost); recording customs entries needs `trade.manage`.
- **Append-only**: customs entries and charges are never changed or
  removed (trigger; no UPDATE/DELETE grant). A mistake is corrected by a
  revaluation (ADR-028).
- **Shipment costs**: goods received (company currency), charges by
  type, landed total and charges as a share of the goods; each
  declaration with its duty assessed against the duty posted (flagged
  when they differ).
- **Not yet:** allocation by weight or volume (needs product weights),
  duty per HS line of the declaration, linking a charge to the
  forwarder's or broker's supplier invoice for payment, import VAT in
  the VAT return, demurrage and detention, estimated charges before the
  invoices arrive.

### ADR-116 Own fleet: trips, proof of delivery and cold chain — Accepted (C7a built)

C7 (logistics and CRM) is built in parts: **C7a** own fleet for
distribution from warehouses; C7b riders for restaurant delivery orders;
C7c customer segments and feedback; C7d campaigns (needs a messaging
provider — Q to be asked before it is built).

- **Vehicles**: code, plate, type, home warehouse, capacity;
  refrigerated vehicles must have a temperature range (database check);
  archived ones take no new trips.
- **Driver role** (new system role, also added to existing
  organizations): `logistics.view` and `logistics.deliver`, usually at
  warehouse scope. A trip's driver must be a member whose role grants
  `logistics.deliver` covering the trip's warehouse.
- **Trips** (`TRP-`): one vehicle (based at the warehouse) and one
  driver for a day, with ordered **stops**: posted B2B customer
  deliveries (ADR-046) from that warehouse, and transfers in transit
  from it (ADR-026). A consignment is on one open stop at a time
  (unique index; a failed stop frees it for another trip). Planned →
  on the road (needs stops; optional odometer) → completed (every stop
  delivered or failed; odometer not below the start) — or cancelled
  before it starts, with a reason, freeing its stops.
- **Proof of delivery**: recipient name, time, temperature at handover
  (required on refrigerated vehicles, and also kept as a reading), a
  **signature drawn on the phone** stored as SVG path data restricted to
  move/line commands and numbers (so nothing but a line can be stored or
  drawn back), photos as attachments (ADR-051), note. Final once
  recorded (database trigger). Not delivered: the reason is kept.
- **Cold chain**: readings on the road (−60 to 60 °C) flagged as an
  **excursion** when outside the vehicle's range; trips with excursions
  in the last 7 days are in Needs attention. Readings are append-only.
- Recording on the road needs `logistics.deliver` and being the trip's
  driver — or also holding `logistics.manage` there (planners stand in).
  Planning needs `logistics.manage`.
- **What it does not change**: stock. Deliveries were posted when
  dispatched and transfers are still received at the destination as
  before (ADR-026); a failed delivery's return is not posted
  automatically.
- **Not yet:** riders and dispatch for POS delivery orders (C7b), route
  optimisation and maps, live GPS, temperature loggers feeding readings,
  logistics cost per trip and per drop, returns from failed deliveries,
  customer notifications.

### ADR-117 Own riders for delivery orders — Accepted (C7b built)

- **What is delivered**: paid POS orders on the delivery channel sold at
  a branch. Platform orders (ADR-066) are delivered by the platform and
  refused here; takeaway and dine-in orders too.
- **A home delivery** (one per order) holds the customer's name, phone,
  address and directions **for this delivery only**. A dispatcher
  (`pos.dispatch` at the branch — new; administrators, operations and
  branch managers, cashiers) creates it from the dispatch board.
- **Riders** are members whose role grants `logistics.deliver` covering
  the branch — the Driver role (ADR-116) at branch scope, or branch
  managers, who now also hold it, standing in. Waiting → assigned (and
  reassigned until it leaves) → on the way (picked up by the assigned
  rider) → delivered (optionally who took it) or not delivered (reason).
  Cancelled with a reason before it leaves. A voided order cannot be
  picked up; the dispatcher cancels its delivery.
- **The rider's phone page** lists their deliveries with the address, a
  call link and a map **search link** (no map service is called by the
  system and no location is collected), and the steps.
- **Dispatch board** per branch and day: delivery orders still without a
  delivery, deliveries in progress with minutes since the order, the
  branch's riders with what each carries, and per rider delivered, not
  delivered and the median minutes on the road and from order to door.
- **Privacy**: the address, phone, name and directions are **erased 30
  days after the delivery ends** by a daily job (ADR-087); the audit log
  never contains them. The delivery record, times and outcome remain.
- **Not yet:** cash collected on delivery and its reconciliation per
  rider, delivery fees and zones, promised times and lateness alerts,
  customer tracking links and notifications, address book for repeat
  customers, rider shifts and pay, live location.

### ADR-118 Customer segments and guest feedback — Accepted (C7c built)

- **Segments** are saved conditions, not stored lists: worked out from
  paid POS orders (gross less refunds) each time they are looked at.
  Conditions (all optional, all must hold): look-back window (1–1 095
  days, default 365) for orders and spend; visited within / not visited
  for N days (last visit ever, business date); at least / at most orders;
  at least spend; visited any of chosen branches; agreed to receive offers
  (ADR-068 consent); at least points. Names are unique ignoring case.
  Erased customers are never included.
- **RFM**: guests who bought in the window are scored 1–5 by quintile on
  recency, frequency and spend against each other, then grouped —
  champions (R ≥ 4, F ≥ 4), loyal (F ≥ 4), new (R ≥ 4, one order), at
  risk (R ≤ 2, F ≥ 3), lost (R = 1, F ≤ 2), others. The usual reading,
  shown as a guide, not used to decide anything.
- **Export** of a segment's members (CSV/Excel) needs `customers.manage`;
  phone and e-mail are included **only for guests who agreed to receive
  offers**; each export is audited by count only, never by person.
- **Guest feedback**: every paid order's receipt carries a QR and a link
  signed with the integration key (HMAC-SHA256 of the order id, so it
  cannot be guessed or forged). The public page asks for a 1–5 rating and
  an optional comment — nothing about the guest — once per order
  (unique), within 14 days of the order. The rating and comment never
  change (database trigger).
- **Follow-up**: ratings of 2 or less appear in Needs attention for those
  with `customers.manage` until marked reviewed (with what was done) or
  **turned into a customer complaint** (ADR-098) at the order's branch,
  which also needs `foodsafety.record` there; the complaint is linked.
- **Feedback page**: count, average, share of 4–5 stars and low ratings
  for a period, by branch, with each comment.
- Permissions: the existing `customers.view` / `customers.manage`
  (organization-wide).
- **Not yet:** campaigns to a segment (C7d, needs a messaging provider),
  segments by items bought or channel, NPS, replying to the guest,
  feedback for platform orders (no receipt from us), rating questions
  per aspect (food, service, delivery).

### ADR-119 Campaigns, provider-neutral — Accepted (C7d built; sending waits for a provider)

Decision (2026-11-05): build campaigns without choosing a messaging
provider; no provider adapter is shipped until one is tested with the
customer's own account and credentials.

- **A campaign** is a message on one channel (SMS, WhatsApp or e-mail —
  e-mail needs a subject) to a saved segment (ADR-118). The message may
  use `{name}` (the guest's first name) and nothing else. Optional: leave
  out guests messaged by another campaign within N days; count visits
  within N days (default 7) as results. Drafts change freely.
- **Audience**: the segment's guests who **agreed to receive offers**
  (ADR-068), are not erased and have a contact for the channel (phone for
  SMS and WhatsApp, e-mail for e-mail), less those messaged recently. The
  draft shows each step's count, the message as a guest would read it
  (unsubscribe link included) and, for SMS, its parts by the GSM-7
  (160 / 153) and UCS-2 (70 / 67) rules.
- **Launch** (new permission `campaigns.send`: administrators, operations
  managers) fixes the recipients and schedules sending, now or at a time
  in the organization's zone. It is **refused while no provider is
  connected for the channel** — at present always, as no adapter exists.
  Recipients hold **no phone or e-mail**: the contact is read at the
  moment of sending, and a guest who withdrew consent or was erased in
  between is skipped.
- **Sending** is a job every minute (ADR-087): due campaigns, a batch of
  recipients at a time, through `MessagingProvider.send`; failures are
  kept per recipient with the provider's message. Cancelled before it
  goes, pending recipients are left out.
- **Unsubscribe**: every message ends with a link signed with the
  integration key (HMAC-SHA256 of the recipient); the public page lets
  the guest stop all offers from the organization — consent withdrawn,
  marked on the recipient and audited without a person's details.
- **Results**: recipients sent, failed, left out, waiting, stopped
  offers; guests who came back within the window, their orders and spend.
- **A provider adapter, when added**, comes with its connector kind and
  sealed credentials (ADR-048), delivery receipts and the provider's own
  opt-out keywords, and is only enabled after a real test.
- **Not yet:** any provider adapter, WhatsApp template approval flow,
  e-mail HTML and sender domain set-up, quiet hours and frequency caps
  across all campaigns, A/B variants, coupon codes per recipient.

### ADR-120 Transparent demand forecasts and forecast-based orders — Accepted (I1a built)

Decision (2026-11-05): forecast demand per product × warehouse from the
ledger with methods a buyer can check by hand, and offer a forecast-based
order next to the par-level suggestion (ADR-025). Nothing is predicted by
a model that cannot be explained, and no input is guessed.

- **Demand** is what left the warehouse to be used: consumption (sales
  and production), customer deliveries and transfers to another
  warehouse, net of their reversals, by business day in the warehouse's
  time zone. Write-offs, returns, count differences and moves between
  locations of one warehouse are not demand. History is the last 56
  days; an item with under 28 days since its first movement at the
  warehouse gets no forecast.
- **Methods**: average of the last 28 days, average of the last 7 days,
  and the same weekday over the last 4 weeks. Each is scored over the
  last 14 days by one-day-ahead forecasts from the days before: WAPE
  (absolute error over actual demand), bias and RMSE. The item uses the
  method with the lowest WAPE (ties: the steadier, in that order; no
  demand in those days: the lowest RMSE). The page shows every item's
  weekly demand, method, error, bias and the next 7 and 28 days; CSV and
  Excel export.
- **Forecast order**: forecast demand over the lead time plus a review
  period, plus safety stock z × RMSE × √(those days), less usable stock
  and open orders, rounded up to whole purchase units and the supplier's
  minimum. z is the standard normal quantile of the organization's
  service level: 90, 95 (default), 98 or 99 %. The review period is the
  organization's (1–90 days, default 7). The lead time is the supplier's
  for the product, else the supplier's own; **without one no forecast
  order is offered** ("No lead time set").
- **Ordering**: the reorder plan shows both suggestions; the buyer picks
  min–max or forecast quantities when creating drafts. Quantities are
  worked out again on the server; lines without a supplier, a known price
  or a forecast quantity are skipped and named.
- **Not stored**: forecasts are worked out when asked, so they always
  match the ledger; only the two settings are kept
  (`procurement_settings.forecast_review_days`, `forecast_service_level`).
- **Known limit**: imported sales post their stock use when imported, so
  a day imported late counts on the day it was imported.
- **Not yet**: production forecasts (built in I1b, ADR-121), seasonality beyond the week, holidays and
  promotions, forecasts for items without a reorder level on the plan,
  storing forecasts to track their accuracy over time.

### ADR-121 Forecast batches for the central kitchen — Accepted (I1b built)

Decision (2026-11-05): the production plan (ADR-045) shows forecast
batches beside the batches it plans from branch requisitions and par
levels, with the methods, scoring and short-history rule of ADR-120.

- **Two bases**, chosen on the plan:
  - **What leaves this kitchen** (default): demand as in ADR-120 at the
    kitchen's warehouse — its own use, customer deliveries and transfers
    to the branches — against usable stock at the kitchen.
  - **What all branches use**: use and customer deliveries of the
    preparation in every warehouse of the organization (transfers between
    warehouses are not use), by business day in the kitchen's time zone,
    against the stock held anywhere, usable or in transit. Totals only;
    no branch's figures are shown. Meant for preparations only this
    kitchen makes: with two kitchens making the same one, plan from what
    leaves each kitchen.
- **Batches**: forecast demand over the next N days from today (1–14,
  default 2, chosen on the plan, not stored) plus safety stock z × RMSE ×
  √N at the organization's service level (ADR-120), less that stock and
  the batches already planned, rounded up to whole recipe batches. "Plan
  forecast batches" opens a new production order with that quantity; the
  planner confirms it as usual.
- No schema change.
- **Not yet**: planning ingredients for forecast batches, production
  calendars and shifts, forecasts per branch shown to the kitchen,
  holidays and promotions.

### ADR-122 AI assistant with Claude, business data only — Accepted (I2a built; live once a key passes the test)

Decision (2026-11-05): the assistant uses **Claude (Anthropic)** through
Anthropic's SDK with the organization's own API key, and sends **business
data only — no personal data**.

- **Off by default.** An administrator (`assistant.manage`) stores the
  key (AES-256-GCM sealed with the integration key, ADR-048; shown only as
  its last four characters, never audited), picks the model — Claude Opus
  5.5 (default), Sonnet 5.5 or Haiku 5.5 — and runs **Test connection**
  (the provider's model lookup with that key). Only a passed test allows
  switching it on; a new key or model switches it off until tested again.
  The database refuses an assistant that is on without a passed test.
- **Who asks**: `assistant.use` (operations managers, procurement,
  warehouse, food safety, finance, branch managers, administrators; not
  the read-only analyst, whose role stays `.view` only, nor POS roles).
  It may be held at a branch or warehouse.
- **How it answers**: a tool loop (at most 8 rounds, then it must answer
  from what it has) over seven read-only tools — sites, sales summary,
  stock levels, needs attention, demand forecast, reorder suggestions,
  branch P&L. Each tool calls the same service as the app's own page
  **with the asking person's context**, so it sees exactly what they may
  see; a refused read comes back as "not permitted" and the model is told
  to say so. Tools pick fields explicitly: figures, codes, product and
  supplier names — never guest or staff names, contacts or pay; the
  needs-attention tool returns counts, not the linked records.
- **Questions** are stored and sent with e-mail addresses and phone
  numbers removed (dates and document numbers kept). Earlier questions and
  answers of the conversation (text only, last 10 turns) go with a
  follow-up. The system prompt tells the model to answer only from tool
  results, never invent figures, treat tool text as data, and reply in the
  person's language.
- **Requests**: effort `medium`, adaptive thinking, the system prompt
  cached, `tool_choice` auto, strict tool schemas (inputs also validated
  on the server), and the server-side refusal fallback (`fallbacks:
"default"`) on Opus 5.5 and Sonnet 5.5. A refusal or a provider error is
  stored as the answer, never retried silently.
- **Record**: each answer keeps the tools called (name, input, read or
  refused), the pages behind it as links, the model that served it and
  tokens used; answers are never edited. The audit log records the tools
  read and how many personal details were removed — not the question or
  answer. Conversations are private to their author, can be deleted, and
  are deleted after 90 days without use (daily job). A per-person daily
  question limit (default 50) caps cost.
- **Live status**: built and tested against a scripted stand-in; the real
  client was exercised up to authentication (a placeholder key is refused
  by the provider). It answers once an organization's own key passes the
  test.
- **Not yet**: streaming answers, more tools (waste, food cost, menu
  engineering, purchasing spend, food safety records), charts in answers,
  per-tool cost reporting, an organization-wide usage view.

### ADR-123 Payroll with rules the organization enters — Accepted (HR4a built)

Decision (2026-11-05): build payroll now without presetting any statutory
rule (Q-20 stays open on the rates themselves). Everything a law decides
is entered by the organization, dated and with its source; the app does
the arithmetic, keeps the record and enforces approval.

- **Access**: `payroll.view`, `payroll.manage`, `payroll.approve`, at
  organization level only (pay is not branch data). Administrators hold
  all three; the finance role views and approves. Payroll data is never
  in `hr.view`.
- **Salaries** are dated records per employee — monthly basic, up to 12
  named allowances (each marked in or out of the contribution base), and
  bank transfer or cash — in the employing company's currency. A change is
  a new record from its date; records are never edited (trigger), and a
  new salary may not start in a month whose pay is already approved. The
  audit says pay changed, never the amounts.
- **Bank accounts**: bank name and IBAN (checked by length and checksum),
  sealed with AES-256-GCM (ADR-048); only the last four characters show.
- **Contribution rules** (social insurance and similar) per company: code,
  name, who they apply to — everyone, nationals of the company's country,
  or others (the employee's nationality against the company's country) —
  employee and employer rates, optional monthly base minimum and maximum,
  from-date, and the source (law, circular, adviser). A rule with the same
  code from a later date ends the previous one the day before. **None is
  preset.**
- **Proration**: the organization chooses, before its first run, calendar
  days or a 30-day month (no default). Joiners and leavers are paid for
  the days employed; approved unpaid leave (leave types marked unpaid,
  ADR-081) comes off at the daily rate of fixed pay, half days kept.
- **A run** is one company and one month (one live run each). It pays
  everyone of the company's branches employed in the month with a salary
  on record (others are listed as skipped), using the salary in force at
  month end and the rules in force at month end. Contributions are on the
  contribution base for the days actually worked, held within the rule's
  limits. One-off additions (overtime, bonus, commission, other) and
  deductions (advance recovery, income tax, penalty, other) are entered
  per employee while it is a draft; every change works the run out again.
  Amounts are rounded to the currency's smallest unit per item.
- **Approval** by someone with `payroll.approve` other than the preparer;
  refused with nobody paid or any net pay below zero. Approved runs and
  their lines can no longer change (triggers); then paid on a date, or
  cancelled with a reason before payment.
- **Payslips**: PDF per employee (company letterhead, components,
  additions, deductions, employer contributions as a note); employees
  linked to a sign-in see their own approved payslips under My payslips.
- **Bank file**: a plain CSV of bank-paid employees (number, name, bank,
  IBAN, net, reference) for approved runs, audited by count — not a bank's
  or WPS format.
- **Not yet**: income tax, end of service, salary splits and the P&L came
  in HR4b (ADR-124); WPS / Mudad files wait for their specifications.

### ADR-124 Entered income tax and end of service, salary splits, payroll in the P&L — Accepted (HR4b built; WPS / Mudad files wait for specifications)

Decision (2026-11-05): build the remaining payroll rules as engines the
organization fills in — nothing statutory preset (Q-20) — and add the WPS
and Mudad files only once their specifications or sample files are
provided.

- **Income tax tables** per company, dated, with source and who they apply
  to (as ADR-123): an annual exemption, whether employee contributions
  come off taxable pay, and one or more **bands** of annual taxable income
  each with its own progressive **brackets** (so a law where higher
  incomes lose the lower brackets is entered as bands). The month's
  taxable pay (gross less unpaid leave, less contributions if so set,
  leaving out an end-of-service payment) is annualised ×12, the exemption
  taken off, the band found and its brackets applied; the month's tax is a
  twelfth. One table may cover an employee at a time (overlaps refused).
- **End-of-service rules** per company, dated, with source: the base
  (basic, or basic + allowances marked for end of service), tiers of
  months of pay per year of service from each number of years (starting at
  0), an optional cap in months, and the share paid on resignation by
  years (none: paid in full). Years of service are days ÷ 365 from hire.
  Overlaps refused as for tax.
- **Accrual**: each line holds the end of service owed at month end
  (before any resignation share) and the month's change from the last
  approved month — the employer's accrual.
- **Settlement**: for an employee who leaves in the run's month, payroll
  adds an END_OF_SERVICE addition from the rule in force on the leaving
  day, the salary then and — when they resigned — the rule's share; once
  per run, never typed by hand, not taxed.
- **Salary changes within a month**: each salary pays the days it covers
  (on a 30-day month the last part takes up the difference); unpaid leave
  comes off at the salary of the days it falls on.
- **P&L**: approved and paid runs add to the branch's **Staff** row by pay
  month — cost to the employer plus the end-of-service accrual, less
  settlements paid from it. Staff costs entered as operating expenses
  still count too, so organizations using payroll should stop entering
  salaries as expenses.
- **Not yet**: WPS (UAE and others), Mudad (Saudi Arabia) and bank-specific
  files — waiting for the specifications or sample files; cumulative
  (year-to-date) tax methods; service years net of long unpaid leave;
  retro pay; overtime from rosters; a payroll journal for accounting.

### ADR-125 Training and certification — Accepted (HR5a built)

Decision (2026-11-05): HR5 is built in three parts — **HR5a learning**
(this), HR5b performance (goals, reviews, ratings) and HR5c engagement
(surveys, recognition). Learning comes first because food businesses must
show that staff hold food-hygiene and safety training.

- **Courses**: the organization's catalogue — code, name (English and
  Arabic), category (food safety, allergens, hygiene, health and safety,
  fire safety, first aid, equipment, service, onboarding, other), delivery,
  and how long a certificate is valid in months (none: no expiry). Courses
  are archived, never deleted.
- **Requirements**: a course is required of everyone, a job title (matched
  without regard to case), a department or a branch, due within N days of
  hire (default 30). With several requirements for one course, the
  shortest deadline counts.
- **Sessions** (TRN-) at a branch: course, local date and time, trainer,
  place, optional capacity. Participants are the branch's staff (others
  only where the person may manage training too). Attendance is invited,
  attended or absent, with passed or failed for those who attended.
  Completing needs everyone marked; each pass becomes a training record
  dated the session's day, expiring by the course's validity (same day N
  months on, or the month's last day). A completed or cancelled session
  no longer changes (trigger).
- **Records from elsewhere**: an outside provider's course with its date
  (not in the future), provider and certificate number; the certificate
  scan is attached to the record (ADR-051). Records never change; a
  mistake is voided with a reason (trigger).
- **Compliance** per employee and required course: **valid** (through the
  expiry day; no expiry stays valid), **expiring** within 30 days,
  **expired**, **due** (none yet, before the deadline after hire) or
  **overdue**. The record expiring last counts. The training page shows
  the matrix with the share held and valid, filters by branch and by
  lapsed or expiring, and exports CSV; Needs attention counts lapsed and
  expiring trainings; the employee page and My training show the same.
- **Access**: `training.view` and `training.manage`, per branch —
  administrators, operations managers, branch managers and food safety
  manage; analysts view. The catalogue and requirements need
  organization-wide `training.manage`. Employees see their own.
- **Not yet**: online course content, quizzes, reminders to the employee,
  training cost, the food-safety compliance score taking training into
  account, development plans (with HR5b).

### ADR-126 Goals and performance reviews — Accepted (HR5b built)

Decision (2026-11-05): performance runs in review cycles on a fixed 1–5
scale (unsatisfactory, needs improvement, meets expectations, exceeds
expectations, outstanding), with the manager from the HR reporting line
(ADR-079) as reviewer and HR holding the final say.

- **Goals** per employee: title, description, weight 0–100 %, due date,
  progress 0–100 % and an outcome (open, achieved, partly achieved,
  missed, cancelled). Set by HR at the branch or by the employee's own
  manager; the employee updates progress, not the outcome. Goals in one
  cycle weigh at most 100 % together (cancelled ones aside); none can be
  added once the review is rated.
- **Cycles**: a name, a period, self-review and manager-review due dates,
  for one branch or every branch (HR scope). **Launching** opens a review
  for each active employee hired by the period's end, with their manager
  at that moment as reviewer (none: HR reviews). **Closing** needs every
  review final or skipped.
- **A review** moves forward only: the employee's self-review (a comment
  and a rating per goal) → the manager's review (a rating for every goal
  of the cycle, an overall rating, strengths and what to work on; it can
  come without a self-review) → the employee acknowledges, with a comment
  → HR finalizes: the manager's rating, or another with a reason. HR may
  skip a review with a reason (long leave, left). Nobody reviews or
  finalizes their own. A final or skipped review never changes (trigger).
- **Who sees what**: the employee sees the manager's part once submitted;
  the manager sees the self-review once submitted; HR sees all at their
  branches. The goal score is the manager's goal ratings weighted by
  goal weight (a plain average when no goal carries weight), shown beside
  the overall rating the manager chooses.
- **Reporting**: each cycle shows progress by status and the rating
  distribution (final, else the manager's). Needs attention shows each
  person the reviews waiting for them; My performance lists their goals,
  reviews and the reviews they give.
- **Access**: `performance.view` / `performance.manage`, per branch —
  administrators, operations managers and branch managers. Managers need
  no permission to set their own reports' goals or review them.
- **Not yet**: 360° and peer feedback, competency frameworks, ratings
  feeding pay changes, reminders by e-mail, development plans.

### ADR-127 Anonymous staff surveys and recognition — Accepted (HR5c built; HR5 complete)

Decision (2026-11-05): engagement is measured with anonymous surveys and
encouraged with a recognition wall. Anonymity is built into the data, not
just the screens.

- **Surveys** for everyone or one branch: a title, an introduction, an
  optional closing day, and up to 50 questions — agreement 1–5, 0–10
  "would you recommend working here" (eNPS), yes or no, or free text;
  each required or optional. Questions change only in a draft (trigger);
  opening counts the staff who can answer (active employees with a
  sign-in); answers arrive only while open (trigger).
- **Anonymity**: an answer set (`engagement_responses`) holds the survey,
  the respondent's branch and the day — no employee, a random id (not
  time-ordered) and no time. A separate participation row says only that
  an employee answered, without a timestamp, to stop a second answer.
  Submitting writes nothing to the audit log. Answers are never changed or
  deleted (no grants). Free-text answers are shown in a keyed hash order,
  not the order they came in.
- **Results** only from **five answers** (overall, and for each branch in
  a breakdown): response rate against those asked, eNPS (% 9–10 less %
  0–6) with promoters, passives and detractors, average and spread of
  agreement, share of yes, and the free text. Branch-scoped viewers of an
  all-branch survey see only their branches' answers — and only from five.
- **Recognition**: any employee with a sign-in thanks a colleague (not
  themself) for teamwork, guest service, food safety, cleanliness,
  leadership or going the extra mile, with a message, on a wall the whole
  organization sees. HR at the colleague's branch can hide a post with a
  reason (still visible to HR, marked hidden).
- **Access**: `engagement.view` (results) and `engagement.manage`
  (surveys, moderation), per branch — administrators and operations
  managers manage, branch managers view. Answering and the wall need only
  an employee record linked to the sign-in. Needs attention shows each
  person the surveys waiting for them.
- **Not yet**: recurring pulse surveys, survey templates, comparing
  cycles over time, reactions and comments on recognition, rewards.

### ADR-128 Rosters, overtime and onboarding checklists — Accepted (HR2c built; HR2 complete)

Decision (2026-11-05): branches plan who works when, the plan is compared
with the clock-ins of ADR-080, overtime is decided by a manager and paid
through payroll (ADR-123), and new hires get onboarding checklists.

- **Settings, entered not preset**: grace minutes (lateness and leaving
  early up to this are not flagged), an overtime minimum (extra time below
  it is not overtime), standard daily hours, an overtime multiplier and
  whether it applies to basic pay or basic and allowances. No country's
  overtime rule is built in (as Q-20). Organization-wide HR sets them.
- **Shift templates**: local start and end (an end at or before the start
  is the next day) and an unpaid break.
- **Shifts**: one person, one branch, one local day, from a template or
  own times; start and end are also stored as instants in the branch's
  time zone. Refused when they overlap another of the person's shifts
  (checked under a row lock on the employee), fall on approved leave, are
  outside employment, or the break is as long as the shift. Drafts are
  added and removed freely; **publishing** a week shows them to staff.
  A published shift is never edited or deleted, only cancelled with a
  reason (trigger) — and not once overtime was decided on it. A week can
  be copied into another as drafts; clashes, leave and leavers are skipped.
- **Comparison** with clock-ins: the person's sessions (ADR-080
  timesheet) are each given to one shift — the one they overlap most, or
  the nearest within two hours — so split shifts never share a session.
  Late and early count beyond the grace minutes; worked = the sessions
  less the break; overtime = worked beyond the planned paid minutes, from
  the minimum. Outcomes: upcoming, in progress, on time, late or early,
  no-show (shown as leave on approved leave), or missing punch — a
  missing clock-in or clock-out is never guessed.
- **Overtime** is decided once per shift by someone with
  `rosters.manage` at the branch — never by the person themself —
  approving up to the measured minutes, or rejecting. The decision cannot
  change (trigger). Payroll's **Add overtime from rosters** turns each
  approved, unpaid decision for someone on a draft run, up to the month's
  end, into an OVERTIME addition: the multiplier × hours × monthly base ÷
  (days of the run's proration basis × standard daily hours), on the
  salary in force that day, rounded to the currency. Removing the addition,
  or cancelling the run, frees it for a later run.
- **Labour cost** on the week, for those with `payroll.view` only:
  planned and worked hours at straight time, at gross monthly pay (basic
  and allowances) as an hourly rate. Employer contributions and overtime
  premiums are not included; shifts of people without a salary record are
  counted as not costed.
- **Onboarding**: organization-wide HR keeps checklist templates whose
  tasks are for HR, the line manager or the new employee, each due so
  many days from the start (−30 to 365). Starting one for an employee
  copies its tasks (later template edits do not change it), from the hire
  date unless another start is given; one open copy of a template per
  employee. HR at the branch ticks any task, the line manager (the
  employee's manager's sign-in) manager tasks, the employee their own; the
  last tick completes the checklist. HR may cancel it with a reason.
- **Access**: a new branch-scopable `rosters.manage` (administrators,
  operations managers and branch managers) plans rosters and decides
  overtime; viewing needs `hr.view`. Staff see their published shifts in
  My roster and their checklists in Onboarding. Needs attention shows HR
  overdue onboarding tasks and each person the tasks waiting for them.
- **Not yet**: demand-based scheduling from forecasts, shift swaps and
  open shifts, availability, labour cost against sales, break rules,
  night or holiday premiums, onboarding documents to sign.

### ADR-129 Recruitment and workforce planning — Accepted (HR3 built)

Decision (2026-11-05): branches plan their positions, ask to recruit
against the plan, and run candidates through to a hire that creates the
employee.

- **Workforce plan**: a planned headcount per branch and job title, set by
  HR at the branch. Titles match employees' titles without regard to case
  or spacing. The plan page shows planned, in post (active and on leave),
  in recruitment (places left on openings waiting or open) and the gap —
  to fill, on plan, or over plan; titles with people but no plan show
  with zero planned.
- **Openings** (JOB-year-number) for a branch, job title, optional
  department, employment type, places, reason (new position, replacement,
  seasonal), target start and description. Requested with
  `recruitment.manage` at the branch; the places beyond the plan's gap at
  that moment are recorded and shown to the approver (not a block).
  Organization-wide HR approves or rejects — never the requester. An open
  opening fills with its last hire; it is closed by hand only once no
  candidate is still in play.
- **Candidates** (personal data): name, e-mail (one live record per
  address), phone, source, note, CVs as attachments. Names and contact
  details are never written to the audit log. Scoped staff see the
  candidates on their branches' openings and those they added.
- **Applications** move APPLIED → SCREENING → INTERVIEW → OFFER, one step
  forward or out to REJECTED or WITHDRAWN (with a note), each change
  recorded. HIRED only through a hire; closed applications never move
  (trigger).
- **Interviews** (in person, phone, video or **trial shift**) are scheduled
  while screening or interviewing — the first moves a screened candidate
  to interview — with an interviewer who is any member of the
  organization. Only the interviewer scores, once it has begun: rating
  1–5 and hire / unsure / do not hire, with notes. Scorecards are
  summarised on the application and the opening.
- **Hire** at the offer stage, by HR at the branch: in one transaction
  the employee is created from the candidate and the opening (title,
  branch, department, employment type), with a hire date and optional line
  manager; the application closes as hired, the opening counts the hire
  and fills with the last place, and an onboarding checklist (ADR-128)
  starts if chosen.
- **Retention**: organization-wide HR erases a candidate with nothing
  open — names, contact, notes, interview notes and CVs; the records stay
  for counts. An optional retention (30–3650 days, none preset) erases
  such candidates automatically after their last activity (daily job
  `recruitment.purge`).
- **Access**: new `recruitment.view` and `recruitment.manage`, per branch
  (administrators, operations managers and branch managers);
  organization-wide `hr.manage` approves, sets retention and erases;
  hiring needs `hr.manage` at the branch. Needs attention shows HR openings
  to approve and each interviewer the interviews to score.
- **Not yet**: a public careers page and online applications, job-board
  posting, offer letters with pay (pay stays in payroll), e-mail to
  candidates, a talent pool, headcount budgets in money.

### ADR-130 HR analytics — Accepted (HR6 built; HR complete)

Decision (2026-11-05): one HR analytics page reads the HR modules for a
range of months (the last twelve by default, at most 36, never past this
month) and optionally one branch. It holds counts and rates only — nothing
per person — and needs no new data.

- **Headcount and turnover**: a person counts from their hire date
  through their last day. Per month: headcount at the start and end, hires,
  leavers, and turnover = leavers ÷ the average of start and end. Over the
  range: turnover = leavers ÷ the average of the monthly averages. Known
  limits: people count at their current branch (no transfer history), and
  a rehire replaces the earlier leaving date (ADR-079).
- **People on the last day**: by branch and department, tenure bands
  (under 3 months, 3–12 months, 1–3 years, over 3 years), and new-hire
  retention — of those hired in the range who are 90 days past hire, the
  share still employed on day 90.
- **Absence**: approved leave days inside the range by type (paid or
  unpaid), and the absence rate = leave days ÷ (average headcount ×
  calendar days).
- **Rosters** (ADR-128): published shifts that have ended — no-shows
  (excluding approved leave) and lateness as shares, planned and worked
  hours, approved overtime.
- **Recruitment** (ADR-129), for those who see recruitment: openings
  approved and their places, candidates per opening, hires through
  recruitment, approval-to-hire days (average and median), offers
  accepted (offers leading to a hire ÷ offers closed), and sources of
  hire.
- **Pay** (ADR-123), with `payroll.view` only: approved and paid runs per
  month and run currency — people paid, gross, employer cost and cost per
  head (Decimal, not converted between currencies).
- **Training** (ADR-125) compliance today and **performance** (ADR-126)
  ratings of reviews in cycles ending in the range, each for those with
  that module's view right. Engagement results are left to the survey
  page, so its five-answer anonymity rule (ADR-127) is never bypassed.
- **Access**: `hr.view` or `hr.manage`; every count is limited to the
  branches the user sees in HR, and a branch outside them falls back to
  all of theirs. The monthly series exports as CSV.
- **Not yet**: transfer history for counts by branch over time, voluntary
  versus involuntary leaving (needs a leaving-reason list), absence
  against rostered days, cost against sales, charts, and HR questions for
  the AI assistant.

### ADR-131 Food consultant chatbot (Arabic and English) — Accepted (built)

Decision (2026-11-09): staff get a food consultant that answers food
business questions in Arabic or English, from general expertise and from
the organization's own recipes. Audience: signed-in staff only (no public
widget). Built as a second mode of the AI assistant (ADR-122), so it uses
the same Claude key, model, switch, daily question limit, retention and
audit.

- **Expertise**: food safety and hygiene (HACCP, cooling and holding,
  cross-contamination), recipe development, menu engineering and pricing,
  food cost and waste, kitchen workflow, purchasing and storage, allergen
  management and nutrition basics — practical steps, quantities,
  temperatures and times.
- **Its own data, read only**, through the services the app's pages use,
  as the asking person: find recipes; dish cost per portion, price, food
  cost %, margin, target and the price that meets it; one recipe's
  allergens and nutrition per portion and per 100 g/ml; the allergen
  matrix for one allergen or all 14. Each answer links the pages behind
  it.
- **Guard rails in its instructions**: anything about the organization's
  own dishes comes only from the tools; a dish is never called free from
  an allergen unless every ingredient is verified free (UNKNOWN means it
  must be checked); nutrition, allergen statements, prices, costs and
  legal limits are never invented; rules that differ by authority (SFDA,
  Egyptian NFSA, GCC standards, Codex) are given as general good practice
  with the advice to check the binding local rule; medical diets and
  severe allergies are referred to a qualified professional. Tool results
  are data, not instructions.
- **Language**: the reply follows the interface language (Modern Standard
  Arabic in Arabic, keeping codes, numbers and units) and the question's
  language; text is shown right to left in Arabic.
- **Access**: a new `consultant.use` — administrators, operations and
  branch managers, food safety, kitchen, procurement, warehouse and
  finance; not analysts (view only), cashiers, waiters or drivers. It is
  separate from `assistant.use`, so kitchen staff can ask the consultant
  without the business assistant. Someone who cannot see recipes still
  gets general advice; the recipe tools refuse them. Conversations carry
  their mode, are listed per mode and read only by their author; a
  follow-up stays in its conversation's mode.
- **Not yet**: a public guest chat, photos of dishes or labels, voice,
  answers from the organization's own SOP documents.

### ADR-132 Nutrition engine with USDA FoodData Central — Accepted (built)

Decision (2026-11-09): the ingredient library (ADR-041) becomes a full
nutrition engine. Foods come from USDA FoodData Central (live API or bulk
downloads) and from the organization's own entries. Every nutrient is
stored with its source and status. Search is local, USDA, or both.
Calculations scale servings and recipes. A REST API and admin pages sit
on top. The existing tables are extended rather than duplicated:

- `reference_foods` stays the food record, now with barcode, category,
  declared ingredients, last fetch, content hash, verification and
  archiving.
- Product nutrition profiles stay the override layer.
- Allergen declarations stay as they are.

- **Storage.** Shared nutrient dictionary (`nutrients`):
  - 57 seeded nutrients, mapped to USDA nutrient ids and numbers; 13 are
    label nutrients and 36 have Arabic names.
  - Each organization can add nutrients of its own.
  - Nutrients USDA publishes that are not in the dictionary are learned as
    shared rows.

  Per food:
  - `food_nutrient_values`: status REPORTED, CALCULATED, BELOW_DETECTION
    or NOT_APPLICABLE, with the amount and unit as published, the
    standardized amount, the derivation and the number of data points.
  - `food_portions`: servings, with gram weight and, only when the source
    gives one, millilitres.
  - `food_source_versions`: the raw payload, kept once per content hash and
    never updated.
  - `food_aliases` (English or Arabic).
  - `food_identifiers`: FDC id, GTIN/UPC, NDB number, food code.
  - `food_categories`, with an Arabic name.
  - `nutrition_sync_jobs`.
  - `food_data_issues`.
  - `nutrition_settings`.

  All tables are tenant-owned with row-level security. Shared nutrients
  can be read by every organization but are written only by the system.

- **Never inventing values.**
  - A nutrient the source does not give is MISSING, never 0. Totals are
    null unless every ingredient reports the nutrient; the known part is
    shown separately.
  - Below-detection values have no figure.
  - Only mass units are converted. Millilitres become grams only through a
    density taken from the food's own serving that has both weight and
    volume; otherwise the request fails with `NUTRITION_NEEDS_DENSITY`.
  - Salt from sodium (× 2.5) and kJ from kcal (× 4.184) are added only
    when the source gives none, and are marked CALCULATED.
  - All arithmetic uses Decimal.
- **Precedence.** USDA data never overwrites a product's verified
  nutrition profile (laboratory analysis, manufacturer specification or
  verified label):
  - Linking a library food to a product that has a specification is
    refused.
  - The recipe panel uses the profile for the nutrients it gives and the
    library food only for the rest.
  - When a refresh changes a verified library record, the record returns
    to awaiting verification and a finding is raised.
  - Declared ingredients and scientific names are shown as published and
    not translated.
- **USDA access.**
  - The key is `USDA_FDC_API_KEY`, server-side only. It is sent in the
    `X-Api-Key` header and never to browsers or clients.
  - Each call has a 15 s timeout and up to 3 attempts with exponential
    backoff and jitter, honouring Retry-After.
  - An hourly budget shared by all instances is enforced through the rate
    limiter (`USDA_FDC_REQUESTS_PER_HOUR`, default 1,000).
  - USDA search answers are cached for 10 minutes.
  - Without a key, or when USDA is down, a HYBRID search still returns the
    library's results and says why USDA was skipped.
- **Search modes.**
  - LOCAL: names in either language, brand and aliases by similarity
    (trigram); FDC id and barcode by exact match.
  - USDA: FoodData Central only.
  - HYBRID (default): library matches first, then USDA results not already
    in the library.
- **Sync.**
  - Imports by id run either immediately (up to 100) or as a job (up to
    5,000, in batches of 20 with a checkpoint).
  - Refresh re-fetches stale records, oldest first; a record is stale after
    `refresh_days`, default 90.
  - A weekly release check records USDA's latest publication dates.
  - A nightly schedule runs for organizations that turn auto-refresh on.
  - Jobs run on the job runner (ADR-087) as the person who asked for them,
    and only while that person still holds `nutrition.manage`.
  - A failed or partly failed job is retried from its checkpoint.
  - Bulk downloads are imported by `pnpm nutrition:import-usda`. It streams
    the file (wrapped JSON, a bare array or JSON Lines) in transactions of
    200 records, falls back to one record at a time when a chunk fails,
    and resumes the same file from its checkpoint.
- **Quality.**
  - Raised on import: missing label nutrients, implausible values (more
    than 100 g per 100 g, more than 900 kcal, proximates summing above
    105 g), unexpected or unconvertible units, duplicate barcodes, values
    changed after verification.
  - Raised by a scan: stale records, duplicate name and brand, records
    without a source.
  - Only one open finding of each kind per food. A person closes it as
    resolved or ignored, with a note.
- **REST API.** Seventeen endpoints under `/api/v1/nutrition`: search,
  create or import, read, update, nutrition of an amount, servings,
  refresh, calculate, compare, barcode, nutrients, categories, sources,
  recipe analysis, sync status, jobs, request sync, health.
  - They use the ADR-090 framework.
  - New scopes: `nutrition:read`, and `nutrition:write` (the first scope
    that allows changes).
  - Write routes take JSON bodies of at most 1 MB and answer 415, 413 or
    400 for a wrong content type, too large a body or invalid JSON.
  - Validation errors list their fields. Business rule errors carry their
    `rule`. USDA failures map to 503, 429 or 404.
  - Every endpoint is described in OpenAPI 3.1 at `/api/v1/openapi.json`
    and in an in-app reference at Settings → API keys → Endpoint
    reference. A hosted Swagger UI was not added because its third-party
    scripts conflict with the strict CSP (ADR-074).
- **Pages** (English and Arabic, right to left): Nutrition overview,
  Foods (search and import), food profile, new food, USDA, Nutrients, Data
  quality, Sources.
  - The food profile has a serving calculator, every nutrient grouped with
    its status, the label nutrients missing (with "not applicable"),
    servings, names and aliases, verification, archiving, refresh and
    source versions.
  - The recipe nutrition page gains a full nutrient panel: total, per
    portion and per 100 g finished, with the source of each ingredient.
  - The existing file import at Catalog → Ingredient library stays and
    links to the profile.
- **Permissions**: the existing `nutrition.view` and `nutrition.manage`.
  Sync jobs and settings need organization-wide `nutrition.manage`.
- **Not yet / to confirm**:
  - Live USDA has not been verified from the build environment because
    its network policy blocks the USDA hosts. It works once
    `USDA_FDC_API_KEY` is set on the server.
  - The Arabic nutrient and category names need review by a nutrition
    professional before they appear on consumer labels.
  - Market label layouts (Q-02).
- **Added the same day**:
  - Foods entered by hand get kJ from kcal and salt from sodium, marked
    CALCULATED, when the inputs are given and the result is not. An entered
    value or "NA" always wins.
  - A live Open Food Facts lookup by barcode. It runs only from the server,
    with a generic client name, a 10 s timeout, 2 attempts, a budget shared
    by all instances (`OPEN_FOOD_FACTS_REQUESTS_PER_MINUTE`, default 60) and
    a switch (`OPEN_FOOD_FACTS_LOOKUP`, on by default; no key).
    - It feeds the barcode lookup, a preview on the Foods page and an
      import (page, and API `POST /nutrition/foods` with `offBarcode`).
    - Records go through the file import's parser (ADR-041). Allergen tags
      become CONTAINS or MAY_CONTAIN only; missing values stay missing.
    - Records are stored unverified, with a source version, identifiers and
      the declared ingredients as published. A record that changed after
      it was verified goes back to awaiting verification.
    - Open Food Facts is crowd-sourced, so a record is only a lead. It
      never replaces a manufacturer specification (the existing linking
      rule).

### ADR-133 Product photos, menu item barcodes and menu boards — Accepted (built)

Decision (2026-11-10): products and menu items carry a photo, which the
till, self-order kiosks, the online ordering page and a new menu board
screen show. Menu items can be scanned at the till and kiosk by barcode.

- **Photos.**
  - One photo per product and per menu item. An item without its own photo
    shows its product's photo.
  - Upload: JPEG, PNG or WebP, at most 5 MB. The format is checked from the
    file's content, never its name. A decompression-bomb limit applies.
  - The server re-encodes every photo with sharp: turned upright, at most
    1200 px a side, saved as WebP without metadata (no camera or location
    data). Only these re-encoded images are stored (`media_images`, with a
    CHECK on type, size and dimensions) and served, so an uploaded file is
    never sent back as it came.
  - Photos are served at `/media/{id}` without sign-in, because the
    ordering page, kiosks and boards are public. Ids are random UUIDs and
    the response is the image only, with `nosniff` and a sandboxing CSP.
    A new photo gets a new id, so the response can be cached forever.
  - Replacing or removing a photo deletes the old image once nothing uses
    it.
  - Permissions: `catalog.manage` for products, `menu.manage` for menu
    items.
- **Barcodes.**
  - Product barcodes already existed (catalog, with GS1 check digits).
  - A menu item may now have its own barcode, e.g. a packed sandwich made
    from a recipe. It accepts EAN-8, UPC-A, EAN-13 or GTIN-14 with a valid
    check digit, or any printable code (Code 128, QR, in-house labels). It
    is unique among menu items, and it is refused if it is another
    product's barcode, so a scan always names one item.
  - The menu feed (`sellableMenu`) gives each item its barcodes: its own
    and its product's.
  - The till and the kiosk match scans on the device, from the menu they
    already hold, so scanning works offline. A UPC-A scanned as EAN-13
    (with a leading zero) still matches.
  - Barcode scanners act as keyboards: the code plus Enter adds the item,
    or opens its options when it has any. An unknown code is reported and
    adds nothing.
- **Menu boards** ("plug and play" screens).
  - A new ordering channel kind, `BOARD`, under Point of sale → Online
    ordering setup. Its address `/board/{token}` is opened full screen on
    any TV, tablet or signage player.
  - The board shows the branch's menu by category, with photos, English
    and Arabic names and prices, and refreshes every minute. It needs no
    sign-in, no floor and no register.
  - It takes no orders: placing one is refused, and payment, kitchen and
    pick-up settings are ignored for it.
- **Added (2026-11-10)**:
  - **More photos**: up to four after the main one, on a product or a
    menu item. A menu item uses its own set of photos when it has any,
    otherwise its product's. Boards show the photos in turn; the till,
    kiosk and ordering page show the main photo.
  - **Board options**: a light or dark theme, independent of the screen's
    own setting, and pages that turn every 8–60 seconds for long menus.
    Pages keep a category together where it fits.
  - **Board hours per menu category**: for example breakfast from 06:00
    to 11:00, in the branch's time zone. A window may run past midnight.
    One screen therefore changes its menu through the day.
- **Not yet**: videos. They need file storage outside the database
  (object storage), which is a hosting decision (Q-03).

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

| ID   | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Needed by                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Q-01 | ~~Inventory valuation method~~ — **Decided:** moving weighted average per product × warehouse (ADR-021).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | M3                        |
| Q-02 | ~~Target launch markets~~ — **Decided for VAT:** Saudi Arabia, Egypt and the GCC (ADR-037). Still open: allergen/label rules and data residency per market.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | M5 (labels), M8 (hosting) |
| Q-03 | Hosting provider and region / data-residency requirements. **Demo:** Render, Frankfurt (ADR-076); production still open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | M8 (pilot)                |
| Q-04 | ~~Purchase approval policy~~ — **Decided:** two branch approvals, then head office (ADR-049); configurable per organization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Q-05 | ~~Foreign-currency supplier invoices~~ — **Decided:** USD, EUR, SAR, EGP and the GCC currencies with exchange rates; reported in the base currency (ADR-050).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q-06 | Which POS / accounting systems do pilot customers use (for import formats and exports)?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M7                        |
| Q-07 | SSO (Google/Microsoft)? **2FA available:** optional authenticator-app sign-in (ADR-073); still open: SSO, and whether 2FA is required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | M1 (nice to know)         |
| Q-08 | ~~Attachments~~ — **Decided:** up to 3 MB per file, kept 3 years (ADR-051).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Q-09 | ~~Over-receipt tolerance~~ — **Decided:** 0 % (ADR-023); still configurable per organization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Q-10 | Which email provider should send invitations, password resets and notifications? Until then there is **no self-service password reset**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | M2 (before pilot)         |
| Q-11 | ~~Changeable base currency~~ — **Decided:** fixed at creation; documents in other currencies are converted to the base currency for all reporting (ADR-050).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Q-12 | ~~Count approval~~ — **Decided:** stock counts use the approval matrix like purchase orders, by value of differences; counter never approves (ADR-049).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Q-13 | Product categories — **default in place** (ADR-025): flat list, optional per product. Confirm, or ask for a hierarchy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | M3                        |
| Q-14 | ~~Scope versus Foodics~~ — **Decided:** option C, full point of sale in scope (ADR-022, milestones POS1–POS5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                         |
| Q-15 | ~~Payment provider and card terminals~~ — **Decided for Saudi Arabia:** acquirer mada terminals recorded on the till (ECR integration per acquirer when known), pay by QR with Moyasar (ADR-066). Other markets open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | POS3                      |
| Q-16 | ~~POS devices~~ — **Decided:** tablets, web app and mobile app from one installable web app; store apps by wrapping it (ADR-057). Printers: 80 mm via the browser until hardware is chosen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Q-17 | ~~First market for live POS sales~~ — **Decided:** Saudi Arabia; POS4 builds ZATCA Phase 2 first (ADR-064).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | POS4                      |
| Q-18 | ~~Delivery platforms~~ — **Decided:** HungerStation, Jahez and Keeta first, through one plug-and-play adapter design so any platform with the same concept is added as an adapter (POS5c).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | POS5                      |
| Q-19 | Store apps: the app id (permanent once published, e.g. `com.<company>.foodambassador`) and who owns the Apple and Google developer accounts (organization enrolment). Needed before the first store upload (ADR-061).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | POS1d release             |
| Q-20 | Payroll (HR4) — **Countries decided:** Saudi Arabia, Egypt and the GCC (same markets as VAT, ADR-037). **HR4a and HR4b built** with every rule (contributions, income tax, end of service) entered by the organization, dated, none preset (ADR-123, ADR-124); WPS / Mudad files wait for their specifications. Still open: confirmation of the rules to apply per country — social insurance (GOSI, Egypt NOSI, UAE GPSSA, Kuwait PIFSS, Bahrain SIO, Oman SPF, Qatar GRSIA) rates and caps for nationals and expatriates, wage protection files (Saudi Mudad, UAE WPS and others), end-of-service rules, Egyptian income tax — plus pay cycle and banks. Rules are entered as dated settings, not invented. | HR4                       |
