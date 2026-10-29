import "server-only";
import type { InventoryDocumentType, MovementType, StockStatus } from "@/generated/prisma/client";
import { Decimal, roundQuantity } from "@/lib/decimal";
import { uuidv7 } from "@/lib/uuid";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import type { Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict } from "@/server/errors";

/**
 * The only code that writes inventory ledger entries and stock balances
 * (ARCHITECTURE.md §2, rule 4). Every posting runs inside the caller's tenant
 * transaction and follows DATA_MODEL.md §4 "Concurrency control":
 *
 *   1. allocate the document number and insert the document header;
 *   2. for each affected bucket, in a deterministic order: ensure the balance
 *      row exists (INSERT … ON CONFLICT DO NOTHING) and lock it (FOR UPDATE);
 *   3. validate the net change against the locked rows (no negative stock);
 *   4. insert ledger entries — UNIQUE(posting_key) rejects double posting;
 *   5. apply the deltas to the locked balance rows;
 *   6. write the audit event.
 *
 * CHECK constraints on stock_balances are the last line of defence.
 */

export interface PostingLine {
  movementType: MovementType;
  warehouseId: string;
  locationId: string | null;
  productId: string;
  lotId: string | null;
  stockStatus: StockStatus;
  /** Signed, in the product's base unit. */
  quantityDelta: Decimal;
  /** What the user entered (same sign as quantityDelta) and in which unit. */
  enteredQuantity: Decimal;
  enteredUomId: string;
  unitCost?: Decimal | null;
  sourceLineId?: string;
  /** Deterministic and unique per organization, e.g. "transfer:<doc>:1:out". */
  postingKey: string;
  reversesEntryId?: string;
  reasonCode?: string;
  note?: string;
}

export interface DocumentHeader {
  type: InventoryDocumentType;
  warehouseId: string;
  destinationWarehouseId?: string;
  reasonCode?: string;
  note?: string;
  occurredAt?: Date;
  reversesDocumentId?: string;
  /** Pre-allocated id when entries must reference the document in their posting keys. */
  id?: string;
}

const NUMBER_PREFIX: Record<InventoryDocumentType, string> = {
  OPENING_BALANCE: "OB",
  ADJUSTMENT: "ADJ",
  WRITE_OFF: "WO",
  TRANSFER: "TRF",
  STATUS_CHANGE: "QS",
  STOCK_COUNT: "CNT",
  REVERSAL: "REV",
};

/** Atomically allocate the next number for (organization, series, year). */
export async function nextDocumentNumber(
  tx: Tx,
  organizationId: string,
  series: string,
  year: number,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "document_sequences" ("organization_id", "document_type", "year", "next_value")
    VALUES (${organizationId}::uuid, ${series}, ${year}, 2)
    ON CONFLICT ("organization_id", "document_type", "year")
    DO UPDATE SET "next_value" = "document_sequences"."next_value" + 1
    RETURNING "next_value" - 1 AS value`;
  return `${series}-${year}-${String(rows[0].value).padStart(6, "0")}`;
}

interface BucketKey {
  warehouseId: string;
  locationId: string | null;
  productId: string;
  lotId: string | null;
  stockStatus: StockStatus;
}

const keyOf = (b: BucketKey) =>
  [b.warehouseId, b.locationId ?? "-", b.productId, b.lotId ?? "-", b.stockStatus].join("|");

interface LockedBalance {
  id: string;
  on_hand_quantity: Decimal;
  reserved_quantity: Decimal;
}

/** Ensure the balance row exists, then lock it for the rest of the transaction. */
async function lockBucket(tx: Tx, organizationId: string, b: BucketKey): Promise<LockedBalance> {
  await tx.$executeRaw`
    INSERT INTO "stock_balances"
      ("id", "organization_id", "warehouse_id", "location_id", "product_id", "lot_id", "stock_status",
       "on_hand_quantity", "reserved_quantity", "created_at", "updated_at")
    VALUES (${uuidv7()}::uuid, ${organizationId}::uuid, ${b.warehouseId}::uuid, ${b.locationId}::uuid,
            ${b.productId}::uuid, ${b.lotId}::uuid, ${b.stockStatus}::"StockStatus", 0, 0, now(), now())
    ON CONFLICT ("organization_id", "warehouse_id", "location_id", "product_id", "lot_id", "stock_status") DO NOTHING`;
  const rows = await tx.$queryRaw<
    Array<{ id: string; on_hand_quantity: unknown; reserved_quantity: unknown }>
  >`
    SELECT "id", "on_hand_quantity", "reserved_quantity" FROM "stock_balances"
    WHERE "organization_id" = ${organizationId}::uuid
      AND "warehouse_id" = ${b.warehouseId}::uuid
      AND "location_id" IS NOT DISTINCT FROM ${b.locationId}::uuid
      AND "product_id" = ${b.productId}::uuid
      AND "lot_id" IS NOT DISTINCT FROM ${b.lotId}::uuid
      AND "stock_status" = ${b.stockStatus}::"StockStatus"
    FOR UPDATE`;
  const row = rows[0];
  return {
    id: row.id,
    on_hand_quantity: new Decimal(String(row.on_hand_quantity)),
    reserved_quantity: new Decimal(String(row.reserved_quantity)),
  };
}

export interface PostingResult {
  documentId: string;
  number: string;
  entryIds: string[];
}

export async function postDocument(
  tx: Tx,
  ctx: TenantContext,
  header: DocumentHeader,
  lines: PostingLine[],
  options: { year: number; auditChanges?: Record<string, unknown> },
): Promise<PostingResult> {
  if (lines.length === 0)
    throw businessRuleViolation("EMPTY_DOCUMENT", "A document needs at least one line");
  for (const l of lines) {
    if (l.quantityDelta.isZero())
      throw businessRuleViolation("ZERO_QUANTITY", "Quantities must not be zero");
    if (!roundQuantity(l.quantityDelta).equals(l.quantityDelta))
      throw new RangeError("Quantity exceeds 6 decimal places");
  }

  const number = await nextDocumentNumber(
    tx,
    ctx.organizationId,
    NUMBER_PREFIX[header.type],
    options.year,
  );
  const occurredAt = header.occurredAt ?? new Date();
  const document = await tx.inventoryDocument.create({
    data: {
      id: header.id ?? uuidv7(),
      organizationId: ctx.organizationId,
      number,
      type: header.type,
      warehouseId: header.warehouseId,
      destinationWarehouseId: header.destinationWarehouseId,
      reasonCode: header.reasonCode,
      note: header.note,
      reversesDocumentId: header.reversesDocumentId,
      occurredAt,
      postedByUserId: ctx.userId,
    },
    select: { id: true },
  });

  // Net change per bucket, then lock buckets in a stable order to avoid deadlocks.
  const net = new Map<string, { key: BucketKey; delta: Decimal }>();
  for (const l of lines) {
    const k = keyOf(l);
    const entry = net.get(k) ?? { key: l, delta: new Decimal(0) };
    entry.delta = entry.delta.plus(l.quantityDelta);
    net.set(k, entry);
  }
  const ordered = [...net.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const locked = new Map<string, LockedBalance>();
  for (const [k, { key, delta }] of ordered) {
    const balance = await lockBucket(tx, ctx.organizationId, key);
    locked.set(k, balance);
    const availableAfter = balance.on_hand_quantity.minus(balance.reserved_quantity).plus(delta);
    if (availableAfter.isNegative()) {
      throw businessRuleViolation("INSUFFICIENT_STOCK", "Not enough available stock", {
        productId: key.productId,
        lotId: key.lotId,
        warehouseId: key.warehouseId,
        stockStatus: key.stockStatus,
        available: balance.on_hand_quantity.minus(balance.reserved_quantity).toFixed(),
        requested: delta.negated().toFixed(),
      });
    }
  }

  const entries = lines.map((l) => ({
    id: uuidv7(),
    organizationId: ctx.organizationId,
    documentId: document.id,
    movementType: l.movementType,
    warehouseId: l.warehouseId,
    locationId: l.locationId,
    productId: l.productId,
    lotId: l.lotId,
    stockStatus: l.stockStatus,
    quantityDelta: l.quantityDelta.toFixed(),
    enteredQuantity: l.enteredQuantity.toFixed(),
    enteredUomId: l.enteredUomId,
    unitCost: l.unitCost ? l.unitCost.toFixed() : null,
    sourceType: "inventory_document",
    sourceId: document.id,
    sourceLineId: l.sourceLineId,
    postingKey: l.postingKey,
    reversesEntryId: l.reversesEntryId,
    reasonCode: l.reasonCode,
    note: l.note,
    occurredAt,
    postedByUserId: ctx.userId,
  }));
  try {
    await tx.inventoryLedgerEntry.createMany({ data: entries });
  } catch (error) {
    if (isUniqueViolation(error, "inventory_ledger_entries_organization_id_posting_key_key")) {
      throw conflict("These lines were already posted", { reason: "alreadyPosted" });
    }
    if (
      isUniqueViolation(error, "inventory_ledger_entries_organization_id_reverses_entry_id_key")
    ) {
      throw conflict("An entry was already reversed", { reason: "alreadyReversed" });
    }
    throw error;
  }

  const lastEntryByKey = new Map<string, string>();
  entries.forEach((e, i) => lastEntryByKey.set(keyOf(lines[i]), e.id));
  for (const [k, { delta }] of ordered) {
    if (delta.isZero()) continue;
    const balance = locked.get(k)!;
    await tx.$executeRaw`
      UPDATE "stock_balances"
      SET "on_hand_quantity" = "on_hand_quantity" + ${delta.toFixed()}::numeric,
          "last_entry_id" = ${lastEntryByKey.get(k)!}::uuid,
          "updated_at" = now()
      WHERE "id" = ${balance.id}::uuid`;
  }

  await recordAudit(tx, actorOf(ctx), {
    action: "inventory.document_posted",
    entityType: "inventory_document",
    entityId: document.id,
    changes: { number, type: header.type, lines: lines.length, ...options.auditChanges },
  });
  return { documentId: document.id, number, entryIds: entries.map((e) => e.id) };
}
