import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, holdsAnyGrant } from "@/modules/access/authorize";
import { currencyConverter, warehouseCurrencies } from "@/modules/fx/service";
import { costVersionsInTx } from "@/modules/recipes/costs";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { forbidden, validationFailed } from "@/server/errors";
import { classifyMenu, type MenuClass } from "./menu-rules";

/**
 * Menu engineering (DECISIONS.md ADR-107). What sold: POS lines of paid
 * orders, net of VAT and discounts, less refunded quantities. What it cost:
 * the standard cost of an item today — its recipe's active version per
 * portion (ADR-031, average cost at the selling warehouse) or its product's
 * average cost × quantity per item — priced in the selling warehouse's
 * currency, then both converted into the report currency at the period's
 * average rate. Combos and items without a known cost are listed but not
 * classified. Needs `sales.view` and `recipes.costs.view`.
 */

const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? "0");

const periodSchema = z
  .object({
    from: z.string().refine(isCalendarDate, { error: "invalidDate" }),
    to: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  })
  .refine((p) => p.from <= p.to, { error: "invalidPeriod", path: ["to"] });

export const canSeeMenuEngineering = (ctx: TenantContext) =>
  holdsAnyGrant(ctx.grants, "sales.view") && holdsAnyGrant(ctx.grants, "recipes.costs.view");

export type CostGap = "COMBO" | "NO_ACTIVE_RECIPE" | "NO_PRODUCT_COST" | null;

export async function menuEngineering(
  ctx: TenantContext,
  rawPeriod: unknown,
  filters: { companyId?: string; categoryId?: string } = {},
) {
  if (!canSeeMenuEngineering(ctx)) throw forbidden();
  const p = periodSchema.safeParse(rawPeriod);
  if (!p.success) throw validationFailed(p.error);
  const period = p.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const scope = accessibleScope(ctx.grants, "sales.view");
    const warehouses = await tx.warehouse.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(filters.companyId ? { branch: { companyId: filters.companyId } } : {}),
        ...(scope.all
          ? {}
          : { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }] }),
      },
      select: { id: true },
    });
    const ids = warehouses.map((w) => w.id);
    const currency =
      (filters.companyId
        ? (
            await tx.company.findFirst({
              where: { organizationId: ctx.organizationId, id: filters.companyId },
              select: { currency: true },
            })
          )?.currency
        : undefined) ?? ctx.groupCurrency;
    const conv = await currencyConverter(tx, ctx, {
      to: currency,
      date: period.to,
      from: period.from,
    });
    const rows = ids.length
      ? await tx.$queryRaw<
          Array<{
            warehouse_id: string;
            menu_item_id: string;
            sold: Prisma.Decimal;
            revenue: Prisma.Decimal;
          }>
        >`
          SELECT o.warehouse_id, l.menu_item_id,
                 SUM(l.quantity - l.refunded_quantity) AS sold,
                 SUM(CASE WHEN l.quantity > 0
                          THEN l.net_amount * (l.quantity - l.refunded_quantity) / l.quantity
                          ELSE 0 END) AS revenue
          FROM pos_order_lines l
          JOIN pos_orders o ON o.id = l.order_id
          WHERE o.organization_id = ${ctx.organizationId}::uuid
            AND o.status = 'PAID'
            AND o.warehouse_id = ANY(${ids}::uuid[])
            AND o.business_date BETWEEN ${period.from}::date AND ${period.to}::date
          GROUP BY o.warehouse_id, l.menu_item_id`
      : [];
    const menuItems = await tx.menuItem.findMany({
      where: {
        organizationId: ctx.organizationId,
        id: { in: [...new Set(rows.map((r) => r.menu_item_id))] },
        ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      },
      select: {
        id: true,
        code: true,
        name: true,
        nameAr: true,
        kind: true,
        recipeId: true,
        productId: true,
        productQuantity: true,
        category: { select: { id: true, name: true, nameAr: true } },
        recipe: {
          select: { versions: { where: { status: "ACTIVE" }, select: { id: true }, take: 1 } },
        },
      },
    });
    const itemOf = new Map(menuItems.map((m) => [m.id, m]));
    const currencies = await warehouseCurrencies(tx, ctx, ids);

    // Standard cost per item and selling warehouse, in that warehouse's currency.
    const unitCost = new Map<string, { cost: Decimal | null; incomplete: boolean; gap: CostGap }>();
    const byWarehouse = new Map<string, string[]>();
    for (const r of rows) {
      if (!itemOf.has(r.menu_item_id)) continue;
      byWarehouse.set(r.warehouse_id, [...(byWarehouse.get(r.warehouse_id) ?? []), r.menu_item_id]);
    }
    for (const [warehouseId, itemIds] of byWarehouse) {
      const items = itemIds.map((id) => itemOf.get(id)!);
      const versionIds = items.flatMap((m) =>
        m.recipe?.versions[0] ? [m.recipe.versions[0].id] : [],
      );
      const costs = versionIds.length
        ? await costVersionsInTx(tx, ctx, versionIds, { policy: "AVERAGE", warehouseId })
        : new Map();
      const valuations = await tx.stockValuation.findMany({
        where: {
          organizationId: ctx.organizationId,
          warehouseId,
          productId: { in: items.flatMap((m) => (m.productId ? [m.productId] : [])) },
        },
        select: { productId: true, averageUnitCost: true },
      });
      for (const m of items) {
        const key = `${warehouseId}|${m.id}`;
        if (m.kind === "COMBO") unitCost.set(key, { cost: null, incomplete: false, gap: "COMBO" });
        else if (m.recipeId) {
          const v = m.recipe?.versions[0] ? costs.get(m.recipe.versions[0].id) : undefined;
          unitCost.set(
            key,
            v
              ? {
                  cost: new Decimal(v.costPerPortion ?? v.totalCost),
                  incomplete: v.missingCount > 0,
                  gap: null,
                }
              : { cost: null, incomplete: false, gap: "NO_ACTIVE_RECIPE" },
          );
        } else {
          const avg = valuations.find((x) => x.productId === m.productId)?.averageUnitCost;
          unitCost.set(
            key,
            avg && m.productQuantity
              ? { cost: dec(avg).times(dec(m.productQuantity)), incomplete: false, gap: null }
              : { cost: null, incomplete: false, gap: "NO_PRODUCT_COST" },
          );
        }
      }
    }

    // Converted totals per item.
    const totals = new Map<
      string,
      { sold: Decimal; revenue: Decimal; cost: Decimal | null; incomplete: boolean; gap: CostGap }
    >();
    for (const r of rows) {
      if (!itemOf.has(r.menu_item_id)) continue;
      const sold = dec(r.sold);
      const from = currencies.get(r.warehouse_id)!;
      const revenue = await conv.convert(dec(r.revenue), from);
      if (revenue === null) continue;
      const uc = unitCost.get(`${r.warehouse_id}|${r.menu_item_id}`)!;
      const cost = uc.cost === null ? null : await conv.convert(uc.cost.times(sold), from);
      const t = totals.get(r.menu_item_id) ?? {
        sold: new Decimal(0),
        revenue: new Decimal(0),
        cost: new Decimal(0),
        incomplete: false,
        gap: null,
      };
      t.sold = t.sold.plus(sold);
      t.revenue = t.revenue.plus(revenue);
      t.cost = t.cost === null || cost === null ? null : t.cost.plus(cost);
      t.incomplete ||= uc.incomplete;
      t.gap ??= uc.gap;
      totals.set(r.menu_item_id, t);
    }
    const result = classifyMenu(
      [...totals].map(([id, t]) => ({ id, sold: t.sold, revenue: t.revenue, cost: t.cost })),
    );
    const order: Record<MenuClass, number> = { STAR: 0, PLOWHORSE: 1, PUZZLE: 2, DOG: 3 };
    const items = result.items
      .map((c) => {
        const m = itemOf.get(c.id)!;
        const t = totals.get(c.id)!;
        return {
          ...c,
          item: { id: m.id, code: m.code, name: m.name, nameAr: m.nameAr, kind: m.kind },
          category: m.category,
          costIncomplete: t.incomplete,
          costGap: t.gap,
        };
      })
      .sort(
        (a, b) =>
          (a.menuClass === null ? 9 : order[a.menuClass]) -
            (b.menuClass === null ? 9 : order[b.menuClass]) || b.revenue.comparedTo(a.revenue),
      );
    const counts = { STAR: 0, PLOWHORSE: 0, PUZZLE: 0, DOG: 0 } as Record<MenuClass, number>;
    for (const i of items) if (i.menuClass) counts[i.menuClass] += 1;
    const categories = await tx.menuCategory.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, name: true, nameAr: true },
      orderBy: { name: "asc" },
    });
    return {
      period,
      currency: conv.currency,
      missingRates: conv.missing(),
      popularityThreshold: result.popularityThreshold,
      averageMargin: result.averageMargin,
      counts,
      items,
      categories,
    };
  });
}

export async function exportMenuEngineeringCsv(
  ctx: TenantContext,
  rawPeriod: unknown,
  filters: { companyId?: string; categoryId?: string } = {},
) {
  const r = await menuEngineering(ctx, rawPeriod, filters);
  const f = (v: Decimal | null, d = 2) => (v === null ? "" : v.toFixed(d));
  return toCsv(
    [
      "code",
      "item",
      "category",
      "sold",
      `revenue (${r.currency})`,
      "average price",
      "unit cost",
      "unit margin",
      "total margin",
      "food cost %",
      "mix %",
      "class",
      "cost note",
    ],
    r.items.map((i) => [
      i.item.code,
      i.item.name,
      i.category.name,
      i.sold.toFixed(),
      f(i.revenue),
      f(i.averagePrice),
      f(i.unitCost),
      f(i.unitMargin),
      f(i.totalMargin),
      i.foodCost === null ? "" : i.foodCost.times(100).toFixed(1),
      i.mixShare === null ? "" : i.mixShare.times(100).toFixed(1),
      i.menuClass ?? "",
      i.costGap ?? (i.costIncomplete ? "INCOMPLETE" : ""),
    ]),
  );
}
