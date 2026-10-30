import "server-only";
import type { StockStatus } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { uuidv7 } from "@/lib/uuid";
import type { TenantContext } from "@/modules/tenancy/context";
import type { Tx } from "@/server/db/transactions";
import { loadWarehouse, todayFor } from "./context";
import { postDocument, type PostingLine } from "./posting";

/**
 * Stock movements for recalls (DECISIONS.md ADR-034). The recall service
 * authorizes the user (`recalls.manage`); a recall acts on every warehouse
 * of the organization, whatever the user's own warehouse scope.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());

/** Flag (or unflag) lots: recall-held stock cannot be dispatched, transferred or released. */
export async function setRecallHoldInTx(
  tx: Tx,
  ctx: TenantContext,
  lotIds: string[],
  hold: boolean,
) {
  if (lotIds.length === 0) return;
  await tx.inventoryLot.updateMany({
    where: { organizationId: ctx.organizationId, id: { in: lotIds } },
    data: { recallHold: hold },
  });
}

async function balancesOf(tx: Tx, ctx: TenantContext, lotIds: string[], statuses: StockStatus[]) {
  const rows = await tx.stockBalance.findMany({
    where: {
      organizationId: ctx.organizationId,
      lotId: { in: lotIds },
      stockStatus: { in: statuses },
      onHandQuantity: { gt: 0 },
    },
    select: {
      warehouseId: true,
      locationId: true,
      productId: true,
      lotId: true,
      stockStatus: true,
      onHandQuantity: true,
      product: { select: { baseUomId: true } },
    },
    orderBy: [{ warehouseId: "asc" }, { productId: "asc" }, { id: "asc" }],
  });
  const byWarehouse = new Map<string, typeof rows>();
  for (const r of rows)
    byWarehouse.set(r.warehouseId, [...(byWarehouse.get(r.warehouseId) ?? []), r]);
  return byWarehouse;
}

/** Move AVAILABLE and QUARANTINE stock of the lots to ON_HOLD, one document per warehouse. */
export async function holdLotsInTx(
  tx: Tx,
  ctx: TenantContext,
  lotIds: string[],
  note: string,
): Promise<string[]> {
  const documents: string[] = [];
  for (const [warehouseId, rows] of await balancesOf(tx, ctx, lotIds, [
    "AVAILABLE",
    "QUARANTINE",
  ])) {
    const wh = await loadWarehouse(tx, ctx, warehouseId);
    const id = uuidv7();
    const lines: PostingLine[] = rows.flatMap((r, i) => {
      const quantity = dec(r.onHandQuantity);
      const common = {
        movementType: "STATUS_CHANGE" as const,
        warehouseId,
        locationId: r.locationId,
        productId: r.productId,
        lotId: r.lotId,
        enteredUomId: r.product.baseUomId,
        reasonCode: "RECALL_INVESTIGATION",
        note,
      };
      return [
        {
          ...common,
          stockStatus: r.stockStatus,
          quantityDelta: quantity.negated(),
          enteredQuantity: quantity.negated(),
          postingKey: `recall-hold:${id}:${i + 1}:from`,
        },
        {
          ...common,
          stockStatus: "ON_HOLD" as const,
          quantityDelta: quantity,
          enteredQuantity: quantity,
          costFromLine: i * 2,
          postingKey: `recall-hold:${id}:${i + 1}:to`,
        },
      ];
    });
    const result = await postDocument(
      tx,
      ctx,
      { id, type: "STATUS_CHANGE", warehouseId, reasonCode: "RECALL_INVESTIGATION", note },
      lines,
      { year: Number(todayFor(wh).slice(0, 4)), auditChanges: { to: "ON_HOLD", recall: true } },
    );
    documents.push(result.documentId);
  }
  return documents;
}

/** Write off the ON_HOLD stock of the lots, one document per warehouse. */
export async function writeOffHeldLotsInTx(
  tx: Tx,
  ctx: TenantContext,
  lotIds: string[],
  note: string,
): Promise<string[]> {
  const documents: string[] = [];
  for (const [warehouseId, rows] of await balancesOf(tx, ctx, lotIds, ["ON_HOLD"])) {
    const wh = await loadWarehouse(tx, ctx, warehouseId);
    const id = uuidv7();
    const lines: PostingLine[] = rows.map((r, i) => {
      const quantity = dec(r.onHandQuantity).negated();
      return {
        movementType: "WRITE_OFF",
        warehouseId,
        locationId: r.locationId,
        productId: r.productId,
        lotId: r.lotId,
        stockStatus: "ON_HOLD",
        quantityDelta: quantity,
        enteredQuantity: quantity,
        enteredUomId: r.product.baseUomId,
        reasonCode: "RECALLED",
        note,
        postingKey: `recall-dispose:${id}:${i + 1}`,
      };
    });
    const result = await postDocument(
      tx,
      ctx,
      { id, type: "WRITE_OFF", warehouseId, reasonCode: "RECALLED", note },
      lines,
      { year: Number(todayFor(wh).slice(0, 4)), auditChanges: { recall: true } },
    );
    documents.push(result.documentId);
  }
  return documents;
}
