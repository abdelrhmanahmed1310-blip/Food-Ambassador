# Food Ambassador — Data Model

Status: **design baseline (Milestone 0)**. No business tables exist yet; models are
added to `prisma/schema.prisma` milestone by milestone. This document is the
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

## 2. Identity, tenancy and access control (Milestone 1)

```
User ─< OrganizationMembership >─ Organization ─< Branch ─< Warehouse ─< StorageLocation
                │
                └─< MembershipRole >─ Role ─< RolePermission >─ Permission (code catalogue)
                        (optional scope: branch or warehouse)
```

### users (global)

`id`, `email` (UQ, case-insensitive via `citext` or lower-cased unique index),
`name`, `locale` (`ar` | `en`), `status` (`ACTIVE` | `DISABLED`),
`email_verified_at`. Credentials and sessions live in auth-library tables
(`accounts`, `sessions`, `verifications`) linked by `user_id`.

### organizations

`id`, `name`, `slug` (UQ, URL-safe), `base_currency`, `time_zone`,
`default_locale`, `status` (`ACTIVE` | `SUSPENDED`), timestamps.

### organization_memberships

`id`, `organization_id`, `user_id`, `status` (`INVITED` | `ACTIVE` | `REMOVED`),
`invited_by_user_id`, `joined_at`.
UQ (organization_id, user_id). IX (user_id) for "my organizations".

### permissions (code catalogue, global)

Permissions are **defined in code** (`src/modules/access/permissions.ts`) and
synced to this table by migration/seed, so a permission check can never
reference a permission that does not exist. Format `domain.action`, e.g.
`inventory.view`, `inventory.adjust`, `inventory.quarantine.release`,
`procurement.po.approve`, `org.members.manage`.

### roles

`id`, `organization_id`, `key` (e.g. `owner`, `warehouse`), `name`,
`is_system` (system templates are created per org on org creation and cannot
be deleted; their permission sets can be customized except `owner`).
UQ (organization_id, key).

### role_permissions

`(organization_id, role_id, permission_code)` PK.

### membership_roles

`id`, `organization_id`, `membership_id`, `role_id`,
`scope_type` (`ORGANIZATION` | `BRANCH` | `WAREHOUSE`), `scope_id` (nullable
when `ORGANIZATION`). CK: `scope_id IS NULL` iff `scope_type = 'ORGANIZATION'`.
UQ (membership_id, role_id, scope_type, scope_id).

**Effective permission check**: user U may perform P on resource R in org O iff
U has an `ACTIVE` membership in O (and O is `ACTIVE`) and some membership_role
grants P with scope covering R (organization scope covers everything; branch
scope covers that branch and its warehouses; warehouse scope covers that
warehouse only).

Invariant: an organization always has at least one active member holding the
`owner` role (enforced in the service layer inside the same transaction that
removes/demotes a member, with a row lock on the organization).

### branches

`id`, `organization_id`, `code` (UQ per org), `name`, `type`
(`RESTAURANT` | `CENTRAL_KITCHEN` | `WAREHOUSE_SITE` | `OFFICE` | `OTHER`),
`time_zone` (nullable → org default), `address` fields, `archived_at`.

### warehouses

`id`, `organization_id`, `branch_id` (composite FK), `code` (UQ per org),
`name`, `type` (`MAIN` | `KITCHEN_STORE` | `BAR` | `TRANSIT` | `OTHER`),
`archived_at`. A warehouse is the unit of stock ownership and of warehouse
permission scope.

### storage_locations

`id`, `organization_id`, `warehouse_id`, `code` (UQ per warehouse), `name`,
`temperature_zone` (`AMBIENT` | `CHILLED` | `FROZEN`), `archived_at`.
Locations are optional: a warehouse with no locations tracks stock at the
warehouse level (`location_id` NULL).

---

## 3. Catalog and units (Milestone 2)

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

## 4. Inventory (Milestone 2) — core invariants

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

Header: from/to warehouse (same org, composite FKs), status
`DRAFT → DISPATCHED → RECEIVED` (or `DRAFT → POSTED` for same-site
immediate transfers). Dispatch posts `TRANSFER_OUT` from the source and
`TRANSFER_IN` into the destination's `TRANSIT` handling (in-transit stock is
held in a transit warehouse per org, so on-hand is never lost between sites).
Lot identity and status are preserved across transfers.

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

## 5. Procurement and receiving (Milestone 3)

- **suppliers**: `code` (UQ per org), names (en/ar), tax id, contacts, payment
  terms, `status`, `archived_at`. **supplier_products**: supplier SKU, pack
  unit, last price, lead time.
- **purchase_requisitions / lines**: `DRAFT → SUBMITTED → APPROVED | REJECTED → CONVERTED`.
  Approval rules configurable per org (threshold by amount).
- **purchase_orders / lines**: supplier, delivery warehouse, currency, status
  `DRAFT → APPROVED → SENT → PARTIALLY_RECEIVED → RECEIVED → CLOSED | CANCELLED`.
  Line: product, ordered qty + uom, unit price, `received_quantity_base`
  (maintained under row lock), tolerance %.
- **goods_receipts / lines**: PO (optional for direct receipts), warehouse,
  status `DRAFT → POSTED`. Line: PO line, product, lot code, expiry, received
  qty, accepted qty, rejected qty, rejection reason, quarantine flag,
  temperature at receipt. CK `accepted + rejected = received`.
  Posting creates `RECEIPT` (AVAILABLE or QUARANTINE) and `RECEIPT_REJECTED`
  (REJECTED) entries, with posting keys per receipt line.
- **receipt discrepancies**: over-receipt beyond tolerance blocked unless
  permitted; short/over/price/expiry discrepancies recorded per line.
- **landed_cost_allocations**: charges (freight, insurance, duty, other) linked
  to receipts, allocated by value/quantity/weight with `allocateProportionally`;
  posted as an immutable allocation record that revalues remaining stock
  (method depends on Q-01).

## 6. Recipes and food cost (Milestone 4)

- **recipes** (stable identity) / **recipe_versions** (immutable once
  `ACTIVE`): yield quantity + uom, portion size, effective_from, status
  `DRAFT → ACTIVE → RETIRED`.
- **recipe_ingredients**: version, product _or_ sub-recipe (CK exactly one),
  quantity + uom, waste % (fraction), optional flag.
  Cycle detection prevents a recipe containing itself transitively.
- **product_cost_records**: product, cost per base unit, `source`
  (`RECEIPT` | `MANUAL` | `AVERAGE` …), `effective_at`, source reference.
- **recipe_cost_snapshots**: version, calculated_at, cost source policy,
  total cost, cost per portion, and per-ingredient breakdown (JSON with source
  record IDs) so every number is reproducible.

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

## 9. Sales and finance (Milestone 7)

- **sales_transactions / lines**: branch, channel, sold item (recipe/product),
  qty, price, imported source + external id (UQ per org for idempotent
  imports). Recipe-based consumption posts `CONSUMPTION` entries.
- **supplier_invoices / lines**, **invoice_matches** (PO line ↔ receipt line ↔
  invoice line, with quantity/price variances and tolerances),
  **supplier_settlements** (payments, credit notes) and supplier balance
  derived from invoices − settlements.

## 10. Platform tables

- **audit_events** (append-only): `organization_id?`, `actor_user_id?`,
  `action` (e.g. `member.role_granted`), `entity_type`, `entity_id`,
  `changes` (JSON, redacted), `request_id`, `ip_hash`, `occurred_at`.
  IX (organization_id, occurred_at DESC), IX (organization_id, entity_type, entity_id).
- **idempotency_keys**: (organization_id, key) UQ, operation, request hash,
  response snapshot, expires_at — for API clients and form double-submits.
- **notifications**: recipient, type, payload, read_at.
- **attachments**: owner entity, storage key, filename, content type, size,
  checksum, uploaded_by, `deleted_at`.
- **document_sequences**: (organization_id, document_type, year) PK, next_value.
