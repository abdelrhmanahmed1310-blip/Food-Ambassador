import "server-only";
import type { MovementType, StockStatus } from "@/generated/prisma/client";
import { Decimal, toDecimal } from "@/lib/decimal";
import { uuidv7 } from "@/lib/uuid";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import {
  AppError,
  businessRuleViolation,
  conflict,
  notFound,
  validationFailed,
} from "@/server/errors";
import {
  assertActive,
  assertWarehousePermission,
  decimalOrNull,
  fieldError,
  loadLocation,
  loadProductForPosting,
  loadWarehouse,
  resolveExistingLot,
  resolveInboundLot,
  toBase,
  todayFor,
  type LotInfo,
  type PostingProduct,
} from "./context";
import type { Permission } from "@/modules/access/permissions";
import { postDocument, postRevaluation, type PostingLine } from "./posting";
import { isExpired, transitionPermission } from "./rules";
import {
  adjustmentSchema,
  openingBalanceSchema,
  reversalSchema,
  revaluationSchema,
  statusChangeSchema,
  transferSchema,
  writeOffSchema,
} from "./schemas";

export interface PostedDocument {
  documentId: string;
  number: string;
  [key: string]: string;
}

const yearOf = (today: string) => Number(today.slice(0, 4));

/** Normal use (transfers, consumption) needs unexpired, non-recalled stock. */
function assertUsable(lot: LotInfo | null, today: string) {
  if (!lot) return;
  if (lot.recallHold)
    throw businessRuleViolation("LOT_ON_RECALL_HOLD", "This lot is on recall hold");
  if (isExpired(lot.expiresOn, today))
    throw businessRuleViolation("LOT_EXPIRED", "This lot has expired", {
      expiresOn: lot.expiresOn,
    });
}

function assertProductActive(product: PostingProduct) {
  if (product.archivedAt)
    throw businessRuleViolation("PRODUCT_ARCHIVED", "The product is archived");
}

function line(
  base: Omit<PostingLine, "postingKey" | "enteredQuantity" | "quantityDelta"> & {
    quantity: Decimal;
    entered: Decimal;
    sign: 1 | -1;
  },
  postingKey: string,
): PostingLine {
  const { quantity, entered, sign, ...rest } = base;
  return {
    ...rest,
    quantityDelta: sign === 1 ? quantity : quantity.negated(),
    enteredQuantity: sign === 1 ? entered : entered.negated(),
    postingKey,
  };
}

// ─── Opening balance ───

/**
 * Initial stock for a product in a warehouse, before it has any other
 * movement there (receiving-independent onboarding, DATA_MODEL.md §4).
 */
export async function postOpeningBalance(
  ctx: TenantContext,
  rawInput: unknown,
): Promise<PostedDocument> {
  const parsed = openingBalanceSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "inventory.opening_balance", input },
    async (tx) => {
      const wh = await loadWarehouse(tx, ctx, input.warehouseId);
      assertWarehousePermission(ctx, "inventory.adjust", wh);
      assertActive(wh);
      const product = await loadProductForPosting(tx, ctx, input.productId);
      assertProductActive(product);
      await assertNoOperationalHistory(tx, ctx, product.id, wh.id);
      const locationId = await loadLocation(tx, ctx, wh.id, input.locationId, true);
      const lot = await resolveInboundLot(tx, ctx, product, input);
      const quantity = await toBase(tx, ctx, product, input.uomId, input.quantity);
      const documentId = uuidv7();
      const result = await postDocument(
        tx,
        ctx,
        { id: documentId, type: "OPENING_BALANCE", warehouseId: wh.id, note: input.note },
        [
          line(
            {
              movementType: "OPENING_BALANCE",
              warehouseId: wh.id,
              locationId,
              productId: product.id,
              lotId: lot?.id ?? null,
              stockStatus: "AVAILABLE",
              quantity,
              entered: toDecimal(input.quantity),
              sign: 1,
              enteredUomId: input.uomId,
              unitCost: unitCostPerBase(input.unitCost, input.quantity, quantity),
              note: input.note,
            },
            `opening:${documentId}:1`,
          ),
        ],
        { year: yearOf(todayFor(wh)) },
      );
      return { documentId: result.documentId, number: result.number };
    },
  );
}

/** Unit cost is entered per entered unit; the ledger stores it per base unit. */
function unitCostPerBase(
  unitCost: string | undefined,
  enteredQuantity: string,
  baseQuantity: Decimal,
): Decimal | null {
  const cost = decimalOrNull(unitCost);
  if (cost === null) return null;
  return cost
    .times(toDecimal(enteredQuantity))
    .dividedBy(baseQuantity)
    .toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

async function assertNoOperationalHistory(
  tx: Tx,
  ctx: TenantContext,
  productId: string,
  warehouseId: string,
) {
  const other = await tx.inventoryLedgerEntry.count({
    where: {
      organizationId: ctx.organizationId,
      productId,
      warehouseId,
      movementType: { notIn: ["OPENING_BALANCE", "REVERSAL"] },
    },
  });
  if (other > 0) {
    throw businessRuleViolation(
      "OPENING_BALANCE_AFTER_MOVEMENTS",
      "Opening balances are only accepted before other movements; use an adjustment",
    );
  }
}

// ─── Adjustment ───

export async function postAdjustment(
  ctx: TenantContext,
  rawInput: unknown,
): Promise<PostedDocument> {
  const parsed = adjustmentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "inventory.adjustment", input },
    async (tx) => {
      const wh = await loadWarehouse(tx, ctx, input.warehouseId);
      assertWarehousePermission(ctx, "inventory.adjust", wh);
      assertActive(wh);
      const product = await loadProductForPosting(tx, ctx, input.productId);
      const increase = input.direction === "INCREASE";
      if (increase) assertProductActive(product);
      const locationId = await loadLocation(tx, ctx, wh.id, input.locationId, increase);
      let lot: LotInfo | null;
      if (increase) {
        lot = await resolveInboundLot(tx, ctx, product, input);
      } else {
        lot = await findLotByCode(tx, ctx, product, input.lotCode);
      }
      const quantity = await toBase(tx, ctx, product, input.uomId, input.quantity);
      const documentId = uuidv7();
      const result = await postDocument(
        tx,
        ctx,
        {
          id: documentId,
          type: "ADJUSTMENT",
          warehouseId: wh.id,
          reasonCode: input.reasonCode,
          note: input.note,
        },
        [
          line(
            {
              movementType: "ADJUSTMENT",
              warehouseId: wh.id,
              locationId,
              productId: product.id,
              lotId: lot?.id ?? null,
              stockStatus: input.stockStatus,
              quantity,
              entered: toDecimal(input.quantity),
              sign: increase ? 1 : -1,
              enteredUomId: input.uomId,
              reasonCode: input.reasonCode,
              note: input.note,
            },
            `adjustment:${documentId}:1`,
          ),
        ],
        { year: yearOf(todayFor(wh)) },
      );
      return { documentId: result.documentId, number: result.number };
    },
  );
}

async function findLotByCode(
  tx: Tx,
  ctx: TenantContext,
  product: PostingProduct,
  lotCode: string | undefined,
): Promise<LotInfo | null> {
  if (product.lotTracking === "NONE") {
    if (lotCode)
      throw businessRuleViolation("PRODUCT_NOT_LOT_TRACKED", "This product is not lot-tracked");
    return null;
  }
  if (!lotCode) throw fieldError("lotCode", "lotRequired");
  const lot = await tx.inventoryLot.findFirst({
    where: { organizationId: ctx.organizationId, productId: product.id, lotCode },
    select: { id: true, lotCode: true, expiresOn: true, recallHold: true },
  });
  if (!lot) throw fieldError("lotCode", "lotNotFound");
  return {
    id: lot.id,
    lotCode: lot.lotCode,
    expiresOn: lot.expiresOn?.toISOString().slice(0, 10) ?? null,
    recallHold: lot.recallHold,
  };
}

// ─── Write-off ───

/** Remove stock from any status bucket — including expired or rejected stock. */
export async function postWriteOff(ctx: TenantContext, rawInput: unknown): Promise<PostedDocument> {
  const parsed = writeOffSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "inventory.write_off", input },
    async (tx) => {
      const wh = await loadWarehouse(tx, ctx, input.warehouseId);
      assertWarehousePermission(ctx, "inventory.adjust", wh);
      const product = await loadProductForPosting(tx, ctx, input.productId);
      const locationId = await loadLocation(tx, ctx, wh.id, input.locationId, false);
      const lot = await resolveExistingLot(tx, ctx, product, input.lotId);
      const quantity = await toBase(tx, ctx, product, input.uomId, input.quantity);
      const documentId = uuidv7();
      const result = await postDocument(
        tx,
        ctx,
        {
          id: documentId,
          type: "WRITE_OFF",
          warehouseId: wh.id,
          reasonCode: input.reasonCode,
          note: input.note,
        },
        [
          line(
            {
              movementType: "WRITE_OFF",
              warehouseId: wh.id,
              locationId,
              productId: product.id,
              lotId: lot?.id ?? null,
              stockStatus: input.stockStatus,
              quantity,
              entered: toDecimal(input.quantity),
              sign: -1,
              enteredUomId: input.uomId,
              reasonCode: input.reasonCode,
              note: input.note,
            },
            `write_off:${documentId}:1`,
          ),
        ],
        { year: yearOf(todayFor(wh)) },
      );
      return { documentId: result.documentId, number: result.number };
    },
  );
}

// ─── Transfer ───

/**
 * Move available stock between warehouses or locations in one atomic posting
 * (TRANSFER_OUT + TRANSFER_IN). Lot identity and status are preserved.
 * In-transit tracking is deferred (DECISIONS.md ADR-016).
 */
export async function postTransfer(ctx: TenantContext, rawInput: unknown): Promise<PostedDocument> {
  const parsed = transferSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  if (
    input.warehouseId === input.toWarehouseId &&
    (input.locationId ?? null) === (input.toLocationId ?? null)
  ) {
    throw businessRuleViolation("TRANSFER_SAME_PLACE", "Source and destination are the same");
  }
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "inventory.transfer", input },
    async (tx) => {
      const from = await loadWarehouse(tx, ctx, input.warehouseId);
      const to =
        input.toWarehouseId === from.id ? from : await loadWarehouse(tx, ctx, input.toWarehouseId);
      assertWarehousePermission(ctx, "inventory.transfer", from);
      assertWarehousePermission(ctx, "inventory.transfer", to);
      assertActive(from);
      assertActive(to);
      const product = await loadProductForPosting(tx, ctx, input.productId);
      const fromLocation = await loadLocation(tx, ctx, from.id, input.locationId, false);
      const toLocation = await loadLocation(tx, ctx, to.id, input.toLocationId, true);
      const lot = await resolveExistingLot(tx, ctx, product, input.lotId);
      assertUsable(lot, todayFor(from));
      const quantity = await toBase(tx, ctx, product, input.uomId, input.quantity);
      const entered = toDecimal(input.quantity);
      const documentId = uuidv7();
      const common = {
        productId: product.id,
        lotId: lot?.id ?? null,
        stockStatus: "AVAILABLE" as StockStatus,
        quantity,
        entered,
        enteredUomId: input.uomId,
        note: input.note,
      };
      const result = await postDocument(
        tx,
        ctx,
        {
          id: documentId,
          type: "TRANSFER",
          warehouseId: from.id,
          destinationWarehouseId: to.id,
          note: input.note,
        },
        [
          line(
            {
              ...common,
              movementType: "TRANSFER_OUT",
              warehouseId: from.id,
              locationId: fromLocation,
              sign: -1,
            },
            `transfer:${documentId}:1:out`,
          ),
          line(
            {
              ...common,
              movementType: "TRANSFER_IN",
              warehouseId: to.id,
              locationId: toLocation,
              sign: 1,
              // The destination receives the stock at the cost it left with.
              costFromLine: 0,
            },
            `transfer:${documentId}:1:in`,
          ),
        ],
        { year: yearOf(todayFor(from)) },
      );
      return { documentId: result.documentId, number: result.number };
    },
  );
}

// ─── Status change (quarantine, hold, reject, release) ───

export async function postStatusChange(
  ctx: TenantContext,
  rawInput: unknown,
): Promise<PostedDocument> {
  const parsed = statusChangeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  const permission = transitionPermission(input.fromStatus, input.toStatus);
  if (!permission)
    throw businessRuleViolation(
      "STATUS_TRANSITION_NOT_ALLOWED",
      "This status change is not allowed",
    );
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "inventory.status_change", input },
    async (tx) => {
      const wh = await loadWarehouse(tx, ctx, input.warehouseId);
      assertWarehousePermission(ctx, permission, wh);
      const product = await loadProductForPosting(tx, ctx, input.productId);
      const locationId = await loadLocation(tx, ctx, wh.id, input.locationId, false);
      const lot = await resolveExistingLot(tx, ctx, product, input.lotId);
      // Releasing to normal use requires the stock to be usable.
      if (input.toStatus === "AVAILABLE") assertUsable(lot, todayFor(wh));
      const quantity = await toBase(tx, ctx, product, input.uomId, input.quantity);
      const entered = toDecimal(input.quantity);
      const documentId = uuidv7();
      const common = {
        movementType: "STATUS_CHANGE" as MovementType,
        warehouseId: wh.id,
        locationId,
        productId: product.id,
        lotId: lot?.id ?? null,
        quantity,
        entered,
        enteredUomId: input.uomId,
        reasonCode: input.reasonCode,
        note: input.note,
      };
      const result = await postDocument(
        tx,
        ctx,
        {
          id: documentId,
          type: "STATUS_CHANGE",
          warehouseId: wh.id,
          reasonCode: input.reasonCode,
          note: input.note,
        },
        [
          line(
            { ...common, stockStatus: input.fromStatus, sign: -1 },
            `status:${documentId}:1:from`,
          ),
          line(
            { ...common, stockStatus: input.toStatus, sign: 1, costFromLine: 0 },
            `status:${documentId}:1:to`,
          ),
        ],
        {
          year: yearOf(todayFor(wh)),
          auditChanges: { from: input.fromStatus, to: input.toStatus },
        },
      );
      return { documentId: result.documentId, number: result.number };
    },
  );
}

// ─── Goods receipt (called by purchasing) ───

export interface ReceiptPostingLine {
  /** Index of the line in the submitted form, for field errors ("lines.<i>.<field>"). */
  formIndex: number;
  sourceLineId: string;
  productId: string;
  uomId: string;
  /** Accepted quantity in uomId (decimal string, > 0). */
  quantity: string;
  /** Price per uomId (decimal string), base currency. */
  unitPrice: string;
  lotCode?: string;
  expiresOn?: string;
  bestBeforeOn?: string;
  quarantine: boolean;
}

/** Point a field error raised for one line at that line's inputs. */
function atLine<T>(formIndex: number, fn: () => Promise<T>): Promise<T> {
  return fn().catch((error: unknown) => {
    if (error instanceof AppError && error.details) {
      const issues = error.details.issues as Array<{ path: string }> | undefined;
      issues?.forEach((i) => (i.path = `lines.${formIndex}.${i.path}`));
      if (typeof error.details.field === "string")
        error.details.field = `lines.${formIndex}.${error.details.field}`;
    }
    throw error;
  });
}

/**
 * Post the accepted quantities of a goods receipt into stock, inside the
 * purchasing transaction: lots are created or matched, quantities converted
 * to the base unit, and each line valued at its receipt price (ADR-021).
 * Accepted stock goes to AVAILABLE, or to QUARANTINE when flagged for
 * inspection. Expired or recall-held lots cannot be accepted.
 */
export async function postReceiptInTx(
  tx: Tx,
  ctx: TenantContext,
  input: {
    warehouseId: string;
    locationId: string | null;
    receiptNumber: string;
    note?: string;
    lines: ReceiptPostingLine[];
  },
): Promise<{
  documentId: string;
  number: string;
  lines: Array<{ lotId: string | null; quantityBase: string }>;
}> {
  const wh = await loadWarehouse(tx, ctx, input.warehouseId);
  assertWarehousePermission(ctx, "purchasing.receive", wh);
  assertActive(wh);
  const locationId = await loadLocation(tx, ctx, wh.id, input.locationId ?? undefined, true);
  const today = todayFor(wh);
  const documentId = uuidv7();
  const posted: Array<{ lotId: string | null; quantityBase: string }> = [];
  const postingLines: PostingLine[] = [];
  for (const l of input.lines) {
    await atLine(l.formIndex, async () => {
      const product = await loadProductForPosting(tx, ctx, l.productId);
      assertProductActive(product);
      const lot = await resolveInboundLot(tx, ctx, product, l);
      if (lot?.recallHold)
        throw businessRuleViolation("LOT_ON_RECALL_HOLD", "This lot is on recall hold");
      if (lot && isExpired(lot.expiresOn, today))
        throw businessRuleViolation("LOT_EXPIRED_ON_RECEIPT", "Expired goods cannot be accepted", {
          expiresOn: lot.expiresOn,
        });
      const quantity = await toBase(tx, ctx, product, l.uomId, l.quantity);
      posted.push({ lotId: lot?.id ?? null, quantityBase: quantity.toFixed() });
      postingLines.push(
        line(
          {
            movementType: "RECEIPT",
            warehouseId: wh.id,
            locationId,
            productId: product.id,
            lotId: lot?.id ?? null,
            stockStatus: l.quarantine ? "QUARANTINE" : "AVAILABLE",
            quantity,
            entered: toDecimal(l.quantity),
            sign: 1,
            enteredUomId: l.uomId,
            unitCost: unitCostPerBase(l.unitPrice, l.quantity, quantity),
            sourceLineId: l.sourceLineId,
            note: input.note,
          },
          `receipt:${l.sourceLineId}`,
        ),
      );
    });
  }
  const result = await postDocument(
    tx,
    ctx,
    {
      id: documentId,
      type: "RECEIPT",
      warehouseId: wh.id,
      note: input.note,
    },
    postingLines,
    { year: yearOf(today), auditChanges: { receipt: input.receiptNumber } },
  );
  return { documentId: result.documentId, number: result.number, lines: posted };
}

// ─── Revaluation ───

/**
 * Set a new average cost for a product in a warehouse (ADR-021): the value of
 * the stock on hand becomes quantity × new cost. Used to price stock that was
 * added without a cost, or to correct a wrong cost.
 */
export async function revalueStock(ctx: TenantContext, rawInput: unknown): Promise<PostedDocument> {
  const parsed = revaluationSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "inventory.revaluation", input },
    async (tx) => {
      const wh = await loadWarehouse(tx, ctx, input.warehouseId);
      assertWarehousePermission(ctx, "inventory.valuation.revalue", wh);
      const product = await loadProductForPosting(tx, ctx, input.productId);
      const result = await postRevaluation(
        tx,
        ctx,
        {
          warehouseId: wh.id,
          productId: product.id,
          newUnitCost: toDecimal(input.unitCost),
          reasonCode: input.reasonCode,
          note: input.note,
        },
        { year: yearOf(todayFor(wh)) },
      );
      return {
        documentId: result.documentId,
        number: result.number,
        valueDelta: result.valueDelta,
      };
    },
  );
}

// ─── Reversal ───

/**
 * Post the exact opposite of a document. A document can be reversed once
 * (unique constraint); reversals themselves cannot be reversed. Fails with
 * INSUFFICIENT_STOCK if the stock it added has since been used.
 */
export async function reverseDocument(
  ctx: TenantContext,
  documentId: string,
  rawInput: unknown,
): Promise<PostedDocument> {
  const parsed = reversalSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, (tx) =>
    reverseDocumentInTx(tx, ctx, documentId, parsed.data, { allowReceipt: false }),
  );
}

/**
 * Reverse a document inside the caller's transaction. Goods receipts are
 * reversed only through purchasing (which also corrects the order), so the
 * generic path refuses them.
 */
export async function reverseDocumentInTx(
  tx: Tx,
  ctx: TenantContext,
  documentId: string,
  input: { reasonCode: string; note?: string },
  options: { allowReceipt: boolean; allowConsumption?: boolean; permission?: Permission },
): Promise<PostedDocument> {
  const doc = await tx.inventoryDocument.findFirst({
    where: { organizationId: ctx.organizationId, id: documentId },
    select: {
      id: true,
      number: true,
      type: true,
      warehouseId: true,
      destinationWarehouseId: true,
      reversedBy: { select: { id: true } },
      entries: { orderBy: { id: "asc" } },
    },
  });
  if (!doc) throw notFound("Document");
  const wh = await loadWarehouse(tx, ctx, doc.warehouseId);
  assertWarehousePermission(ctx, options.permission ?? "inventory.reverse", wh);
  if (doc.destinationWarehouseId && doc.destinationWarehouseId !== doc.warehouseId) {
    assertWarehousePermission(
      ctx,
      options.permission ?? "inventory.reverse",
      await loadWarehouse(tx, ctx, doc.destinationWarehouseId),
    );
  }
  if (doc.type === "REVERSAL")
    throw businessRuleViolation("CANNOT_REVERSE_REVERSAL", "A reversal cannot be reversed");
  if (doc.type === "DISPATCH" || doc.type === "TRANSIT_RECEIPT")
    throw businessRuleViolation(
      "SHIPMENT_DOCUMENT_NOT_REVERSIBLE",
      "Shipment postings are corrected from the shipment",
    );
  if (doc.type === "RECEIPT" && !options.allowReceipt)
    throw businessRuleViolation(
      "RECEIPT_REVERSE_IN_PURCHASING",
      "Reverse goods receipts from the receipt page",
    );
  if (doc.type === "CONSUMPTION" && !options.allowConsumption)
    throw businessRuleViolation(
      "CONSUMPTION_REVERSE_IN_SALES",
      "Reverse sales consumption from the sales import",
    );
  if (doc.type === "LANDED_COST")
    throw businessRuleViolation(
      "CANNOT_REVERSE_LANDED_COST",
      "A landed cost cannot be reversed; correct the cost with a revaluation",
    );
  if (doc.type === "REVALUATION")
    throw businessRuleViolation(
      "CANNOT_REVERSE_REVALUATION",
      "A revaluation cannot be reversed; post a new revaluation",
    );
  if (doc.reversedBy)
    throw conflict("This document was already reversed", { reason: "alreadyReversed" });
  const reversalId = uuidv7();
  const result = await postDocument(
    tx,
    ctx,
    {
      id: reversalId,
      type: "REVERSAL",
      warehouseId: doc.warehouseId,
      destinationWarehouseId: doc.destinationWarehouseId ?? undefined,
      reasonCode: input.reasonCode,
      note: input.note,
      reversesDocumentId: doc.id,
    },
    doc.entries.map((e, i) => ({
      ...reversalCost(doc.entries, i),
      movementType: "REVERSAL",
      warehouseId: e.warehouseId,
      locationId: e.locationId,
      productId: e.productId,
      lotId: e.lotId,
      stockStatus: e.stockStatus,
      quantityDelta: new Decimal(e.quantityDelta.toString()).negated(),
      enteredQuantity: new Decimal(e.enteredQuantity.toString()).negated(),
      enteredUomId: e.enteredUomId,
      postingKey: `reversal:${e.id}`,
      reversesEntryId: e.id,
      reasonCode: input.reasonCode,
      note: input.note,
    })),
    { year: yearOf(todayFor(wh)), auditChanges: { reverses: doc.number } },
  ).catch((error) => {
    // A concurrent reversal of the same document committed first.
    if (isUniqueViolation(error, "inventory_documents_organization_id_reverses_document_id_key")) {
      throw conflict("This document was already reversed", { reason: "alreadyReversed" });
    }
    throw error;
  });
  return { documentId: result.documentId, number: result.number };
}

interface ReversedEntry {
  postingKey: string;
  quantityDelta: { toString(): string };
  valueDelta: { toString(): string };
  unitCost: { toString(): string } | null;
}

/**
 * Valuation of a reversal line (ADR-021). A reversal undoes exactly what the
 * entry did to value: reversing an inbound entry takes out the value it
 * added (capped at the value on hand), reversing an outbound entry puts back
 * what it took. Paired documents (transfer, status change) are instead
 * reversed as a move back: the outbound leg leaves at the average and the
 * inbound leg carries that value, so no value is created or lost.
 */
function reversalCost(
  entries: ReversedEntry[],
  i: number,
): Pick<PostingLine, "costFromLine" | "restore"> {
  const e = entries[i];
  const inbound = new Decimal(e.quantityDelta.toString()).gt(0);
  // Legs of one transfer or status change share a posting-key prefix ("transfer:<doc>:1").
  const prefix = e.postingKey.slice(0, e.postingKey.lastIndexOf(":"));
  const pair = entries.findIndex(
    (o, j) =>
      j !== i &&
      o.postingKey.slice(0, o.postingKey.lastIndexOf(":")) === prefix &&
      new Decimal(o.quantityDelta.toString()).gt(0) !== inbound,
  );
  if (pair !== -1) return inbound ? {} : { costFromLine: pair };
  return {
    restore: {
      valueDelta: new Decimal(e.valueDelta.toString()),
      unitCost: e.unitCost === null ? null : new Decimal(e.unitCost.toString()),
    },
  };
}
