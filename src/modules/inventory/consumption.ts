import "server-only";
import { Decimal, roundQuantity } from "@/lib/decimal";
import { uuidv7 } from "@/lib/uuid";
import type { TenantContext } from "@/modules/tenancy/context";
import type { Tx } from "@/server/db/transactions";
import { todayFor, type WarehouseInfo } from "./context";
import { postDocument, type PostingLine } from "./posting";
import { fefoAllocate } from "./rules";

/**
 * Stock used by sales (DECISIONS.md ADR-036): per product, AVAILABLE stock
 * of the warehouse is taken first-expired-first-out; expired and
 * recall-held lots are never used. Shortages are returned, not posted —
 * stock never goes negative.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());

export interface ConsumptionShortage {
  productId: string;
  required: Decimal;
  available: Decimal;
}

export async function planConsumptionInTx(
  tx: Tx,
  ctx: TenantContext,
  warehouse: WarehouseInfo,
  usage: ReadonlyMap<string, Decimal>,
) {
  const today = todayFor(warehouse);
  const ids = [...usage.keys()];
  const balances = await tx.stockBalance.findMany({
    where: {
      organizationId: ctx.organizationId,
      warehouseId: warehouse.id,
      productId: { in: ids },
      stockStatus: "AVAILABLE",
      onHandQuantity: { gt: 0 },
    },
    select: {
      id: true,
      productId: true,
      locationId: true,
      lotId: true,
      onHandQuantity: true,
      reservedQuantity: true,
      product: { select: { baseUomId: true } },
      lot: {
        select: { expiresOn: true, bestBeforeOn: true, recallHold: true, firstReceivedAt: true },
      },
    },
  });
  const picks: Array<{
    productId: string;
    locationId: string | null;
    lotId: string | null;
    quantity: Decimal;
    uomId: string;
  }> = [];
  const shortages: ConsumptionShortage[] = [];
  for (const [productId, required] of usage) {
    if (!required.gt(0)) continue;
    const candidates = balances
      .filter((b) => b.productId === productId && !b.lot?.recallHold)
      .map((b) => ({
        balance: b,
        lotId: b.lotId,
        expiresOn: b.lot?.expiresOn?.toISOString().slice(0, 10) ?? null,
        bestBeforeOn: b.lot?.bestBeforeOn?.toISOString().slice(0, 10) ?? null,
        firstReceivedAt: b.lot?.firstReceivedAt ?? new Date(0),
        available: dec(b.onHandQuantity).minus(dec(b.reservedQuantity)),
      }));
    const plan = fefoAllocate(candidates, required, today);
    if (plan.shortfall.gt(0)) {
      shortages.push({
        productId,
        required,
        available: roundQuantity(required.minus(plan.shortfall)),
      });
      continue;
    }
    for (const p of plan.picks)
      picks.push({
        productId,
        locationId: p.candidate.balance.locationId,
        lotId: p.candidate.lotId,
        quantity: p.quantity,
        uomId: p.candidate.balance.product.baseUomId,
      });
  }
  return { picks, shortages };
}

/** Post the planned picks as one CONSUMPTION document. */
export async function postConsumptionInTx(
  tx: Tx,
  ctx: TenantContext,
  warehouse: WarehouseInfo,
  picks: Awaited<ReturnType<typeof planConsumptionInTx>>["picks"],
  note: string,
) {
  const id = uuidv7();
  const lines: PostingLine[] = picks.map((p, i) => ({
    movementType: "CONSUMPTION",
    warehouseId: warehouse.id,
    locationId: p.locationId,
    productId: p.productId,
    lotId: p.lotId,
    stockStatus: "AVAILABLE",
    quantityDelta: p.quantity.negated(),
    enteredQuantity: p.quantity.negated(),
    enteredUomId: p.uomId,
    reasonCode: "SALES",
    note,
    postingKey: `consumption:${id}:${i + 1}`,
  }));
  const result = await postDocument(
    tx,
    ctx,
    { id, type: "CONSUMPTION", warehouseId: warehouse.id, reasonCode: "SALES", note },
    lines,
    { year: Number(todayFor(warehouse).slice(0, 4)) },
  );
  const entries = await tx.inventoryLedgerEntry.aggregate({
    where: { organizationId: ctx.organizationId, documentId: result.documentId },
    _sum: { valueDelta: true },
  });
  return { ...result, cost: dec(entries._sum.valueDelta ?? 0).negated() };
}
