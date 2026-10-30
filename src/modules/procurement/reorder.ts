import "server-only";
import { Decimal, toDecimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { findProduct, quantityInBaseUnit } from "@/modules/catalog/service";
import { businessDate, isExpired } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { addDraftLineInTx, canOnWarehouse, createDraftOrderInTx, recomputeTotal } from "./orders";
import { suggestReorder } from "./rules";
import { reorderRuleSchema } from "./schemas";

/**
 * Reorder rules (par levels) and suggested orders (DECISIONS.md ADR-025).
 * Suggestions are recomputed on the server whenever orders are created from
 * them; quantities sent by the browser are never trusted.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const OPEN_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PARTIALLY_RECEIVED"] as const;

async function loadWarehouse(tx: Tx, ctx: TenantContext, warehouseId: string) {
  const wh = await tx.warehouse.findFirst({
    where: { organizationId: ctx.organizationId, id: warehouseId },
    select: {
      id: true,
      code: true,
      name: true,
      branchId: true,
      archivedAt: true,
      branch: { select: { timeZone: true, archivedAt: true } },
    },
  });
  if (!wh || !canOnWarehouse(ctx, "purchasing.view", wh)) throw notFound("Warehouse");
  return wh;
}

export async function saveReorderRule(ctx: TenantContext, rawInput: unknown) {
  const parsed = reorderRuleSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wh = await loadWarehouse(tx, ctx, input.warehouseId);
    assertPermission(ctx.grants, "purchasing.manage", {
      branchId: wh.branchId,
      warehouseId: wh.id,
    });
    assertPermission(ctx.grants, "catalog.view");
    const product = await findProduct(tx, ctx, input.productId);
    if (product.archivedAt)
      throw businessRuleViolation("PRODUCT_ARCHIVED", "The product is archived");
    const toBase = async (q: string) =>
      toDecimal(q).isZero() ? new Decimal(0) : quantityInBaseUnit(tx, ctx, product, input.uomId, q);
    const minBase = await toBase(input.minQuantity);
    const maxBase = await toBase(input.maxQuantity);
    if (maxBase.lessThan(minBase))
      throw businessRuleViolation(
        "REORDER_MAX_BELOW_MIN",
        "The maximum must not be below the minimum",
        {
          field: "maxQuantity",
        },
      );
    const rule = await tx.reorderRule.upsert({
      where: {
        organizationId_warehouseId_productId: {
          organizationId: ctx.organizationId,
          warehouseId: wh.id,
          productId: product.id,
        },
      },
      create: {
        organizationId: ctx.organizationId,
        warehouseId: wh.id,
        productId: product.id,
        minQuantityBase: minBase.toFixed(),
        maxQuantityBase: maxBase.toFixed(),
      },
      update: { minQuantityBase: minBase.toFixed(), maxQuantityBase: maxBase.toFixed() },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "reorder_rule.saved",
      entityType: "warehouse",
      entityId: wh.id,
      changes: { productId: product.id, min: minBase.toFixed(), max: maxBase.toFixed() },
    });
    return rule;
  });
}

export async function removeReorderRule(ctx: TenantContext, ruleId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const rule = await tx.reorderRule.findFirst({
      where: { organizationId: ctx.organizationId, id: ruleId },
    });
    if (!rule) throw notFound("Reorder rule");
    const wh = await loadWarehouse(tx, ctx, rule.warehouseId);
    assertPermission(ctx.grants, "purchasing.manage", {
      branchId: wh.branchId,
      warehouseId: wh.id,
    });
    await tx.reorderRule.delete({ where: { id: rule.id } });
    await recordAudit(tx, actorOf(ctx), {
      action: "reorder_rule.removed",
      entityType: "warehouse",
      entityId: wh.id,
      changes: { productId: rule.productId },
    });
  });
}

/** Rules of a warehouse with stock, open orders and the suggested order for each. */
async function buildPlan(tx: Tx, ctx: TenantContext, warehouseId: string) {
  const wh = await loadWarehouse(tx, ctx, warehouseId);
  const today = businessDate(wh.branch.timeZone ?? ctx.timeZone);
  const rules = await tx.reorderRule.findMany({
    where: { organizationId: ctx.organizationId, warehouseId: wh.id },
    include: {
      product: {
        select: {
          id: true,
          sku: true,
          nameEn: true,
          nameAr: true,
          archivedAt: true,
          baseUom: { select: { code: true } },
          supplierProducts: {
            where: { archivedAt: null, supplier: { archivedAt: null } },
            select: {
              preferred: true,
              lastUnitPrice: true,
              minOrderQuantity: true,
              purchaseUom: { select: { id: true, code: true } },
              supplier: { select: { id: true, code: true, name: true, nameAr: true } },
            },
          },
        },
      },
    },
    orderBy: { product: { sku: "asc" } },
  });
  const productIds = rules.map((r) => r.productId);
  const [balances, openLines] = await inSequence([
    tx.stockBalance.findMany({
      where: {
        organizationId: ctx.organizationId,
        warehouseId: wh.id,
        productId: { in: productIds },
        stockStatus: "AVAILABLE",
        onHandQuantity: { gt: 0 },
      },
      select: {
        productId: true,
        onHandQuantity: true,
        reservedQuantity: true,
        lot: { select: { expiresOn: true, recallHold: true } },
      },
    }),
    tx.purchaseOrderLine.findMany({
      where: {
        organizationId: ctx.organizationId,
        productId: { in: productIds },
        purchaseOrder: { warehouseId: wh.id, status: { in: [...OPEN_STATUSES] } },
      },
      select: { productId: true, quantityBase: true, receivedQuantityBase: true },
    }),
  ]);
  const available = new Map<string, Decimal>();
  for (const b of balances) {
    const lot = b.lot;
    if (
      lot &&
      (lot.recallHold || isExpired(lot.expiresOn?.toISOString().slice(0, 10) ?? null, today))
    )
      continue;
    available.set(
      b.productId,
      (available.get(b.productId) ?? new Decimal(0)).plus(
        dec(b.onHandQuantity).minus(dec(b.reservedQuantity)),
      ),
    );
  }
  const onOrder = new Map<string, Decimal>();
  for (const l of openLines) {
    const open = Decimal.max(dec(l.quantityBase).minus(dec(l.receivedQuantityBase)), 0);
    onOrder.set(l.productId, (onOrder.get(l.productId) ?? new Decimal(0)).plus(open));
  }

  const lines = [];
  for (const r of rules) {
    const links = r.product.supplierProducts;
    // The preferred supplier, or the only one; otherwise the buyer chooses.
    const source = links.find((l) => l.preferred) ?? (links.length === 1 ? links[0] : null);
    const availableBase = available.get(r.productId) ?? new Decimal(0);
    const onOrderBase = onOrder.get(r.productId) ?? new Decimal(0);
    let suggestion = null;
    let reason: "OK" | "NO_SUPPLIER" | "NO_PRICE" | null = null;
    const factorSource = source?.purchaseUom.id;
    const product = await findProduct(tx, ctx, r.productId);
    const basePerUnit = factorSource
      ? await quantityInBaseUnit(tx, ctx, product, factorSource, "1")
      : new Decimal(1);
    suggestion = suggestReorder({
      minBase: dec(r.minQuantityBase),
      maxBase: dec(r.maxQuantityBase),
      availableBase,
      onOrderBase,
      basePerPurchaseUnit: basePerUnit,
      minOrderPurchaseUnits: source?.minOrderQuantity ? dec(source.minOrderQuantity) : null,
    });
    if (suggestion)
      reason = !source ? "NO_SUPPLIER" : source.lastUnitPrice === null ? "NO_PRICE" : "OK";
    lines.push({ rule: r, source, availableBase, onOrderBase, suggestion, reason });
  }
  return { warehouse: wh, today, lines };
}

export async function reorderPlan(ctx: TenantContext, warehouseId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await buildPlan(tx, ctx, warehouseId);
    return {
      ...plan,
      canManage: canOnWarehouse(ctx, "purchasing.manage", plan.warehouse),
    };
  });
}

/**
 * Create one draft order per supplier from the selected suggestions, priced
 * at each supplier's last price. Lines without a supplier or a known price
 * are skipped (never priced by guess) and reported back.
 */
export async function createOrdersFromPlan(
  ctx: TenantContext,
  warehouseId: string,
  ruleIds: string[],
) {
  if (ruleIds.length === 0)
    throw businessRuleViolation("NOTHING_SELECTED", "Select at least one suggestion");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const plan = await buildPlan(tx, ctx, warehouseId);
    assertPermission(ctx.grants, "purchasing.manage", {
      branchId: plan.warehouse.branchId,
      warehouseId: plan.warehouse.id,
    });
    const selected = plan.lines.filter((l) => ruleIds.includes(l.rule.id) && l.suggestion);
    const bySupplier = new Map<string, typeof selected>();
    const skipped: string[] = [];
    for (const l of selected) {
      if (l.reason !== "OK" || !l.source) {
        skipped.push(l.rule.product.sku);
        continue;
      }
      const list = bySupplier.get(l.source.supplier.id) ?? [];
      list.push(l);
      bySupplier.set(l.source.supplier.id, list);
    }
    const orders: Array<{ id: string; number: string }> = [];
    for (const [supplierId, list] of bySupplier) {
      const order = await createDraftOrderInTx(tx, ctx, {
        supplierId,
        warehouseId: plan.warehouse.id,
        note: "Created from reorder suggestions",
      });
      let lineNo = 0;
      for (const l of list) {
        await addDraftLineInTx(tx, ctx, order, ++lineNo, {
          productId: l.rule.productId,
          uomId: l.source!.purchaseUom.id,
          quantity: l.suggestion!.purchaseUnits.toFixed(),
          unitPrice: dec(l.source!.lastUnitPrice!).toFixed(),
        });
      }
      await recomputeTotal(tx, order.id);
      orders.push(order);
    }
    return { orders, skipped };
  });
}
