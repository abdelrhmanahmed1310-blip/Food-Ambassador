import "server-only";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, holdsAnyGrant } from "@/modules/access/authorize";
import { createOrdersFromPlan, reorderPlan } from "@/modules/procurement/reorder";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import type { Finding, ReplenishmentSettings } from "./rules";

/**
 * The replenishment agent (DECISIONS.md ADR-140): for each warehouse with
 * reorder rules it may order for, it reads the reorder plan — par levels or
 * the demand forecast — and, by its autonomy, either proposes the lines per
 * supplier (SUGGEST) or prepares draft purchase orders (DRAFT). Drafts go
 * through the normal approval chain only when a person approves the
 * proposal; nothing is sent to a supplier by the agent. Lines without a
 * supplier or a known price are reported, never priced by guess.
 */

export function canRunReplenishment(ctx: TenantContext) {
  return holdsAnyGrant(ctx.grants, "purchasing.manage");
}

export interface NewProposal {
  kind: "PURCHASE_ORDER" | "REORDER";
  title: string;
  detail: Record<string, unknown>;
  warehouseId: string;
  entityType?: string;
  entityId?: string;
}

async function warehousesInScope(ctx: TenantContext, s: ReplenishmentSettings) {
  const scope = accessibleScope(ctx.grants, "purchasing.manage");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.warehouse.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        reorderRules: { some: {} },
        ...(s.warehouseIds.length ? { id: { in: s.warehouseIds } } : {}),
        ...(scope.all
          ? {}
          : { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }] }),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  );
}

async function orderSummaryInTx(tx: Tx, ctx: TenantContext, orderId: string) {
  const o = await tx.purchaseOrder.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, id: orderId },
    select: {
      number: true,
      currency: true,
      totalAmount: true,
      supplier: { select: { code: true, name: true } },
      _count: { select: { lines: true } },
    },
  });
  return {
    orderNumber: o.number,
    supplier: o.supplier.name,
    supplierCode: o.supplier.code,
    lines: o._count.lines,
    total: new Decimal(o.totalAmount.toString()).toFixed(2),
    currency: o.currency,
  };
}

export async function runReplenishment(
  ctx: TenantContext,
  settings: ReplenishmentSettings,
  autonomy: "SUGGEST" | "DRAFT",
  count: () => void,
) {
  const warehouses = await warehousesInScope(ctx, settings);
  count();
  const findings: Finding[] = [];
  const proposals: NewProposal[] = [];
  let candidateLines = 0;
  for (const wh of warehouses) {
    const plan = await reorderPlan(ctx, wh.id);
    count();
    if (!plan.canManage) continue;
    const quantity = (l: (typeof plan.lines)[number]) =>
      settings.basis === "FORECAST"
        ? (l.forecast.order?.purchaseUnits ?? null)
        : (l.suggestion?.purchaseUnits ?? null);
    const ready = plan.lines.filter(
      (l) => quantity(l) && l.source && l.source.lastUnitPrice !== null,
    );
    for (const l of plan.lines)
      if (quantity(l) && (!l.source || l.source.lastUnitPrice === null))
        findings.push({
          severity: "WARNING",
          code: !l.source ? "NO_SUPPLIER" : "NO_PRICE",
          params: { warehouse: wh.code, sku: l.rule.product.sku },
          link: "purchasing/reorder",
        });
    if (ready.length === 0) continue;
    candidateLines += ready.length;
    if (autonomy === "DRAFT") {
      const r = await createOrdersFromPlan(
        ctx,
        wh.id,
        ready.map((l) => l.rule.id),
        settings.basis,
      );
      count();
      for (const o of r.orders) {
        const detail = await withTenantTx(ctx.organizationId, (tx) =>
          orderSummaryInTx(tx, ctx, o.id),
        );
        proposals.push({
          kind: "PURCHASE_ORDER",
          title: `${detail.orderNumber} · ${detail.supplier}`,
          detail: { ...detail, warehouse: wh.code, basis: settings.basis },
          warehouseId: wh.id,
          entityType: "purchase_order",
          entityId: o.id,
        });
      }
    } else {
      // One proposal per supplier, nothing created until a person approves.
      const bySupplier = new Map<string, typeof ready>();
      for (const l of ready) {
        const key = l.source!.supplier.id;
        bySupplier.set(key, [...(bySupplier.get(key) ?? []), l]);
      }
      for (const lines of bySupplier.values()) {
        const supplier = lines[0].source!.supplier;
        const total = lines.reduce(
          (a, l) =>
            a.plus(new Decimal(quantity(l)!.toString()).times(l.source!.lastUnitPrice!.toString())),
          new Decimal(0),
        );
        proposals.push({
          kind: "REORDER",
          title: `${wh.code} · ${supplier.name}`,
          detail: {
            warehouse: wh.code,
            supplier: supplier.name,
            basis: settings.basis,
            ruleIds: lines.map((l) => l.rule.id),
            total: total.toFixed(2),
            lines: lines.map((l) => ({
              sku: l.rule.product.sku,
              name: l.rule.product.nameEn,
              quantity: quantity(l)!.toString(),
              unit: l.source!.purchaseUom.code,
              price: l.source!.lastUnitPrice!.toString(),
            })),
          },
          warehouseId: wh.id,
        });
      }
    }
  }
  return {
    summary: {
      warehouses: warehouses.length,
      lines: candidateLines,
      proposals: proposals.length,
      drafts: proposals.filter((p) => p.kind === "PURCHASE_ORDER").length,
    },
    findings,
    proposals,
  };
}
