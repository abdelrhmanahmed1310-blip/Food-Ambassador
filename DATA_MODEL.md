# Food Ambassador — Data Model

Status: **§2–§4 implemented (Milestones 1–2)**; later sections are the design baseline.
Models are added to `prisma/schema.prisma` milestone by milestone. This document is the
contract those migrations implement. Changes to invariants here require a
DECISIONS.md entry.

Legend: **PK** primary key, **FK** foreign key, **UQ** unique constraint,
**IX** index, **CK** check constraint. `org` = organization (tenant).

---

## 1. Cross-cutting conventions

### 1.1 Identifiers

- All primary keys are UUIDv7 (`@default(uuid(7))`): globally unique, not
  guessable sequentially, and time-ordered for good B-tree locality.
- Human-facing document numbers (e.g. `PO-2026-000123`) are separate columns,
  unique per organization, generated from a per-org, per-document-type sequence
  row locked inside the creating transaction (gap-free is not guaranteed and not
  promised; uniqueness is).

### 1.2 Tenancy columns and composite keys

- Every tenant-owned table has `organization_id UUID NOT NULL`.
- Every tenant-owned table declares **UQ (organization_id, id)**.
- Every FK between tenant-owned tables is **composite**:
  `(organization_id, parent_id) → parent(organization_id, id)`.
  This makes it impossible at the database level for a row in organization A
  to reference a warehouse, product or lot from organization B, even if
  application code has a bug.
- Every list query's leading index column is `organization_id`.
- Global (non-tenant) tables: `users`, auth tables, `permissions` catalogue,
  system units of measure, allergen catalogue. These are read-only to tenants
  or user-scoped.

### 1.3 Timestamps, actors and time zones

- `created_at`, `updated_at` (`timestamptz`) on all mutable tables;
  `created_by_user_id` / `updated_by_user_id` on business records.
- Posted/immutable records carry `posted_at` and `posted_by_user_id`.
- Instants are `timestamptz` (stored UTC). Business calendar values —
  expiry date, best-before date, count date — are `date`, interpreted in the
  organization's (or branch's) IANA time zone (`organizations.time_zone`).
- "Today" for expiry evaluation = current date in the warehouse's branch time
  zone, falling back to the organization time zone.

### 1.4 Numeric precision

No floating-point type is used for quantities, costs or money — in the
database (`NUMERIC` only) or in application code (`decimal.js` via
`src/lib/decimal.ts`; JS numbers are rejected unless they are safe integers).

| Kind                       | PostgreSQL type   | Rounding                   |
| -------------------------- | ----------------- | -------------------------- |
| Quantity                   | `NUMERIC(20, 6)`  | half-up at 6 dp            |
| Unit cost / price          | `NUMERIC(20, 6)`  | half-up at 6 dp            |
| Money (line & document)    | `NUMERIC(19, 4)`  | half-up at 4 dp            |
| Unit conversion factor     | `NUMERIC(30, 12)` | exact, no rounding at rest |
| Percentages (yield, waste) | `NUMERIC(9, 6)`   | stored as fraction 0–1     |

Rounding happens once, at the boundary where a value is persisted; intermediate
calculations use 40 significant digits. Allocation of a total across lines
(landed cost, invoice discounts) uses largest-remainder allocation so lines sum
exactly to the total (`allocateProportionally`).

### 1.5 Currency

- Each organization has one **base currency** (`organizations.base_currency`,
  ISO 4217). All costs and inventory valuation are in base currency.
- Documents (PO, supplier invoice) store `currency_code`; in the MVP it must
  equal the base currency (CK enforced in application validation). Multi-currency
  with exchange rates is deferred (see DECISIONS.md, open question Q-05).

### 1.6 Deletion, archival and retention

| Record class                                | Rule                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Master data (product, supplier, warehouse…) | Never hard-deleted once referenced. `archived_at` hides it from pickers; history keeps it.                                               |
| Draft documents (unposted PO, draft count)  | May be hard-deleted or cancelled by permitted users; deletion is audit-logged.                                                           |
| Posted documents                            | Immutable. Corrected only by reversal/credit documents. Status may move to `CANCELLED` only via a reversal.                              |
| Inventory ledger entries                    | Append-only. UPDATE/DELETE rejected by a database trigger.                                                                               |
| Audit events                                | Append-only, trigger-protected. Retained indefinitely in MVP.                                                                            |
| Users                                       | Deactivated, not deleted, while referenced as actor. Personal data erasure (on request) pseudonymizes name/email but keeps the actor ID. |
| Attachments                                 | Metadata soft-deleted; blob removed after retention window (to be defined, Q-08).                                                        |

---

## 2. Identity, tenancy and access control (Milestone 1 — implemented)

Implemented in `prisma/schema.prisma` and migration
`20261029055457_m1_identity_tenancy` (which also holds the hand-written CHECK
constraints, partial/NULLS NOT DISTINCT indexes, the audit trigger and the
row-level security policies).

```
User ─< OrganizationMembership >─ Organization ─< Branch ─< Warehouse ─< StorageLocation
                │
                └─< MembershipRole >─ Role ─< RolePermission (permission code from code catalogue)
                     (scope: organization | one branch | one warehouse)
Organization ─< Invitation (role + scope, hashed single-use token)
```

### users (global, no RLS)

`id`, `email` (UQ; CK lower-case so uniqueness is case-insensitive), `name`,
`email_verified`, `image`, `locale` (`en` | `ar`), `status`
(`ACTIVE` | `DISABLED`). Credentials and sessions live in Better Auth tables
(`accounts` — password hash, `sessions`, `verifications`) linked by `user_id`.
Tenant transactions can read only `id, name, email, locale, status` of users
(column grant) and nothing from `accounts` or `sessions`.

### organizations

`id`, `name`, `slug` (UQ; CK `^[a-z0-9]+(-[a-z0-9]+)*$`), `base_currency`
(CK ISO-4217 shape; fixed after creation), `time_zone`, `default_locale`,
`status` (`ACTIVE` | `SUSPENDED`), `created_by_user_id`, timestamps.

### organization_memberships

`id`, `organization_id`, `user_id`, `status` (`ACTIVE` | `REMOVED`),
`invited_by_user_id`, `joined_at`, `removed_at`.
UQ (organization_id, user_id) — a removed member who is re-invited gets the
same row back (`ACTIVE`), keeping history. IX (user_id).

### Permissions (code catalogue — no table)

Permissions are **defined in code** (`src/modules/access/permissions.ts`,
`domain.action` format) and validated with a Zod enum before any
`role_permissions` row is written, so a check can never reference a
permission that does not exist. (Design change from the M0 baseline: a
mirror table would add a migration per new permission without adding safety.)
M1 catalogue: `org.settings.manage`, `members.view`, `members.manage`,
`roles.manage`, `branches.view`, `branches.manage`, `warehouses.view`,
`warehouses.manage`, `audit.view`. Only `branches.*` and `warehouses.*` can be
granted at branch/warehouse scope.

### roles / role_permissions

`roles`: `id`, `organization_id`, `key` (UQ per org; system keys such as
`owner`, `branch_manager`; custom roles get `custom_<id>`), `name`,
`description`, `is_system`. The nine system roles are created for every new
organization. **Owner** always holds every permission (computed in code, so new
permissions apply automatically) and cannot be edited.
`role_permissions`: PK (role_id, permission), composite FK to the role.

### membership_roles

`id`, `organization_id`, `membership_id`, `role_id`, `scope_type`
(`ORGANIZATION` | `BRANCH` | `WAREHOUSE`), `branch_id?`, `warehouse_id?`.
Scope uses **explicit nullable FK columns** rather than a polymorphic
`scope_id`, so the composite tenant FKs also protect scope references.
CK: exactly the column matching `scope_type` is set.
UQ (membership_id, role_id, scope_type, branch_id, warehouse_id)
`NULLS NOT DISTINCT`.

**Effective permission check** (`src/modules/access/authorize.ts`): user U may
perform P on resource R in org O iff U is `ACTIVE`, O is `ACTIVE`, U has an
`ACTIVE` membership in O, and some grant gives P with a scope covering R —
organization scope covers everything; branch scope covers that branch and its
warehouses; warehouse scope covers only that warehouse. Actions without a
resource (e.g. creating a branch) require an organization-scope grant.

**Invariant — at least one owner**: revoking an Owner grant or removing an
owner locks the organization row (`SELECT … FOR UPDATE`) and then counts the
remaining owners in the same transaction; concurrent attempts are serialized
(tested). Only owners can grant/revoke the Owner role or remove an owner.

### invitations

`id`, `organization_id`, `email` (CK lower-case), `role_id`, scope columns as
in membership_roles (same CK), `token_hash` (UQ; SHA-256 of a 256-bit random
token that is shown once to the inviter and never stored), `status`
(`PENDING` | `ACCEPTED` | `REVOKED`), `expires_at` (7 days),
`invited_by_user_id`, `accepted_by_user_id`, `accepted_at`.
Partial UQ (organization_id, email) WHERE status = 'PENDING'.
Acceptance requires the signed-in user's email to equal the invitation email
and is single-use (conditional `PENDING → ACCEPTED` update).

### branches

`id`, `organization_id`, `code` (UQ per org, upper-case `[A-Z0-9_-]`, ≤ 20),
`name`, `type` (`RESTAURANT` | `CENTRAL_KITCHEN` | `WAREHOUSE_SITE` |
`OFFICE` | `OTHER`), `time_zone?` (→ org default), `address_line?`, `city?`,
`country?` (ISO-3166 alpha-2), `archived_at`, created/updated by + at.
Rule: a branch can be archived only when it has no active warehouses.

### warehouses

`id`, `organization_id`, `branch_id` (composite FK; cannot change after
creation), `code` (UQ per org), `name`, `type` (`MAIN` | `KITCHEN_STORE` |
`BAR` | `TRANSIT` | `OTHER`), `archived_at`, actors/timestamps. A warehouse is
the unit of stock ownership and of warehouse permission scope. Rules: cannot be
created in, or restored into, an archived branch. (M2 adds: cannot be archived
while holding stock.)

### storage_locations

`id`, `organization_id`, `warehouse_id`, `code` (UQ per warehouse), `name`,
`temperature_zone` (`AMBIENT` | `CHILLED` | `FROZEN`), `archived_at`.
Managed with the parent warehouse's `warehouses.manage` permission.
Locations are optional: a warehouse with no locations tracks stock at the
warehouse level (`location_id` NULL).

### Platform tables added in M1

- `audit_events` — append-only (UPDATE/DELETE/TRUNCATE rejected by trigger);
  written in the same transaction as the change. See §10.
- `idempotency_keys` — UQ (organization_id, user_id, key); stores the
  operation, a SHA-256 request hash and the result. Reuse of a key with a
  different payload is rejected.
- `rate_limit_buckets` — fixed-window counters (`key` PK, `count`,
  `window_start`) updated by a single atomic upsert; shared by Better Auth's
  endpoints and the sign-in/sign-up actions.

### Row-level security

Every table with `organization_id`, plus `organizations`, has RLS enabled with
a `tenant_isolation` policy (`organization_id = current_organization_id()` for
both USING and WITH CHECK). Policies apply when a transaction runs
`SET LOCAL ROLE fa_tenant` after `set_config('app.organization_id', …, true)`
(`withTenantTx`). A test asserts that every table with an `organization_id`
column has RLS and a policy, so new tables cannot silently skip it.

---

## 3. Catalog and units (Milestone 2 — implemented)

### units_of_measure

`id`, `organization_id` (NULL for system units), `code` (`kg`, `g`, `l`, `ml`,
`each`, …), `name_en`, `name_ar`, `dimension` (`MASS` | `VOLUME` | `COUNT` |
`LENGTH`), `factor_to_dimension_base` (`NUMERIC(30,12)`; base units are `g`,
`ml`, `each`, `mm`).
UQ (organization_id, code) with system units in a partial unique index.

### products

`id`, `organization_id`, `sku` (UQ per org), `name_en`, `name_ar`,
`category_id`, `base_uom_id`, `type` (`RAW_MATERIAL` | `SEMI_FINISHED` |
`FINISHED_GOOD` | `PACKAGING` | `CONSUMABLE`), `lot_tracking`
(`NONE` | `LOT` | `LOT_AND_EXPIRY`), `shelf_life_days` (nullable),
`storage_requirement` (`AMBIENT` | `CHILLED` | `FROZEN`), `archived_at`.

### product_barcodes

`id`, `organization_id`, `product_id`, `barcode`, `symbology`
(`EAN13` | `UPC_A` | `CODE128` | `QR` | `INTERNAL`), `uom_id` (pack the
barcode identifies). UQ (organization_id, barcode).

### product_uom_conversions

`id`, `organization_id`, `product_id`, `from_uom_id`, `factor_to_base`
(`NUMERIC(30,12)`, > 0). UQ (product_id, from_uom_id).

**Conversion rules**

1. Same dimension → convert through dimension base factors (system rule).
2. Different dimension (e.g. `case` → `kg`, `each` → `g`) → only via an explicit
   product-specific conversion. Otherwise conversion fails with
   `INCOMPATIBLE_UNITS` (never guessed).
3. All stock is stored in the product's base unit. The original entered
   quantity and unit are kept on documents and ledger entries for audit.
4. Changing a product's base unit after it has ledger entries is forbidden.

---

## 4. Inventory (Milestone 2 — implemented) — core invariants

```
Product ─< InventoryLot
             │
Warehouse ─< StorageLocation
   │               │
   └──── InventoryLedgerEntry (append-only) ────> source document line
                   │  (projected, same transaction)
                   ▼
             StockBalance (org, warehouse, location, product, lot, status)
                   ▲
             StockReservation (open reservations reduce availability)
```

### inventory_lots

`id`, `organization_id`, `product_id`, `lot_code`, `supplier_id` (nullable),
`manufactured_on`, `best_before_on`, `expires_on` (`date`, nullable),
`first_received_at`, `source_receipt_line_id` (nullable),
`recall_hold` (boolean; set only via traceability/recall workflow).
UQ (organization_id, product_id, lot_code, supplier_id) — the same lot code
from two suppliers is two lots. CK: when product requires expiry,
`expires_on IS NOT NULL` (enforced in service; product rules can change).

### Stock status buckets

`AVAILABLE`, `QUARANTINE`, `REJECTED`, `ON_HOLD` (recall/investigation).
Status is a dimension of stock, not a flag on a product: part of a lot can be
quarantined in one warehouse while the rest is available. **Expired is not a
status**; it is computed from `expires_on` vs. the business date, so no batch
job ever mutates stock.

### inventory_ledger_entries (append-only)

| Column                                       | Notes                                                            |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `id`, `organization_id`                      |                                                                  |
| `posting_id`                                 | Groups entries posted atomically (e.g. both legs of a transfer)  |
| `movement_type`                              | see below                                                        |
| `warehouse_id`, `location_id?`               | composite FKs                                                    |
| `product_id`, `lot_id?`                      | `lot_id` required iff product is lot-tracked                     |
| `stock_status`                               | bucket affected                                                  |
| `quantity_delta`                             | `NUMERIC(20,6)`, base unit, non-zero (CK `<> 0`)                 |
| `entered_quantity`, `entered_uom_id`         | what the user typed                                              |
| `unit_cost`                                  | base currency per base unit, at posting                          |
| `source_type`, `source_id`, `source_line_id` | originating document (traceability)                              |
| `posting_key`                                | deterministic idempotency key; UQ (organization_id, posting_key) |
| `reverses_entry_id?`                         | UQ — an entry can be reversed at most once                       |
| `reason_code?`, `note?`                      | mandatory for adjustments/write-offs                             |
| `occurred_at`                                | business time of the movement                                    |
| `posted_at`, `posted_by_user_id`             |                                                                  |

IX (organization_id, product_id, warehouse_id, posted_at),
IX (organization_id, lot_id), IX (organization_id, source_type, source_id).

**Movement types**: `OPENING_BALANCE`, `RECEIPT`, `RECEIPT_REJECTED`,
`TRANSFER_OUT`, `TRANSFER_IN`, `CONSUMPTION`, `PRODUCTION_OUTPUT`,
`RETURN_TO_SUPPLIER`, `CUSTOMER_RETURN`, `WRITE_OFF`, `ADJUSTMENT`,
`COUNT_ADJUSTMENT`, `STATUS_CHANGE` (paired −from/+to entries), `REVERSAL`.

Database guarantees:

- Trigger rejects `UPDATE` and `DELETE` on the table.
- `posting_key` uniqueness makes posting idempotent: re-submitting the same
  receipt line, count line or transfer leg cannot double-post. Examples:
  `receipt:{receiptLineId}:accept`, `transfer:{transferLineId}:out`,
  `count:{countLineId}`, `reversal:{entryId}`.

### stock_balances (projection of the ledger)

Key: UQ (organization_id, warehouse_id, location_id, product_id, lot_id,
stock_status) — implemented with `NULLS NOT DISTINCT` (PostgreSQL 15+).
Columns: `on_hand_quantity NUMERIC(20,6)`, `reserved_quantity NUMERIC(20,6)`,
`last_entry_id`, `updated_at`.
CK `on_hand_quantity >= 0`, CK `reserved_quantity >= 0`,
CK `reserved_quantity <= on_hand_quantity`.

The projection is updated **in the same database transaction** as the ledger
insert. A reconciliation routine recomputes balances from the ledger and must
report zero differences (run in tests and as an operational check).

### Formulas (per product × warehouse, optionally × location × lot)

```
on_hand(scope)      = Σ quantity_delta over all statuses
quarantined(scope)  = Σ quantity_delta where status = QUARANTINE      (same for REJECTED, ON_HOLD)
unrestricted(scope) = Σ quantity_delta where status = AVAILABLE
                        and lot not expired (expires_on >= business_date or no expiry)
                        and lot.recall_hold = false
reserved(scope)     = Σ open reservations
available(scope)    = unrestricted(scope) − reserved(scope)
```

Only `available` may be issued, consumed, transferred out or reserved by
normal workflows. Expired-but-AVAILABLE stock is reported as "expired" and can
only be written off or (with permission) moved to quarantine.

### Concurrency control

Each posting runs in one transaction that:

1. Locks the affected `stock_balances` rows with `SELECT … FOR UPDATE`, in a
   deterministic key order to avoid deadlocks (rows are upserted first if
   missing, using `INSERT … ON CONFLICT DO NOTHING`).
2. Validates availability and status rules against the locked rows.
3. Inserts ledger entries (the `posting_key` UQ rejects duplicates).
4. Updates balances; the CK constraints are a last line of defence against
   negative stock.
5. Transitions the source document with a conditional update
   (`UPDATE … SET status='POSTED' WHERE id=$1 AND status='DRAFT'`); zero rows
   updated → the document was already posted → abort.

Isolation level: `READ COMMITTED` plus explicit row locks (sufficient because
every decision is made on locked rows). Serialization failures and deadlocks
are retried a bounded number of times.

### Negative stock

Rejected by default (service validation + CK constraint). A future
"allow negative" policy would have to be an explicit, per-warehouse,
permission-controlled setting with its own ADR; the CK constraint would then
move to a policy-aware check.

### FEFO

For a requested quantity of product P in warehouse W, suggest lots ordered by
`expires_on ASC NULLS LAST, best_before_on ASC NULLS LAST, first_received_at ASC`,
considering only `available` stock. A suggestion is advisory; the user may
pick another lot (recorded), but cannot pick unavailable stock.

### stock_reservations

`id`, `organization_id`, `warehouse_id`, `location_id?`, `product_id`,
`lot_id?`, `quantity`, `source_type`, `source_id`, `status`
(`OPEN` | `CONSUMED` | `RELEASED`), `expires_at?`. Reserving updates
`stock_balances.reserved_quantity` under the same locks as postings.

### stock_transfers / stock_transfer_lines

Design note superseded: immediate transfers are `TRANSFER` documents (M2)
and transfers with a transit stage are `stock_shipments` (M3c, ADR-026,
below). Lot identity and status are preserved across both.

### stock_counts / stock_count_lines

Header: warehouse, `count_date`, scope (full / product list / location),
status `DRAFT → COUNTING → SUBMITTED → APPROVED → POSTED`.
Lines snapshot `expected_quantity` when counting starts, store
`counted_quantity`; posting creates `COUNT_ADJUSTMENT` entries for
`counted − expected_at_post_time`, accounting for movements that happened
while counting (movements after the snapshot are added to expected).

### Quarantine and release

Moving stock between status buckets posts a `STATUS_CHANGE` pair.
`QUARANTINE → AVAILABLE` and `ON_HOLD → AVAILABLE` require
`inventory.quarantine.release` (scope-checked) and a reason, and are audit
logged. `REJECTED` stock can only leave via `RETURN_TO_SUPPLIER` or `WRITE_OFF`.

---

### Milestone 2 implementation notes (where the build refines the design)

Implemented in migration `20261029120000_m2_inventory`; posting logic in
`src/modules/inventory/posting.ts` (the only writer of ledger and balances).

- **Units**: system units (`mg, g, kg, oz, lb, ml, l, each, dozen`) are seeded
  with `organization_id NULL`; tenants add their own, typically pack units
  with no fixed size (`factor_to_base NULL`, e.g. "case"), which convert only
  through a product-specific conversion. Because units can be global, unit
  references use plain FKs plus the `assert_unit_visible` trigger (a row may
  only reference a system unit or a unit of its own tenant). `LENGTH` was
  dropped from the dimensions (no food use case yet).
- **Products** have no category yet (deferred). SKU and barcodes are unique
  per organization; EAN-13/EAN-8/UPC-A check digits are validated. Base unit
  and lot-tracking mode are frozen once the product has ledger entries; a
  product with stock cannot be archived.
- **Lots** are unique per (organization, product, lot code) — the supplier
  column joins the key in M3. Lots are immutable (no UPDATE grant); entering
  an existing lot code with a different expiry is rejected
  (`LOT_EXPIRY_MISMATCH`).
- **Documents**: every posting has an `inventory_documents` header (types
  OPENING_BALANCE, ADJUSTMENT, WRITE_OFF, TRANSFER, STATUS_CHANGE,
  STOCK_COUNT, REVERSAL) numbered per organization/type/year
  (`ADJ-2026-000001`) from `document_sequences`. Ledger entries are the
  document lines. Documents and entries are append-only (triggers).
- **Reversal** posts the negated entries of a document (movement type
  REVERSAL, `reverses_entry_id` set). UNIQUE `reverses_document_id` and
  `reverses_entry_id` make reversal single-use even under concurrency;
  reversals cannot be reversed; a reversal fails with INSUFFICIENT_STOCK if
  the stock it would remove has been used.
- **Opening balances** are accepted for a product/warehouse only while it
  has no movements other than opening balances and reversals.
- **Transfers** post TRANSFER_OUT and TRANSFER_IN atomically in one document
  (no in-transit stage yet — ADR-016). Only usable stock (AVAILABLE, not
  expired, not on recall hold) can be transferred; lot and status are kept.
- **Status changes** follow `STATUS_TRANSITIONS` in
  `src/modules/inventory/rules.ts`; releases to AVAILABLE need
  `inventory.quarantine.release` and are refused for expired or recalled lots.
  REJECTED stock can only leave by write-off (return to supplier: M3).
- **Write-offs** may remove stock from any status, including expired stock.
- **Reservations** are not implemented yet: `reserved_quantity` exists, is
  always 0, and already participates in the availability formula and checks.
- **Stock counts** (ADR-017) count AVAILABLE stock only. The count sheet is
  created from current balances; the system quantity of a line is captured
  when that line is counted, and the adjustment posted on approval is
  counted − system quantity at count time. The UI hides the system quantity
  until a line is counted (blind count). Lifecycle OPEN → SUBMITTED →
  POSTED/CANCELLED; posting needs `inventory.count.approve`.
- **Unit cost** is recorded per base unit; since M3a every entry also
  carries its value change and cost source (see "Stock valuation" below).
- **Integrity check**: `reconcileBalances()` recomputes every balance from
  the ledger; the integration suites assert it returns no differences.

### Stock valuation (Milestone 3a — implemented, ADR-021)

Moving weighted average per product × warehouse, in base currency. Migration
`20261029180000_m3_valuation`; rules in `src/modules/inventory/valuation.ts`
(pure), applied by the posting engine under row locks.

**Ledger columns added**: `value_delta NUMERIC(19,4)` (signed),
`cost_source` (`ENTERED | AVERAGE | TRANSFER | RESTORED | NONE`), and
`unit_cost` now holds the cost used for every entry. CK: `NONE` ⇔ no unit
cost, `NONE` ⇒ zero value, and value moves in the same direction as
quantity.

**stock_valuations** — UQ (organization_id, warehouse_id, product_id):
`quantity NUMERIC(20,6)`, `total_value NUMERIC(19,4)`,
`average_unit_cost NUMERIC(20,6)?`, `cost_missing boolean`. CK quantity ≥ 0,
value ≥ 0, value = 0 when quantity = 0. Quantity always equals the sum of the
product's stock balances in the warehouse (all locations, lots, statuses).

**stock_revaluations** (append-only, one per REVALUATION document): quantity,
previous/new unit cost, previous/new value, value delta (CK
`value_delta = new_value − previous_value`), previous cost-missing flag.

| Movement                                        | Cost used                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Inbound with its own cost (opening, receipt)    | entered cost per base unit → `ENTERED`                                                                           |
| Inbound without a cost (count gain, adjustment) | current average, else last average → `AVERAGE`; none known, or uncosted units on hand → zero value, `NONE`, flag |
| Any outbound                                    | current average; the last unit out takes the exact remaining value                                               |
| Transfer / status change inbound leg            | the outbound leg's value → `TRANSFER` (total value unchanged)                                                    |
| Reversal of an outbound entry                   | exactly what that entry took → `RESTORED`                                                                        |
| Reversal of an inbound entry                    | exactly the value it added, capped at the value on hand (ADR-024) → `RESTORED`                                   |
| Reversal of a transfer / status change          | treated as a move back: outbound at average, inbound carries it                                                  |
| Revaluation (no quantity)                       | value := quantity × new cost; clears the flag                                                                    |

`average_unit_cost` is kept after stock reaches zero (used by the next
movement without its own cost). While `cost_missing` is set the average is
not updated from value ÷ quantity, because that would understate the cost.
Posting order inside a document: outbound lines first, then inbound, so
inbound legs can carry outbound values. Valuation rows are locked after all
balance rows, in sorted order.

**Integrity check**: `reconcileValuations()` compares every valuation with
Σ balances (quantity) and Σ ledger `value_delta` + Σ revaluations (value);
the integration suites assert it returns no differences.

**Backfill**: the migration replays existing ledger entries in document
order with the same rules in SQL and aborts if quantities disagree with
`stock_balances`. Verified against a database built by the M2 test suite:
the TypeScript rules reproduce all 116 entries and 16 valuations exactly.

**Visibility**: costs and values are returned only where the user holds
`inventory.valuation.view` (warehouse-scopable); others see quantities only.

## 5. Procurement and receiving (Milestone 3b — implemented, ADR-023)

Migration `20261029200000_m3_procurement`; services in `src/modules/procurement/`
(pure rules in `rules.ts`). All tables carry `organization_id`, composite
tenant foreign keys and the `tenant_isolation` RLS policy.

- **suppliers**: `code` (UQ per org), `name`, `name_ar`, tax id, contact,
  email, phone, address, `payment_terms_days`, `lead_time_days`, note,
  `archived_at`. Archiving is refused while the supplier has open orders.
- **supplier_products**: UQ (org, supplier, product); `purchase_uom_id`
  (must convert to the product's base unit), supplier SKU, `last_unit_price`
  (per purchase unit, updated by receipts in that unit), lead time, minimum
  order, `preferred`, `archived_at` (removal archives, history kept).
- **procurement_settings** (one row per org, optional): `over_receipt_tolerance`
  (fraction 0–1, default 0). Approval limits moved to `approval_layers`.
- **approval_layers** (ADR-049, migration `20261112090000_approval_matrix`):
  PK (organization, `document` PURCHASE_ORDER | STOCK_COUNT, `position`
  1–4: 1–3 branch, 4 head office), `above_amount` ≥ 0 — the layer is
  required when the document's amount is above it. No row = not used.
- **purchase_orders**: `number` (`PO-YYYY-NNNNNN`), supplier, delivery
  warehouse, `status` `DRAFT → PENDING_APPROVAL → APPROVED →
PARTIALLY_RECEIVED → RECEIVED`, plus `CLOSED` (short close) and `CANCELLED`
  (only without posted receipts). Currency = base currency, `expected_on`,
  `total_amount`, who/when for creation, submission, approval
  (`auto_approved` flag) and closing; `rejection_note` when sent back to draft.
  CK: approved states carry an approver. Approval chain (ADR-049):
  `approval_round` (submissions so far), `approval_chain` (levels fixed at
  submission from the layers), `approvals_given`, `pending_approval_level`
  (BRANCH | HEAD_OFFICE | ANY for older orders, only while pending).
- **purchase_order_approvals** (insert-only): order, `round`, `step`,
  `level`, approver, time. UQ (order, round, step) and (order, round,
  approver) — one person signs once per round; a trigger refuses the
  order's creator or submitter and rows for a round or status not waiting.
- **stock_counts** approval (Q-12): `variance_value` (Σ |difference| ×
  average cost at submission; null when a differing item has no cost),
  `approval_round`, `approval_chain`, `approvals_given`,
  `pending_approval_level`, `rejection_note`; **stock_count_approvals** as
  for orders (insert-only, same uniques and trigger).
- **purchase_order_lines**: UQ (org, order, product) and (org, order,
  line_no); quantity in the entered unit and in base units, `unit_price` per
  entered unit, `line_total` (money scale), `received_quantity_base`
  (accepted so far, maintained under the order's row lock). Editable only in
  DRAFT.
- **goods_receipts**: `number` (`GRN-YYYY-NNNNNN`), order, supplier,
  warehouse, optional location, `status` `POSTED | REVERSED`,
  `inventory_document_id` (the `RCV-` stock document; null when every line
  was rejected), `reversal_document_id`, delivery note reference, who/when
  for posting and reversal. CK: REVERSED ⇔ `reversed_at` set.
- **goods_receipt_lines** (append-only): order line, product, unit,
  `received = accepted + rejected` (CK), base quantities, `rejection_reason`
  (CK: required when anything is rejected), `quarantine`, `lot_id`,
  `unit_price` charged and `ordered_unit_price`, `temperature_celsius`.

Posting a receipt (one transaction): lock the order → validate each line
(tolerance, lot/expiry rules, temperature for chilled/frozen goods, expired
or recall-held lots refused) → post accepted quantities through
`postReceiptInTx` in the inventory module (`RECEIPT` entries, posting key
`receipt:<receiptLineId>`, valued at the charged price) → insert receipt
lines → update received quantities and order status → update supplier last
price. Reversal reverses the stock document (value removed per ADR-024) and
the received quantities, also under the order lock.

**Supplier performance** (`supplierPerformance` in `rules.ts`): receipts
count, on-time rate (received on or before the expected date, per receipt
with an expected date), fill rate (accepted ÷ ordered over received or
closed orders, capped at 100 % per order), rejection rate (rejected ÷
received), price variance (Σ (charged − ordered) × accepted). Rates are
null when there is nothing to measure.

### Categories and reorder levels (Milestone 3c — implemented, ADR-025)

Migration `20261030090000_m3_reorder_categories`.

- **product_categories**: `code` (UQ per org), `name`, `name_ar`,
  `archived_at`. **products.category_id** (nullable, composite tenant FK).
- **reorder_rules**: UQ (org, warehouse, product); `min_quantity_base`,
  `max_quantity_base` (CK min ≥ 0, max > 0, max ≥ min). Suggestions are
  computed (`suggestReorder` in `procurement/rules.ts`), never stored.

### Shipments (Milestone 3c — implemented, ADR-026)

Migration `20261030120000_m3_shipments`.

- `stock_status` gains **IN_TRANSIT**; `inventory_document_type` gains
  `DISPATCH`, `TRANSIT_RECEIPT` (also used for the recall of a cancelled
  shipment: DISPATCH type, IN_TRANSIT → AVAILABLE).
- **stock_shipments**: `number` (UQ per org, `SHP-YYYY-NNNNNN`),
  `from_warehouse_id`, `to_warehouse_id` (CK different), optional
  `to_location_id` (composite FK to the destination's locations),
  `status` DRAFT | IN_TRANSIT | RECEIVED | CANCELLED, `expected_on`, `note`,
  `dispatch_document_id` / `receipt_document_id` / `cancel_document_id`
  (each UQ, composite FKs), actors and timestamps.
- **stock_shipment_lines**: `line_no`, `product_id`, `lot_id`,
  `from_warehouse_id` + `from_location_id` (composite FK), `uom_id`,
  `quantity`, `quantity_base` (> 0), `received_quantity_base`
  (0 ≤ received ≤ quantity_base), `shortage_reason`.
- Ledger shape: dispatch = STATUS_CHANGE −AVAILABLE / +IN_TRANSIT at the
  source; receipt = TRANSFER_OUT IN_TRANSIT (source) + TRANSFER_IN AVAILABLE
  (destination, value carried) + WRITE_OFF IN_TRANSIT for a shortage.

### Landed cost (Milestone 3c — implemented, ADR-028)

Migration `20261030150000_m3_landed_cost`.

- `inventory_document_type` gains **LANDED_COST** (`LCA-` numbers, no ledger
  entries, like REVALUATION).
- **landed_costs**: `receipt_id`, `document_id` (UQ), `warehouse_id`,
  `charge_type` (FREIGHT | CUSTOMS_DUTY | INSURANCE | HANDLING | OTHER),
  `method` (BY_VALUE | BY_QUANTITY), `amount` > 0, `capitalized_amount` +
  `expensed_amount` = `amount`, `reference`, `note`, poster and time.
- **landed_cost_lines**: one per receipt line (UQ landed cost × receipt
  line): `allocated_amount`, `received_quantity_base`, `on_hand_quantity` at
  posting, `capitalized_amount` + `expensed_amount` = allocated, previous and
  new value (new = previous + capitalized) and unit cost.
- Both tables are append-only (triggers) with RLS. `reconcileValuations()`
  adds `capitalized_amount` to ledger value + revaluations.

### Purchase requisitions (Milestone 3c — implemented, ADR-029)

Migration `20261030180000_m3_requisitions` (also grants `purchasing.request`).

- **purchase_requisitions**: `number` (UQ per org, `REQ-YYYY-NNNNNN`),
  `warehouse_id`, `status` (DRAFT | SUBMITTED | PARTIALLY_ORDERED | ORDERED |
  REJECTED | CLOSED | CANCELLED), `needed_by`, `note`, creator, submitter,
  `decided_at` / `decided_by_user_id` / `decision_reason` (required for
  rejected, closed, cancelled — CK).
- **purchase_requisition_lines**: `line_no`, `product_id` (UQ per
  requisition), `uom_id`, `quantity`, `quantity_base` (> 0), `note`,
  `purchase_order_line_id` (UQ, composite FK) with `ordered_at` (both set or
  both null — CK).

**Not yet built:** PO email (Q-10).

## 6. Recipes and food cost (Milestone 4)

Implemented in M4a (migration `20261031090000_m4_recipes`, ADR-030/031).

- **recipes**: `code` (UQ per org), `name`, `name_ar`, `type` (DISH |
  PREPARATION), `description`, `archived_at`.
- **recipe_versions**: `version_no` (UQ per recipe), `status` (DRAFT |
  ACTIVE | RETIRED; partial UQ: one ACTIVE, one DRAFT per recipe),
  `yield_quantity` > 0 + `yield_uom_id`, `portions`, `note`, creator,
  activation and retirement. Trigger `recipe_version_guard`: non-drafts can
  only move ACTIVE → RETIRED with unchanged content, and cannot be deleted.
- **recipe_ingredients**: version (cascade with a deleted draft), `line_no`,
  `product_id` XOR `sub_recipe_id` (CK), `quantity` > 0, `uom_id`,
  `waste_fraction` in [0, 1), `note`. Trigger: changes only while the
  version is a draft.
- **product_standard_costs**: product, `unit_cost` ≥ 0 per base unit,
  `effective_from` (UQ per product), note, creator. Append-only.
- **recipe_cost_snapshots**: version, `reason` (ACTIVATION | MANUAL),
  `policy` (AVERAGE | LAST_PURCHASE | STANDARD), `warehouse_id` (null =
  organization), `as_of`, `total_cost`, `cost_per_portion`,
  `cost_per_yield_unit`, `missing_count`, `breakdown` (JSON lines with
  decimal strings, source and reference; sub-recipes nested). Append-only.

M4b (migration `20261031150000_m4_pricing`, ADR-032):

- **recipe_prices**: recipe, `price` > 0 (base currency, excl. VAT),
  `effective_from` (UQ per recipe), note, creator. Append-only.
- **recipe_settings**: one row per organization,
  `target_food_cost_fraction` (null = no target; CK 0 < t < 1).
- **recipes.target_food_cost_fraction** (optional override, same CK);
  **recipe_versions.method** (text; covered by the version guard trigger).

## 7. Nutrition and allergens (Milestone 5)

- **nutrition_profiles**: product, per-100 g/ml values (`NUMERIC`), `source`
  (`SUPPLIER_SPEC` | `LAB` | `DATABASE` | `MANUAL`), source reference, date,
  `status` (`UNVERIFIED` | `VERIFIED`).
- **allergens** (global catalogue, regulatory lists per market) and
  **allergen_declarations**: product × allergen →
  `CONTAINS` | `MAY_CONTAIN` (cross-contact) | `FREE_FROM` | `UNKNOWN`,
  with source and verification status. **Absence of a declaration means
  `UNKNOWN`, never `FREE_FROM`.** Recipe roll-up: any `CONTAINS` → contains;
  else any `MAY_CONTAIN` → may contain; else any `UNKNOWN` → unknown;
  `FREE_FROM` only if every ingredient is verified `FREE_FROM`.
- **label_versions**: calculated, then `PENDING_REVIEW → APPROVED` by a user
  with `labels.approve`; only approved labels can be exported.

Implemented in M5a (migration `20261105090000_m5_nutrition_allergens`,
ADR-040): the allergen catalogue is a code list (14 codes, CK) rather than a
table; **allergen_declarations** (product, allergen, status CONTAINS |
MAY_CONTAIN | FREE_FROM | UNKNOWN, source, reference, declared/verified by
and at, `superseded_at`; partial UQ one current per product × allergen; CK
FREE_FROM ⇒ reference and source ≠ DATABASE; CK verifier ≠ declarer;
trigger: only verification and superseding may change);
**nutrition_profiles** (product, basis PER_100G | PER_100ML, ten nullable
nutrients, source, reference, verification, `superseded_at`; partial UQ one
current per product; plausibility CKs; same trigger); **recipe_labels**
(recipe, version, `label_no`, status PENDING_REVIEW | APPROVED | REJECTED |
SUPERSEDED, `content` JSON snapshot, `inputs_hash`, reviewer ≠ author;
partial UQs one pending and one approved per recipe; trigger allows only
PENDING → APPROVED | REJECTED and APPROVED → SUPERSEDED).

**Ingredient library** (migration `20261106090000_m5_ingredient_library`,
ADR-041): **reference_foods** (source USDA_FDC | OPEN_FOOD_FACTS |
WIKIDATA, `source_id` UQ per organization and source, data type, names,
brand, basis, the ten nutrients, allergen and trace codes (CK subset of the
14), unmapped tags, notes, licence, attribution, source URL, linked
product, import) and **reference_imports** (source, file name, `sha256` UQ
per organization, created / updated / skipped counts, problems; insert-only).
`nutrition_profiles.reference_food_id` links copied values (CK source =
DATABASE).

## 8. Food safety and traceability (Milestone 6)

- **food_safety_records**: type (temperature, hygiene, cleaning, pest control),
  location/equipment, reading value + unit, limits, `in_spec`, recorded_by, at.
- **checklist_templates / checklist_runs / answers**.
- **non_conformances**: source (receipt line, record, audit), severity,
  status `OPEN → INVESTIGATING → ACTION_PLANNED → CLOSED`;
  **corrective_actions**: owner, due date, verification.
- **traceability**: built on ledger entries (lot + source document links).
  Backward trace: lot → receipt line → supplier/PO. Forward trace: lot →
  transfers → consumption/production → output lots → sales/branches.
  Production records link input lots to output lots
  (**production_lot_links**). Gaps (e.g. consumption without lot) are
  reported explicitly, never silently omitted.
- **recalls**: scope (lots), simulation vs live, affected quantities by
  location, actions taken; a live recall sets `recall_hold` and moves stock to
  `ON_HOLD` via ledger entries.

Implemented in M6a (migrations `20261101090000_m6_recalls`,
`…_m6_lot_recall_hold_grant`, ADR-033/034):

- **recalls**: `number` (`RCL-`), `title`, `reason`, `status` (DRAFT |
  ACTIVE | CLOSED), `outcome` (DISPOSED | RELEASED; CK: set only for
  closed recalls that were live), actors and times, `close_note`.
- **recall_lots**: recall × lot (UQ), product for the composite lot FK.
- **recall_stock**: stock of the lots at activation by warehouse, location
  and status (append-only).
- **recall_documents**: stock documents posted by the recall, kind HOLD |
  DISPOSAL (append-only; UQ document).
  M6b (migration `20261101150000_m6_food_safety`, ADR-035):

- **safety_checkpoints**: branch, `code` (UQ per branch), name, kind,
  `min_celsius` / `max_celsius` (CK min ≤ max), archived.
- **food_safety_records**: branch, checkpoint (temperature), type,
  `value_celsius` (exactly for TEMPERATURE) or `passed`, limits copied,
  `in_spec`, note, `corrective_note` (CK: required when not in spec),
  `non_conformance_id`; no delete (trigger), only the NC link is updatable.
- **checklist_templates / checklist_items** (position, text, kind YES_NO |
  NUMBER, optional range, retired via `archived_at`);
  **checklist_runs** (branch, failed count, NC link; no delete) and
  **checklist_answers** (item text, kind and range copied, answer, ok;
  append-only).
- **non_conformances** (`NC-` number, branch, severity, source, status,
  root cause, raised/closed) and **corrective_actions** (owner, due date,
  OPEN → DONE → VERIFIED; CK: verifier ≠ doer).
- Traces are queries over `inventory_ledger_entries`, `goods_receipt_lines`
  and `stock_shipment_lines`; no trace tables. Production lot links come
  from the PRODUCTION documents (M9a): inputs are the document's outbound
  entries, the output lot is on the production order.

**Production** (migration `20261107090000_m9_production`, ADR-045):
`recipes.output_product_id` (CK preparations only); **production_orders**
(`PRD-` number, recipe, version, warehouse, output product, planned
quantity and unit, planned date, status PLANNED | COMPLETED | REVERSED |
CANCELLED with CK on document/timestamps, produced quantity (base), output
lot, cost, PRODUCTION and reversal documents UQ; trigger for transitions).
`inventory_document_type` gains PRODUCTION (`PRO-`); inputs post as
CONSUMPTION with reason PRODUCTION, the output as PRODUCTION_OUTPUT.

**Kitchen fulfilment** (migrations `20261108090000_m9_kitchen_fulfilment`,
`20261108090100_m9_requisition_met`, ADR-046):
`purchase_requisition_lines.shipment_id` (CK: not with a purchase order
line; `ordered_at` set when met either way).

**B2B** (migrations `20261109090000_m9_b2b`, `…090100_m9_sales_order_status`,
ADR-047): **customers** (code UQ, VAT number, payment terms);
**sales_orders** / **sales_order_lines** (quantity, base quantity, net unit
price, VAT code, delivered base quantity ≤ ordered); **customer_deliveries**
(the CUSTOMER_DELIVERY document and its number, cost, reversal) /
**customer_delivery_lines** (order line, base quantity, cost);
**sales_invoices** (one per delivery unless cancelled — partial UQ; net +
VAT = gross; cost for margin; trigger: only cancelling changes it) /
**sales_invoice_lines** (code, rate, net, VAT, gross); **customer_receipts**
(void only, trigger) / **customer_receipt_allocations**.
`inventory_document_type` and `movement_type` gain CUSTOMER_DELIVERY
(`DN-`).

## 9. Sales and finance (Milestone 7)

- **sales_transactions / lines**: branch, channel, sold item (recipe/product),
  qty, price, imported source + external id (UQ per org for idempotent
  imports). Recipe-based consumption posts `CONSUMPTION` entries.

Implemented in M7a as **sales_imports** (`SAL-` number, warehouse, file
name, status POSTED | REVERSED, line and skipped counts, net amount, cost
amount, consumption and reversal documents) and **sales_lines** (row,
`external_id` — partial UQ per organization over active lines — date,
channel, item type RECIPE (recipe + version) | PRODUCT, quantity, net
amount, `active`). `inventory_document_type` gains CONSUMPTION (`CON-`).
Migration `20261102090000_m7_sales`, ADR-036.

**VAT** (migration `20261102150000_vat_setup`, ADR-037): **tax_settings**
(one per organization: `country` CK in SA/AE/BH/OM/QA/KW/EG,
`vat_registered`, `vat_number`, `prices_include_tax`, default sales and
purchase codes); **tax_codes** (`code` UQ, names, category STANDARD |
ZERO_RATED | EXEMPT | OUT_OF_SCOPE); **tax_rates** (code, `rate` fraction in
[0, 1), `effective_from` UQ per code, source; append-only). New columns:
`recipes.tax_code_id`, `products.purchase_tax_code_id` (for M7b),
`recipe_prices.includes_tax`, `sales_lines.tax_code_id / tax_rate /
tax_amount / gross_amount` and `sales_imports.tax_amount / gross_amount`.

**Supplier invoices** (migration `20261103090000_m7_supplier_invoices`,
ADR-038): **supplier_invoices** (`PI-` number UQ, supplier,
`supplier_invoice_no` — partial UQ per supplier where status ≠ CANCELLED —
invoice and due date (CK due ≥ invoice), status DRAFT | POSTED | CANCELLED
(CK with posted/cancelled timestamps), `printed_gross`, computed net / tax /
gross, `match_status` MATCHED | EXCEPTION, exception approval (CK approver ≠
creator) with note, cancel reason) and **supplier_invoice_lines** (line no
UQ per invoice, kind GOODS | CHARGE; goods lines CK-require receipt line,
product, unit and `quantity_base` > 0 and keep the PO line, order and
received unit price; quantity, unit price, tax code and rate, net + tax =
gross (CK), `match` MATCHED | PRICE_VARIANCE | QUANTITY_VARIANCE |
PRICE_AND_QUANTITY | NOT_APPLICABLE, quantity and price variance). Lines
change only while the invoice is a draft (trigger). The match is stored on
the lines; there is no separate match table.
`procurement_settings.invoice_price_tolerance` (fraction 0–1).

**Payables** (migration `20261104090000_m7_payables`, ADR-039):
**supplier_settlements** (`PAY-` / `SCN-` number UQ, kind PAYMENT |
CREDIT_NOTE, supplier, date, `amount` gross > 0; payments: `method` (CK
present only for payments); credit notes: net, VAT, code and rate (CK
amount = net + VAT), `supplier_document_no` — partial UQ per supplier
among credit notes not voided; reference, note; status POSTED | VOIDED (CK
with `voided_at`); a trigger allows no change except voiding) and
**settlement_allocations** (settlement → posted invoice of the same
supplier, checked by trigger; amount > 0; insert-only). Balances, aging and
statements are queries; there is no balance table.
**accounting_settings** (one per organization: payables, purchases, input
VAT, payments and exchange-difference account codes, all optional text).

**Foreign currencies** (migration `20261113090000_q05_multi_currency`,
ADR-050): **exchange_rates** (UQ organization, `currency`, `rate_date`;
`rate` NUMERIC(20,10) > 0 = base units per unit; source MANUAL | CSV;
updatable — documents copy the rate they use). `suppliers.currency`
(null = base). `purchase_orders.exchange_rate`, `total_amount_base` (fixed
at submission). `goods_receipts.currency`, `exchange_rate`, `rate_date`.
`supplier_invoices.currency`, `exchange_rate`, `rate_date`,
`net/tax/gross_amount_base` (fixed when posted). `supplier_settlements.currency`,
`exchange_rate`, `rate_date`, `amount_base`, `tax_amount_base`.
`settlement_allocations.fx_difference_base` (realised difference, + = loss);
the allocation trigger also requires the same currency. Existing rows were
backfilled as base-currency documents at rate 1.

**Revaluations** (ADR-052, ADR-056; migrations `20261115090000_fx_revaluation`,
`20261119090000_b2b_accounting`): **fx_revaluations** (`REV-` number, `as_of`,
`total_difference_base` payables, `receivables_difference_base`; partial UQ
per date while not cancelled; trigger allows only cancelling) and
**fx_revaluation_lines** (supplier _or_ customer — CHECK exactly one —,
currency, `open_amount`, `booked_base`, `rate`, `rate_date`,
`revalued_base`, `difference_base` = revalued − booked; insert-only).
**landed_costs** (ADR-053): `currency`, `entered_amount`, `exchange_rate`,
`rate_date`; `amount` stays the base value posted.
**B2B** (ADR-054): `customers.currency`; `sales_orders.currency`;
`sales_invoices.currency`, `exchange_rate`, `rate_date`, `*_amount_base`
(CHECK gross = net + tax); `customer_receipts.currency`, `exchange_rate`,
`rate_date`, `amount_base`; `customer_receipt_allocations.fx_difference_base`
(+ = gain) with a trigger requiring the same customer and currency.
**accounting_settings** also holds receivables, sales, output VAT and
receipts accounts (ADR-056).

## 10. Integrations (Milestone 10, ADR-048)

Migration `20261110090000_m10_integrations`; all three tables have
row-level security.

- **connectors**: kind INBOUND_SALES_WEBHOOK | OUTBOUND_WEBHOOK, name,
  status ACTIVE | DISABLED, `config` JSON (inbound: `warehouseId`; outbound:
  `url`, `events[]`), `public_id` (UQ, random, the inbound URL path),
  `secret_sealed` (AES-256-GCM `v1.iv.tag.ct`), `secret_hint` (last 4),
  `created_by_user_id` (the identity inbound requests act as),
  `secret_rotated_at`. The app role may select, insert and update; not
  delete.
- **integration_events** (insert-only): connector, `idempotency_key?`,
  status ACCEPTED | REJECTED | DUPLICATE, `outcome` JSON (import id and
  counts, or the error), `body_sha256`, `body_bytes`, `received_at`. Partial
  UQ (connector, idempotency_key) WHERE status = ACCEPTED. The body itself is
  not stored (the sales import keeps the posted lines).
- **outbound_deliveries** (the outbox): connector, `event_type`,
  `event_key` (`<type>:<entity id>`, UQ per organization + connector),
  `payload` JSON, status PENDING | DELIVERED | FAILED, `attempts` ≥ 0,
  `next_attempt_at` (also the claim lease), `last_status_code`,
  `last_error`, `delivered_at` (CK present only when DELIVERED).

## 11. Platform tables

- **audit_events** (append-only, implemented M1): `organization_id`,
  `actor_user_id?` (null = system), `action` (e.g. `member.role_granted`),
  `entity_type`, `entity_id?`, `changes` (JSON field diff, secrets redacted),
  `request_id`, `occurred_at`.
  IX (organization_id, occurred_at DESC), IX (organization_id, entity_type, entity_id).
  No IP address is stored (not needed so far; avoids personal data).
- **idempotency_keys** (implemented M1): see §2. Rows are kept; a retention
  job (delete after 30 days) is planned with background jobs (ADR-008).
- **notifications**: recipient, type, payload, read_at.
- **attachments** (implemented, ADR-051, migration
  `20261114090000_q08_attachments`): `entity_type` (PURCHASE_ORDER |
  GOODS_RECEIPT | SUPPLIER_INVOICE | SUPPLIER_SETTLEMENT | STOCK_COUNT),
  `entity_id`, `file_name`, `content_type` (PDF/JPEG/PNG/WebP), `size_bytes`
  (1 – 3,145,728), `sha256`, uploader, `uploaded_at`, `retain_until`
  (+3 years), `removed_at`/`removed_by_user_id`, `purged_at`. A trigger
  allows only removal and purging to be recorded. `scan_status` CLEAN |
  NOT_SCANNED with `scanned_at` (ADR-055). **attachment_contents**
  (`attachment_id` PK, `data` BYTEA; a trigger checks the size). Both have
  row-level security.
- **document_sequences**: (organization_id, document_type, year) PK, next_value.

## 12. Point of sale (POS1a menu, ADR-058; POS1b selling, ADR-059)

Migration `20261120090000_pos1a_menu`; all tables have row-level security.

- **menu_categories**: names, `sort_order`, `archived_at`.
- **menu_items**: `code` (UQ per organization), names, description,
  category, `kind` ITEM | COMBO, `recipe_id` (a dish) _or_ `product_id` with
  `product_quantity` for items, neither for combos (CHECK), `tax_code_id`,
  `sort_order`, `archived_at`.
- **menu_item_prices** (append-only): item, `channel` DINE_IN | TAKEAWAY |
  DELIVERY, `branch_id` (null = all branches), `price` ≥ 0, `includes_tax`,
  `effective_from`; UQ (item, channel, branch, date) NULLS NOT DISTINCT.
- **modifier_groups** (`min_select` ≤ `max_select` ≤ 20) and
  **modifier_options** (`price_delta`, optional recipe _or_ product with
  `quantity`); **menu_item_modifier_groups** links them to items.
- **combo_components** (combo, component item, quantity > 0; not itself).
- **menu_item_unavailable**: (item, branch) where it is not offered.

### Selling (POS1b, ADR-059)

Migration `20261121090000_pos1b_selling`; all tables have row-level security.

- **pos_registers**: `code` (UQ per organization), name, `branch_id`,
  `warehouse_id` (stock used; must belong to the branch), `archived_at`.
- **pos_shifts**: `number` (SHF-), register, `status` OPEN | CLOSED (one OPEN
  per register: partial unique index), `opening_float`, opened by/at;
  `expected_cash`, `counted_cash`, `cash_difference` (= counted − expected,
  CHECK), `close_note`, closed by/at — only these close fields can change.
- **pos_cash_movements** (insert-only): shift, `kind` PAY_IN | PAY_OUT,
  `amount` > 0, `reason`.
- **pos_orders**: `id` generated by the device (idempotent retry), `number`
  (POS-), register, shift, branch, warehouse, `channel`, `status` PAID |
  VOIDED, `ordered_at`, `business_date`, `net_amount` + `tax_amount` =
  `gross_amount` (CHECK), `cost_amount` (stock used), `consumption_doc_id`,
  `refunded_amount`, cashier, void fields (a void needs a reason and no
  refund, CHECK). Amounts are fixed (trigger).
- **pos_order_lines**: line no, menu item, name and unit price as sold,
  `price_includes_tax`, `options` (JSON: option, name, price change),
  `tax_code_id`, `tax_rate`, net/tax/gross, `refunded_quantity` (the only
  field that changes).
- **pos_payments** (insert-only): `method` CASH | CARD, `amount`, `tendered`
  and `change` (cash only; change = tendered − amount), `reference`.
- **pos_refunds** (insert-only): `number` (RFD-), order, the shift that paid
  it, method, `amount`, `tax_amount`, `lines` (JSON: order line, quantity,
  gross, tax), reason.
- **pos_consumption_shortfalls**: order, warehouse, product, `quantity` not
  on hand when sold, `status` OPEN | POSTED | CANCELLED, `document_id` when
  posted, `resolved_at`.

POS1c (ADR-060) adds no tables: orders queued on a device are kept in the
browser's IndexedDB (`food-ambassador-pos`, store `orders`: order id,
register, cashier, payload, status pending | refused, reason) until the
server has them. An order sent after its shift closed is recognised by
`pos_orders.created_at` > `pos_shifts.closed_at`.

### Tables and checks (POS2a, ADR-062)

Migration `20261122090000_pos2a_tables`; all tables have row-level security.

- **pos_floors**: branch, `warehouse_id` (the kitchen's stock), name (UQ per
  branch), `sort_order`, `archived_at`.
- **pos_tables**: floor, branch, `code` (UQ per branch), `seats` 1–50,
  `grid_x`/`grid_y` 0–39, `archived_at`.
- **pos_tabs** (checks): `number` (TAB-), branch, warehouse, `table_id` or a
  `label`, `guests`, `channel`, `status` OPEN | CLOSED | CANCELLED | MERGED
  (CHECKs tie `closed_at`, `merged_into_tab_id`, `cancel_reason` to the
  status), waiter, opened/closed. One OPEN check per table (partial unique
  index).
- **pos_tab_lines**: check, `line_no` (UQ per check), menu item, name,
  `quantity`, `option_ids`, `option_names`, `seat`, `course` 1–9, `note`,
  `hold`, `status` PENDING | SENT | VOIDED, sent/voided by and at,
  `void_reason`, `waste_doc_id` (write-off of a voided sent item),
  `paid_quantity` ≤ `quantity`. Triggers: only PENDING unpaid lines can be
  deleted; a sent line's item, options, quantity and send time are fixed; a
  voided line stays voided.
- **pos_orders.tab_id** and **pos_order_lines.tab_line_id** link the orders
  that paid a check to it.

### Kitchen display (POS2b, ADR-063)

Migration `20261123090000_pos2b_kitchen`; all tables have row-level security.

- **kitchen_stations**: branch, `code` (UQ per branch), name,
  `target_minutes` 1–240, `is_default` (at most one active default per
  branch), `sort_order`, `archived_at`.
- **kitchen_routes**: branch, station, exactly one of `category_id` /
  `menu_item_id` (CHECK); UQ (branch, category) and (branch, item).
- **kitchen_tickets**: branch, station, exactly one of `tab_id` /
  `order_id` (CHECK), `label` (table, check name or order number),
  `guests`, `status` OPEN | DONE (DONE ⇔ `bumped_at`), bumped by.
- **kitchen_ticket_items**: ticket, exactly one of `tab_line_id` /
  `order_line_id`, name, quantity, options, note, seat, course, `voided_at`.

## 13. E-invoicing — ZATCA (POS4a, ADR-064)

Migration `20261124090000_pos4a_zatca`; all tables have row-level security.

- **zatca_settings** (one per organization): legal name, CR number,
  national address (street, 4-digit building number, district, city,
  5-digit postal code), business category, `environment` DEVELOPER_PORTAL
  | SIMULATION | CORE.
- **zatca_devices** (one e-invoicing unit per register, UQ register):
  environment, common name, serial number, `status` NEW | COMPLIANCE |
  ACTIVE | RETIRED (CHECK: credentials present for the status),
  `private_key_sealed`, `csr`, compliance and production tokens with
  sealed secrets, `icv` (last counter) and `last_hash` (next PIH).
- **zatca_documents**: unit, `type` INVOICE | CREDIT_NOTE | DEBIT_NOTE,
  `order_id` or `refund_id`, number, `uuid`, `icv` (UQ per unit), `pih`,
  `invoice_hash`, signed `xml`, `qr`, `status` PENDING | REPORTED |
  REPORTED_WITH_WARNINGS | REJECTED, `attempts`, `next_attempt_at`,
  `response` (ZATCA's answer), `reported_at`. Only the reporting fields can
  change (trigger); rows cannot be deleted.

### Card payments and settlements (POS3a, ADR-065)

Migration `20261125090000_pos3a_payments`; new tables have row-level security.

- **pos_payments** gains `card_scheme` (MADA | VISA | MASTERCARD | AMEX |
  OTHER), `terminal_id`, `approval_code` (1–12 letters or digits),
  `card_last4` (exactly 4 digits) and `tip` ≥ 0 — all only on card
  payments (CHECK). **pos_refunds** gains `reference`.
- **card_settlement_batches**: imported settlement files — file name,
  `sha256` (UQ per organization), line count, imported by and at.
- **card_settlement_lines**: batch, `transaction_date`, `terminal_id`,
  `approval_code`, `amount` > 0, `fee` ≥ 0, `payment_id` and `match`
  MATCHED | AMOUNT_MISMATCH | UNMATCHED (UNMATCHED ⇔ no payment); one line
  per payment (partial unique index). Insert-only.

### Pay by QR (POS3b, ADR-066)

Migrations `20261126090000_pos3b_payment_links`, `20261126100000_pos3b_link_card`.

- **payment_provider_settings** (one per organization): `provider`
  (MOYASAR), `mode` TEST | LIVE, `secret_key_sealed`.
- **payment_links**: provider invoice id (UQ per organization) and URL,
  check, register, the `order_id` used when recording, `lines` (empty =
  everything left), `amount` > 0, currency, `status` CREATED | PAID |
  RECORDED | FAILED | CANCELLED (`paid_at` ⇔ PAID or RECORDED), provider
  payment id, `card_scheme`, `card_last4` (4 digits), `problem` (why a
  paid link was not recorded).

### Discounts, promotions and coupons (POS5a, ADR-067)

Migration `20261127090000_pos5a_discounts`; new tables have row-level security.

- **pos_promotions**: `name`, `percent` (0 < p ≤ 100), `category_ids` and
  `item_ids` (at least one), `channels` and `weekdays` (1–7; empty = all),
  `start_time`/`end_time` (both or neither, HH:MM), `valid_from`,
  `valid_to`, `archived_at`. Immutable except `archived_at` (trigger).
- **pos_coupons**: `code` (UQ per organization, A–Z 0–9 -, 3–30), `kind`
  PERCENT | AMOUNT, `value` > 0 (≤ 100 for PERCENT), `valid_from`,
  `valid_to`, `max_uses`, `uses` ≤ `max_uses`, `archived_at`. Only `uses`
  and `archived_at` change (trigger).
- **pos_orders** gains `promo_discount` ≥ 0, `order_discount` ≥ 0,
  `discount_reason` and `coupon_id` (FK with the organization); an order
  discount has a reason or a coupon (CHECK).
- **pos_order_lines** gains `discount_amount` ≥ 0 (incl. VAT) and
  `promotion_id` (FK with the organization). Line net/VAT/gross are after
  discounts.

### Customers, loyalty and gift cards (POS5b, ADR-068)

Migration `20261128090000_pos5b_customers`; new tables have row-level security.

- **pos_customers**: `name`, `phone` (E.164, UQ per organization; null once
  erased), `email`, `marketing_consent` ⇔ `consent_at`, `points_balance` ≥
  0, `erased_at` (erased ⇒ no phone, email or consent).
- **loyalty_settings** (one per organization): `enabled`, `earn_rate` ≥ 0,
  `point_value` > 0, `min_redeem_points` ≥ 0.
- **loyalty_entries** (insert-only): customer, `kind` EARN (> 0) | REDEEM
  (< 0) | REVERSAL | ADJUSTMENT (needs a reason), `points` ≠ 0, order.
- **gift_cards**: `code_hash` (HMAC, UQ per organization), `last4`,
  `initial_value` > 0, 0 ≤ `balance` ≤ initial value, currency, the
  `shift_id` and `sold_method` (CASH | CARD) of its sale, `blocked_at`. Only
  balance and block change (trigger).
- **gift_card_entries** (insert-only): ISSUE / REVERSAL (> 0), REDEEM (< 0,
  with the order).
- **pos_payments** gains method GIFT_CARD with `gift_card_id` (⇔);
  **pos_refunds** are CASH or CARD only. **pos_orders** gains `customer_id`
  and `loyalty_points` (spent; needs a customer).

### Delivery platform orders (POS5c, ADR-069)

Migration `20261129090000_pos5c_delivery`; new tables have row-level security.

- **connectors** gains kind DELIVERY_ORDERS; config `{ platform, registerId,
branchId, warehouseId, autoAccept }`.
- **delivery_orders**: connector, `platform` HUNGERSTATION | JAHEZ | KEETA |
  OTHER, `external_id` (UQ per connector), `display_code`, `status` PENDING |
  NEEDS_MAPPING | ACCEPTED (⇒ POS order) | REJECTED | CANCELLED, `payload`
  (canonical order without contact details), `total` ≥ 0, `customer_name`,
  `placed_at`, decision, `problem`, `pos_order_id` (UQ, FK with the
  organization). Only the decision fields change (trigger).
- **delivery_item_maps**: connector, `kind` ITEM | OPTION, `external_id`
  (UQ per connector and kind) → `target_id` (menu item or modifier option).
- **pos_payments** gains method DELIVERY_PLATFORM (needs a reference).

### Online ordering and kiosks (POS5d, ADR-070)

Migration `20261130090000_pos5d_ordering`; the new table has row-level security.

- **ordering_channels**: `kind` WEB | KIOSK, `name`, branch, `channels`
  (sales channels it takes; WEB never DINE_IN), `auto_send`,
  `max_order_total`, `public_token` (UQ, the public address), creator,
  `archived_at`.
- **pos_tabs** gains `source` STAFF | WEB | KIOSK, `source_channel_id`
  (⇔ not STAFF), `source_key` (UQ per channel: the guest's resend key),
  `guest_name`, `guest_phone` (E.164, cleared when the check closes),
  `guest_token` (UQ, the guest's status address).

### Guest order fulfilment (POS5e, ADR-071)

Migration `20261201090000_pos5e_guest_fulfilment`.

- **ordering_channels** gains `payment_mode` COUNTER | ONLINE | CHOICE
  (not COUNTER ⇒ `register_id`, FK with the organization), `scheduling`
  (⇒ `open_from`, `open_to` HH:MM), `slot_minutes` (5, 10, 15, 20, 30, 60),
  `lead_minutes` 0–240, `days_ahead` 0–7.
- **pos_tabs** gains `pay_online`, `pickup_at`, `accepted_at`, `ready_at`,
  `picked_up_at` (staff checks have none; ready and handed over need
  accepted).

### Pick-up slot capacity (ADR-071)

Migration `20261203090000_pos5f_slot_capacity`.

- **ordering_channels** gains `slot_capacity` (optional, 1 – 500): at most
  that many open guest orders per pick-up slot; full slots are not offered
  and a guest choosing one is refused (`PICKUP_SLOT_FULL`).

### Currency per company (F1b step 3a, ADR-086)

Migration `20261213090000_f1b3a_company_currency` (rules only; no columns).

- `companies.currency` is the currency of the company's books; trigger
  `companies_currency_fixed` refuses a change once it has stock or money
  documents.
- `warehouse_currency(id)`: a warehouse's company's currency.
- `stock_move_same_currency` on **inventory_documents** (transfers) and
  **stock_shipments** refuses moves between companies with different
  currencies.
- `company_currency_supported` was a temporary guard (3a), removed in
  `20261214090000` (purchasing) and `20261215090000` (sales).

Migrations `20261214090000_f1b3b_payables_per_company` and
`20261214100000_f1b3b_receipts_per_company` (step 3b):

- **supplier_settlements**, **customer_receipts** and **fx_revaluations**
  gain `company_id` (NOT NULL; the default company when omitted; fixed;
  existing rows took the company of an invoice they were applied to, else
  the default). `settlement_allocations` and
  `customer_receipt_allocations` refuse an invoice of another company.
  `fx_revaluations_as_of` is unique per (organization, company, date).

Migration `20261215090000_f1b3c_sales_per_company` (step 3c): drops the
remaining guards; `pos_payments_gift_card_currency` refuses a gift card in
another currency than the order's company.

### ZATCA per company (F1b step 2b, ADR-085)

Migration `20261212090000_f1b2b_zatca_per_company`.

- **zatca_settings** gains `company_id`; primary key is now
  (organization, company). Existing rows moved to the default company.
- **zatca_devices** gains `company_id` (NOT NULL, set on insert from the
  register's branch, or the default company for an office unit when none
  is given; never changes). `zatca_devices_one_office` is now unique per
  (organization, company).

### VAT per company (F1b step 2a, ADR-084)

Migration `20261211090000_f1b2_vat_per_company`.

- **tax_rates** gains `country` (char 2, optional; existing rates tagged
  with the organization's VAT country). Unique key is now
  (organization, tax code, country, effective from).
- **companies** gains `vat_registered` (default false; the default company
  backfilled from tax settings). Check `companies_vat_ck`: registered needs
  a VAT number and a country.

### Company on documents (F1b step 1, ADR-083)

Migration `20261210090000_f1b_company_on_documents`.

- `company_id` (NOT NULL, composite tenant FK to companies) on
  **pos_orders**, **purchase_orders**, **goods_receipts**, **sales_orders**,
  **sales_invoices** (set by insert triggers from branch / warehouse /
  delivery) and **supplier_invoices** (chosen; default company otherwise).
  `company_fixed` triggers refuse changes; `supplier_invoice_line_company`
  refuses matching another company's receipt or order line.

### Enterprise layer (F1a, ADR-082)

Migration `20261209090000_f1a_companies_brands`.

- **companies**: `code` (unique per organization), `name`, `legal_name`,
  `country`, `currency` (the group's base currency until F1b), `vat_number`,
  `cr_number`, `is_default` (one per organization), `archived_at`.
- **brands**: `code`, `name`, `name_ar`, `archived_at`.
- **branches** gains `company_id` (required; backfilled to the default
  company) and `brand_id` (optional), both with composite tenant keys.

### Leave (HR2b, ADR-081)

Migration `20261208090000_hr2b_leave`.

- **leave_types**: `code` (unique per organization), names, `country`
  (optional), `paid`, `uses_balance`, `archived_at`.
- **leave_allocations**: per employee, type and `year`: `days` (0–366).
- **leave_requests**: employee, type, `start_date`, `end_date` (same year),
  `days`, `reason`, `status` PENDING | APPROVED | REJECTED | CANCELLED,
  requester, decider, `decided_at`, `decision_note`. Only the decision
  columns can change (trigger).

### Attendance (HR2a, ADR-080)

Migration `20261207090000_hr2a_attendance`.

- **attendance_terminals**: branch tablet, `name`, unique `public_token`
  (the secret link), `active`.
- **branch_geofences**: per branch `latitude`, `longitude`, `radius_meters`
  (20–5000) for phone clock-in.
- **employees** gains `pin_hash` (scrypt), `pin_failures`,
  `pin_locked_until`.
- **attendance_punches**: `employee_id`, `branch_id`, `kind` IN | OUT, `at`,
  `source` TERMINAL | PHONE | DEVICE | MANUAL (each with its reference:
  terminal; connector and the device's `external_id`, unique per connector;
  HR's user and `reason`), `distance_meters` (phone, no coordinates), and
  `voided_at` / `voided_by_user_id` / `void_reason`. Only the void columns
  can change (trigger).
- **ConnectorKind** gains ATTENDANCE_DEVICE.

### HR — HRIS (HR1, ADR-079)

Migration `20261206090000_hr1_hris`.

- **departments**: `code` (unique per organization), `name`, `name_ar`,
  optional `parent_id` (not itself), `archived_at`.
- **employees**: `number` (unique per organization), names, `email`,
  `phone`, `nationality` (ISO 2), `national_id` (personal data), `job_title`,
  `branch_id`, `department_id`, `manager_id` (not itself; loops refused by
  the service), `employment_type`, `hire_date`, `status` ACTIVE | ON_LEAVE |
  TERMINATED (TERMINATED ⇔ `terminated_on`, not before the hire date),
  `termination_reason`, optional `user_id` (unique per organization).
- **employee_documents**: `type` (IQAMA, NATIONAL_ID, PASSPORT, WORK_PERMIT,
  HEALTH_CERTIFICATE, DRIVING_LICENSE, CONTRACT, OTHER), `number` (personal
  data), `issued_on`, `expires_on` (not before issue), `note`.
- All three tenant-owned with RLS; `hr.view` / `hr.manage` added to the
  system roles of existing organizations.

### Delivery payouts (ADR-075)

Migration `20261205090000_delivery_payouts`.

- **delivery_payouts**: one platform statement per connector and
  `reference` (unique); `period_from`/`period_to`, `paid_on`, `status`
  DRAFT | CONFIRMED, totals `gross`, `commission`, `fees`, `vat_on_fees`,
  `net` (NUMERIC 19,4), optional `received_amount`, creator and confirmer.
  Confirmed rows cannot change or be deleted (trigger).
- **delivery_payout_lines**: `line_no`, `external_id` (null for
  adjustments), `description`, the five amounts, `match`
  (DeliveryPayoutMatch), `delivery_order_id`, `recorded_total`, `settled`.
  A partial unique index allows one settled line per delivery order; lines
  of a confirmed payout are fixed.

### Two-step sign-in (ADR-073)

Migration `20261204090000_two_factor`.

- **users** gains `two_factor_enabled`.
- **two_factors** (Better Auth): `user_id` (cascade), `secret` and
  `backup_codes` (both encrypted with the auth secret), `verified`,
  `failed_verification_count`, `locked_until`. Global (not tenant-owned);
  no grant to `fa_tenant`.

### ZATCA standard invoices (POS4b, ADR-072)

Migration `20261202090000_pos4b_zatca_standard`.

- **zatca_devices** gains `purpose` POS | OFFICE (POS ⇔ a register; at most
  one OFFICE unit per organization).
- **zatca_documents** gains `kind` SIMPLIFIED | STANDARD, `sales_invoice_id`
  (FK with the organization; standard only), `cleared_xml` (⇔ CLEARED or
  CLEARED_WITH_WARNINGS, new statuses for standard documents). Only the
  reporting/clearance state, the cleared document and its QR change.
- **customers** gains `cr_number`, `street`, `building_number` (4 digits),
  `district`, `city`, `postal_code` (5 digits in SA), `country_code`
  (default SA).
