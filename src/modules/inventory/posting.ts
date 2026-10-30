import "server-only";
import type { InventoryDocumentType, MovementType, StockStatus } from "@/generated/prisma/client";
import { Decimal, roundQuantity, roundUnitCost } from "@/lib/decimal";
import { uuidv7 } from "@/lib/uuid";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import type { Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict } from "@/server/errors";
import {
  costInbound,
  costInboundReversal,
  costOutbound,
  revalue,
  type CostedMovement,
  type InboundCost,
  negate,
  type ValuationState,
} from "./valuation";

/**
 * The only code that writes inventory ledger entries, stock balances and
 * stock valuations
 * (ARCHITECTURE.md §2, rule 4). Every posting runs inside the caller's tenant
 * transaction and follows DATA_MODEL.md §4 "Concurrency control":
 *
 *   1. allocate the document number and insert the document header;
 *   2. for each affected bucket, in a deterministic order: ensure the balance
 *      row exists (INSERT … ON CONFLICT DO NOTHING) and lock it (FOR UPDATE);
 *   3. validate the net change against the locked rows (no negative stock);
 *   4. lock the valuation of each product × warehouse (after all balance
 *      rows, again in a stable order) and cost every line with the moving
 *      average rules (valuation.ts, ADR-021);
 *   5. insert ledger entries — UNIQUE(posting_key) rejects double posting;
 *   6. apply the deltas to the locked balance rows and store the valuations;
 *   7. write the audit event.
 *
 * CHECK constraints on stock_balances and stock_valuations are the last
 * line of defence.
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
  /**
   * Inbound lines only. Unit cost per base unit entered with the movement;
   * without one the line uses the current (or last known) average.
   */
  unitCost?: Decimal | null;
  /** Inbound lines only: take the value of this outbound line (index) of the same document. */
  costFromLine?: number;
  /**
   * Reversals: the reversed entry's value change. Inbound lines put back what
   * an outbound entry took; outbound lines take out what an inbound entry
   * added (capped at the value on hand).
   */
  restore?: { valueDelta: Decimal; unitCost: Decimal | null };
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
  REVALUATION: "RVL",
  RECEIPT: "RCV",
  DISPATCH: "DSP",
  TRANSIT_RECEIPT: "TRR",
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

  const costs = await costLines(tx, ctx.organizationId, lines);

  const entries = lines.map((l, i) => ({
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
    unitCost: costs.lines[i].unitCost?.toFixed() ?? null,
    valueDelta: costs.lines[i].valueDelta.toFixed(),
    costSource: costs.lines[i].costSource,
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

  await costs.save();

  await recordAudit(tx, actorOf(ctx), {
    action: "inventory.document_posted",
    entityType: "inventory_document",
    entityId: document.id,
    changes: { number, type: header.type, lines: lines.length, ...options.auditChanges },
  });
  return { documentId: document.id, number, entryIds: entries.map((e) => e.id) };
}

// ─── Valuation (ADR-021) ───

interface LockedValuation {
  id: string;
  state: ValuationState;
}

const valuationKey = (warehouseId: string, productId: string) => `${warehouseId}|${productId}`;

/** Ensure the valuation row exists, then lock it for the rest of the transaction. */
async function lockValuation(
  tx: Tx,
  organizationId: string,
  warehouseId: string,
  productId: string,
): Promise<LockedValuation> {
  await tx.$executeRaw`
    INSERT INTO "stock_valuations" ("id", "organization_id", "warehouse_id", "product_id", "created_at", "updated_at")
    VALUES (${uuidv7()}::uuid, ${organizationId}::uuid, ${warehouseId}::uuid, ${productId}::uuid, now(), now())
    ON CONFLICT ("organization_id", "warehouse_id", "product_id") DO NOTHING`;
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      quantity: unknown;
      total_value: unknown;
      average_unit_cost: unknown;
      cost_missing: boolean;
    }>
  >`
    SELECT "id", "quantity", "total_value", "average_unit_cost", "cost_missing" FROM "stock_valuations"
    WHERE "organization_id" = ${organizationId}::uuid AND "warehouse_id" = ${warehouseId}::uuid
      AND "product_id" = ${productId}::uuid
    FOR UPDATE`;
  const row = rows[0];
  return {
    id: row.id,
    state: {
      quantity: new Decimal(String(row.quantity)),
      totalValue: new Decimal(String(row.total_value)),
      averageUnitCost:
        row.average_unit_cost === null ? null : new Decimal(String(row.average_unit_cost)),
      costMissing: row.cost_missing,
    },
  };
}

async function saveValuation(tx: Tx, v: LockedValuation) {
  await tx.$executeRaw`
    UPDATE "stock_valuations"
    SET "quantity" = ${v.state.quantity.toFixed()}::numeric,
        "total_value" = ${v.state.totalValue.toFixed()}::numeric,
        "average_unit_cost" = ${v.state.averageUnitCost?.toFixed() ?? null}::numeric,
        "cost_missing" = ${v.state.costMissing},
        "updated_at" = now()
    WHERE "id" = ${v.id}::uuid`;
}

/**
 * Cost every line of a document. Outbound lines are costed first so the
 * inbound leg of a transfer or status change can carry their value.
 */
async function costLines(tx: Tx, organizationId: string, lines: PostingLine[]) {
  const keys = [...new Set(lines.map((l) => valuationKey(l.warehouseId, l.productId)))].sort();
  const valuations = new Map<string, LockedValuation>();
  for (const key of keys) {
    const [warehouseId, productId] = key.split("|");
    valuations.set(key, await lockValuation(tx, organizationId, warehouseId, productId));
  }

  const results: Array<CostedMovement | undefined> = [];
  const outboundMissing: boolean[] = [];
  const order = [
    ...lines.flatMap((l, i) => (l.quantityDelta.isNegative() ? [i] : [])),
    ...lines.flatMap((l, i) => (l.quantityDelta.isNegative() ? [] : [i])),
  ];
  for (const i of order) {
    const l = lines[i];
    const v = valuations.get(valuationKey(l.warehouseId, l.productId))!;
    if (l.quantityDelta.isNegative()) {
      if (l.unitCost != null || l.costFromLine !== undefined)
        throw new Error("Outbound lines are costed at the average or restore an entry");
      const quantity = l.quantityDelta.negated();
      if (quantity.greaterThan(v.state.quantity)) {
        throw businessRuleViolation("INSUFFICIENT_STOCK", "Not enough available stock", {
          productId: l.productId,
          warehouseId: l.warehouseId,
          available: v.state.quantity.toFixed(),
          requested: quantity.toFixed(),
        });
      }
      outboundMissing[i] = v.state.costMissing;
      results[i] = l.restore
        ? costInboundReversal(v.state, quantity, l.restore.valueDelta.abs())
        : costOutbound(v.state, quantity);
    } else {
      results[i] = costInbound(
        v.state,
        l.quantityDelta,
        inboundCost(lines, i, results, outboundMissing),
      );
    }
    v.state = results[i]!.state;
  }

  return {
    lines: results as CostedMovement[],
    save: async () => {
      for (const key of keys) await saveValuation(tx, valuations.get(key)!);
    },
  };
}

function inboundCost(
  lines: PostingLine[],
  i: number,
  results: Array<CostedMovement | undefined>,
  outboundMissing: boolean[],
): InboundCost {
  const l = lines[i];
  if (l.costFromLine !== undefined) {
    const source = lines[l.costFromLine];
    const costed = results[l.costFromLine];
    if (
      !source ||
      !costed ||
      !source.quantityDelta.isNegative() ||
      source.productId !== l.productId
    )
      throw new Error("costFromLine must reference an outbound line of the same product");
    if (!source.quantityDelta.negated().equals(l.quantityDelta))
      throw new Error("costFromLine must move the same quantity");
    return {
      kind: "transfer",
      value: negate(costed.valueDelta),
      unitCost: costed.unitCost,
      costMissing: outboundMissing[l.costFromLine],
    };
  }
  if (l.restore) {
    return { kind: "restore", value: negate(l.restore.valueDelta), unitCost: l.restore.unitCost };
  }
  if (l.unitCost != null) return { kind: "entered", unitCost: l.unitCost };
  return { kind: "average" };
}

/**
 * Change the average cost of a product in a warehouse without moving stock
 * (ADR-021). Recorded as a REVALUATION document with an immutable
 * stock_revaluations row.
 */
export async function postRevaluation(
  tx: Tx,
  ctx: TenantContext,
  input: {
    warehouseId: string;
    productId: string;
    newUnitCost: Decimal;
    reasonCode?: string;
    note?: string;
  },
  options: { year: number },
): Promise<PostingResult & { valueDelta: string }> {
  const number = await nextDocumentNumber(
    tx,
    ctx.organizationId,
    NUMBER_PREFIX.REVALUATION,
    options.year,
  );
  const document = await tx.inventoryDocument.create({
    data: {
      id: uuidv7(),
      organizationId: ctx.organizationId,
      number,
      type: "REVALUATION",
      warehouseId: input.warehouseId,
      reasonCode: input.reasonCode,
      note: input.note,
      occurredAt: new Date(),
      postedByUserId: ctx.userId,
    },
    select: { id: true },
  });
  const v = await lockValuation(tx, ctx.organizationId, input.warehouseId, input.productId);
  const previous = v.state;
  const result = revalue(previous, input.newUnitCost);
  await tx.stockRevaluation.create({
    data: {
      organizationId: ctx.organizationId,
      documentId: document.id,
      warehouseId: input.warehouseId,
      productId: input.productId,
      quantity: previous.quantity.toFixed(),
      previousUnitCost: previous.averageUnitCost?.toFixed() ?? null,
      newUnitCost: roundUnitCost(input.newUnitCost).toFixed(),
      previousValue: previous.totalValue.toFixed(),
      newValue: result.state.totalValue.toFixed(),
      valueDelta: result.valueDelta.toFixed(),
      previousCostMissing: previous.costMissing,
    },
  });
  v.state = result.state;
  await saveValuation(tx, v);
  await recordAudit(tx, actorOf(ctx), {
    action: "inventory.document_posted",
    entityType: "inventory_document",
    entityId: document.id,
    changes: {
      number,
      type: "REVALUATION",
      productId: input.productId,
      previousUnitCost: previous.averageUnitCost?.toFixed() ?? null,
      newUnitCost: roundUnitCost(input.newUnitCost).toFixed(),
      valueDelta: result.valueDelta.toFixed(),
    },
  });
  return {
    documentId: document.id,
    number,
    entryIds: [],
    valueDelta: result.valueDelta.toFixed(),
  };
}
