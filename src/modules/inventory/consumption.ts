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
  /** Take what is available and report the rest as a shortage (POS sales, ADR-059). */
  options: { partial?: boolean } = {},
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
      // Stock staged in a dispatch location belongs to a pick list (ADR-102).
      NOT: { location: { zone: "DISPATCH" } },
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
    balanceId: string;
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
      if (!options.partial) continue;
    }
    for (const p of plan.picks)
      picks.push({
        balanceId: p.candidate.balance.id,
        productId,
        locationId: p.candidate.balance.locationId,
        lotId: p.candidate.lotId,
        quantity: p.quantity,
        uomId: p.candidate.balance.product.baseUomId,
      });
  }
  return { picks, shortages };
}

/**
 * Post the planned picks as one CONSUMPTION document (sales), or as a
 * WRITE_OFF when food was made and not sold (a voided kitchen item, ADR-062),
 * so it appears with waste.
 */
export async function postConsumptionInTx(
  tx: Tx,
  ctx: TenantContext,
  warehouse: WarehouseInfo,
  picks: Awaited<ReturnType<typeof planConsumptionInTx>>["picks"],
  note: string,
  as: { waste?: boolean } = {},
) {
  const id = uuidv7();
  const movementType = as.waste ? ("WRITE_OFF" as const) : ("CONSUMPTION" as const);
  const reasonCode = as.waste ? "PREPARED_NOT_SOLD" : "SALES";
  const lines: PostingLine[] = picks.map((p, i) => ({
    movementType,
    warehouseId: warehouse.id,
    locationId: p.locationId,
    productId: p.productId,
    lotId: p.lotId,
    stockStatus: "AVAILABLE",
    quantityDelta: p.quantity.negated(),
    enteredQuantity: p.quantity.negated(),
    enteredUomId: p.uomId,
    reasonCode,
    note,
    postingKey: `consumption:${id}:${i + 1}`,
  }));
  const result = await postDocument(
    tx,
    ctx,
    { id, type: movementType, warehouseId: warehouse.id, reasonCode, note },
    lines,
    { year: Number(todayFor(warehouse).slice(0, 4)) },
  );
  const entries = await tx.inventoryLedgerEntry.aggregate({
    where: { organizationId: ctx.organizationId, documentId: result.documentId },
    _sum: { valueDelta: true },
  });
  return { ...result, cost: dec(entries._sum.valueDelta ?? 0).negated() };
}
