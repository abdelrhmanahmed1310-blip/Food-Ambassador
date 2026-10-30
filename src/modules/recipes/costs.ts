import "server-only";
import { Decimal, roundUnitCost } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { findProduct, loadUnits, toUnitDef } from "@/modules/catalog/service";
import { businessDate } from "@/modules/inventory/rules";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { conflict, notFound, validationFailed } from "@/server/errors";
import {
  costVersion,
  type CostPolicy,
  type CostWorld,
  type ProductInfo,
  type VersionCost,
  type VersionInput,
} from "./costing";
import { costQuerySchema, standardCostSchema } from "./schemas";

/**
 * Cost sources and snapshots (DECISIONS.md ADR-031). Per product, per base
 * unit:
 * - AVERAGE — stock value ÷ quantity over stock on hand that has a known cost
 *   (one warehouse, or the whole organization);
 * - LAST_PURCHASE — price on the latest posted goods receipt;
 * - STANDARD — the latest standard cost effective on the date.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());

type Units = Awaited<ReturnType<typeof loadUnits>>;

function unitDef(units: Units, id: string) {
  const u = units.find((x) => x.id === id);
  if (!u) throw new Error(`Unit ${id} not loaded`);
  return toUnitDef(u);
}

async function versionInputs(tx: Tx, ctx: TenantContext, ids: string[], units: Units) {
  const versions = await tx.recipeVersion.findMany({
    where: { organizationId: ctx.organizationId, id: { in: ids } },
    include: {
      recipe: { select: { id: true, code: true } },
      ingredients: { orderBy: { lineNo: "asc" } },
    },
  });
  return versions.map((v): VersionInput => ({
    id: v.id,
    recipeId: v.recipeId,
    recipeCode: v.recipe.code,
    yieldQuantity: dec(v.yieldQuantity),
    yieldUom: unitDef(units, v.yieldUomId),
    portions: v.portions === null ? null : dec(v.portions),
    ingredients: v.ingredients.map((i) => ({
      id: i.id,
      lineNo: i.lineNo,
      productId: i.productId,
      subRecipeId: i.subRecipeId,
      quantity: dec(i.quantity),
      uom: unitDef(units, i.uomId),
      wasteFraction: dec(i.wasteFraction),
    })),
  }));
}

/** Product costs for each policy (only those that exist). */
async function productCosts(
  tx: Tx,
  ctx: TenantContext,
  productIds: string[],
  options: { warehouseId?: string; asOf: string },
) {
  const costs = new Map<string, ProductInfo["costs"]>(productIds.map((id) => [id, {}]));
  if (productIds.length === 0) return costs;
  const averages = await tx.stockValuation.groupBy({
    by: ["productId"],
    where: {
      organizationId: ctx.organizationId,
      productId: { in: productIds },
      quantity: { gt: 0 },
      costMissing: false,
      ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
    },
    _sum: { quantity: true, totalValue: true },
  });
  for (const a of averages) {
    const qty = dec(a._sum.quantity ?? 0);
    if (!qty.gt(0)) continue;
    (costs.get(a.productId) as ProductInfo["costs"]).AVERAGE = {
      unitCost: roundUnitCost(dec(a._sum.totalValue ?? 0).dividedBy(qty)),
      ref: options.warehouseId ?? "ORGANIZATION",
    };
  }
  const purchases = await tx.$queryRaw<
    Array<{ product_id: string; unit_cost: string; number: string }>
  >`
    SELECT DISTINCT ON (l."product_id") l."product_id",
           (l."accepted_quantity" * l."unit_price" / l."accepted_quantity_base")::text AS unit_cost,
           r."number"
    FROM "goods_receipt_lines" l
    JOIN "goods_receipts" r ON r."organization_id" = l."organization_id" AND r."id" = l."receipt_id"
    WHERE l."organization_id" = ${ctx.organizationId}::uuid
      AND l."product_id" = ANY(${productIds}::uuid[])
      AND r."status" = 'POSTED' AND l."accepted_quantity_base" > 0
    ORDER BY l."product_id", r."received_at" DESC, r."id" DESC`;
  for (const p of purchases)
    (costs.get(p.product_id) as ProductInfo["costs"]).LAST_PURCHASE = {
      unitCost: roundUnitCost(new Decimal(p.unit_cost)),
      ref: p.number,
    };
  const standards = await tx.$queryRaw<
    Array<{ product_id: string; unit_cost: string; id: string }>
  >`
    SELECT DISTINCT ON ("product_id") "product_id", "unit_cost"::text, "id"
    FROM "product_standard_costs"
    WHERE "organization_id" = ${ctx.organizationId}::uuid
      AND "product_id" = ANY(${productIds}::uuid[])
      AND "effective_from" <= ${options.asOf}::date
    ORDER BY "product_id", "effective_from" DESC`;
  for (const s of standards)
    (costs.get(s.product_id) as ProductInfo["costs"]).STANDARD = {
      unitCost: new Decimal(s.unit_cost),
      ref: s.id,
    };
  return costs;
}

/** Load the version, every active sub-recipe version it reaches, and their products' costs. */
async function loadWorld(
  tx: Tx,
  ctx: TenantContext,
  versionId: string,
  options: { warehouseId?: string; asOf: string },
): Promise<{ root: VersionInput; world: CostWorld }> {
  const units = await loadUnits(tx, ctx, true);
  const [root] = await versionInputs(tx, ctx, [versionId], units);
  if (!root) throw notFound("Recipe version");
  const activeVersions = new Map<string, VersionInput>();
  const productIds = new Set<string>();
  let frontier = [root];
  const seen = new Set([root.recipeId]);
  while (frontier.length > 0) {
    const subIds = new Set<string>();
    for (const v of frontier)
      for (const i of v.ingredients) {
        if (i.productId) productIds.add(i.productId);
        if (i.subRecipeId && !seen.has(i.subRecipeId)) subIds.add(i.subRecipeId);
      }
    if (subIds.size === 0) break;
    const active = await tx.recipeVersion.findMany({
      where: {
        organizationId: ctx.organizationId,
        recipeId: { in: [...subIds] },
        status: "ACTIVE",
      },
      select: { id: true },
    });
    frontier = await versionInputs(
      tx,
      ctx,
      active.map((a) => a.id),
      units,
    );
    for (const v of frontier) {
      activeVersions.set(v.recipeId, v);
      seen.add(v.recipeId);
    }
    for (const id of subIds) seen.add(id);
  }
  const ids = [...productIds];
  const costs = await productCosts(tx, ctx, ids, options);
  const products = await tx.product.findMany({
    where: { organizationId: ctx.organizationId, id: { in: ids } },
    select: {
      id: true,
      sku: true,
      baseUomId: true,
      conversions: { select: { uomId: true, factorToBase: true } },
    },
  });
  return {
    root,
    world: {
      activeVersions,
      products: new Map(
        products.map((p) => [
          p.id,
          {
            id: p.id,
            sku: p.sku,
            base: unitDef(units, p.baseUomId),
            conversions: p.conversions.map((c) => ({
              uomId: c.uomId,
              factorToBase: c.factorToBase.toString(),
            })),
            costs: costs.get(p.id) ?? {},
          },
        ]),
      ),
    },
  };
}

async function warehouseFor(tx: Tx, ctx: TenantContext, warehouseId: string | undefined) {
  if (!warehouseId) return undefined;
  const wh = await tx.warehouse.findFirst({
    where: { organizationId: ctx.organizationId, id: warehouseId },
    select: { id: true },
  });
  if (!wh) throw notFound("Warehouse");
  return wh.id;
}

/** Names of the products and recipes a cost breakdown refers to (also inside sub-recipes). */
async function breakdownNames(tx: Tx, ctx: TenantContext, cost: VersionCost) {
  const productIds = new Set<string>();
  const recipeIds = new Set<string>();
  const walk = (c: VersionCost) => {
    for (const l of c.lines) {
      if (l.productId) productIds.add(l.productId);
      if (l.subRecipeId) recipeIds.add(l.subRecipeId);
      if (l.sub) walk(l.sub);
    }
  };
  walk(cost);
  const [products, recipes] = [
    await tx.product.findMany({
      where: { organizationId: ctx.organizationId, id: { in: [...productIds] } },
      select: { id: true, sku: true, nameEn: true, nameAr: true },
    }),
    await tx.recipe.findMany({
      where: { organizationId: ctx.organizationId, id: { in: [...recipeIds] } },
      select: { id: true, code: true, name: true, nameAr: true },
    }),
  ];
  const names: Record<string, { code: string; name: string; nameAr: string | null }> = {};
  for (const p of products) names[p.id] = { code: p.sku, name: p.nameEn, nameAr: p.nameAr };
  for (const r of recipes) names[r.id] = { code: r.code, name: r.name, nameAr: r.nameAr };
  return names;
}

/** Live cost of a version (not stored). */
export async function calculateVersionCost(
  ctx: TenantContext,
  versionId: string,
  rawQuery: unknown,
) {
  assertPermission(ctx.grants, "recipes.costs.view");
  const query = costQuerySchema.parse(rawQuery ?? {});
  return withTenantTx(ctx.organizationId, async (tx) => {
    const warehouseId = await warehouseFor(tx, ctx, query.warehouseId);
    const asOf = businessDate(ctx.timeZone);
    const { root, world } = await loadWorld(tx, ctx, versionId, { warehouseId, asOf });
    const cost = costVersion(root, world, query.policy);
    return { ...query, warehouseId, asOf, cost, names: await breakdownNames(tx, ctx, cost) };
  });
}

/** Compute and store a snapshot in the caller's transaction. */
export async function snapshotInTx(
  tx: Tx,
  ctx: TenantContext,
  versionId: string,
  input: { reason: "ACTIVATION" | "MANUAL"; policy: CostPolicy; warehouseId: string | undefined },
) {
  const warehouseId = await warehouseFor(tx, ctx, input.warehouseId);
  const asOf = businessDate(ctx.timeZone);
  const { root, world } = await loadWorld(tx, ctx, versionId, { warehouseId, asOf });
  const cost = costVersion(root, world, input.policy);
  return tx.recipeCostSnapshot.create({
    data: {
      organizationId: ctx.organizationId,
      versionId,
      reason: input.reason,
      policy: input.policy,
      warehouseId: warehouseId ?? null,
      asOf: new Date(`${asOf}T00:00:00Z`),
      totalCost: cost.totalCost,
      costPerPortion: cost.costPerPortion,
      costPerYieldUnit: cost.costPerYieldUnit,
      missingCount: cost.missingCount,
      breakdown: cost as unknown as object,
      calculatedByUserId: ctx.userId,
    },
    select: { id: true, totalCost: true, costPerPortion: true, missingCount: true },
  });
}

export async function saveSnapshot(ctx: TenantContext, versionId: string, rawQuery: unknown) {
  assertPermission(ctx.grants, "recipes.costs.view");
  const query = costQuerySchema.parse(rawQuery ?? {});
  return withTenantTx(ctx.organizationId, async (tx) => {
    const version = await tx.recipeVersion.findFirst({
      where: { organizationId: ctx.organizationId, id: versionId },
      select: { id: true, versionNo: true, recipe: { select: { id: true, code: true } } },
    });
    if (!version) throw notFound("Recipe version");
    const snapshot = await snapshotInTx(tx, ctx, version.id, { reason: "MANUAL", ...query });
    await recordAudit(tx, actorOf(ctx), {
      action: "recipe.cost_snapshot",
      entityType: "recipe",
      entityId: version.recipe.id,
      changes: {
        code: version.recipe.code,
        versionNo: version.versionNo,
        snapshotId: snapshot.id,
        policy: query.policy,
        totalCost: snapshot.totalCost.toFixed(),
      },
    });
    return snapshot;
  });
}

/** Cost history of a recipe: every stored snapshot of any of its versions, newest first. */
export async function listSnapshots(ctx: TenantContext, recipeId: string) {
  assertPermission(ctx.grants, "recipes.costs.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.recipeCostSnapshot.findMany({
      where: { organizationId: ctx.organizationId, version: { recipeId } },
      select: {
        id: true,
        reason: true,
        policy: true,
        asOf: true,
        totalCost: true,
        costPerPortion: true,
        costPerYieldUnit: true,
        missingCount: true,
        calculatedAt: true,
        warehouse: { select: { code: true } },
        version: { select: { id: true, versionNo: true, yieldUom: { select: { code: true } } } },
      },
      orderBy: { calculatedAt: "desc" },
      take: 100,
    }),
  );
}

/** A stored snapshot with its breakdown, exactly as calculated. */
export async function getSnapshot(ctx: TenantContext, snapshotId: string) {
  assertPermission(ctx.grants, "recipes.costs.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const snapshot = await tx.recipeCostSnapshot.findFirst({
      where: { organizationId: ctx.organizationId, id: snapshotId },
      include: {
        warehouse: { select: { code: true } },
        version: {
          select: {
            id: true,
            versionNo: true,
            recipe: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });
    if (!snapshot) throw notFound("Cost snapshot");
    const breakdown = snapshot.breakdown as unknown as VersionCost;
    return { ...snapshot, breakdown, names: await breakdownNames(tx, ctx, breakdown) };
  });
}

// ─── Standard costs ───

export async function addStandardCost(ctx: TenantContext, productId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "recipes.manage");
  assertPermission(ctx.grants, "recipes.costs.view");
  const parsed = standardCostSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  try {
    return await runIdempotent(
      ctx,
      { key: idempotencyKey, operation: "recipe.standard_cost", input: { productId, ...input } },
      async (tx) => {
        const product = await findProduct(tx, ctx, productId);
        const row = await tx.productStandardCost.create({
          data: {
            organizationId: ctx.organizationId,
            productId: product.id,
            unitCost: input.unitCost,
            effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`),
            note: input.note,
            createdByUserId: ctx.userId,
          },
          select: { id: true },
        });
        await recordAudit(tx, actorOf(ctx), {
          action: "product.standard_cost_added",
          entityType: "product",
          entityId: product.id,
          changes: { sku: product.sku, ...input },
        });
        return row;
      },
    );
  } catch (error) {
    if (isUniqueViolation(error, "product_standard_costs_organization_id_product_id_effective_key"))
      throw conflict("A standard cost already starts on this date", {
        reason: "duplicate",
        field: "effectiveFrom",
      });
    throw error;
  }
}

export async function listStandardCosts(ctx: TenantContext, productId: string) {
  assertPermission(ctx.grants, "recipes.costs.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.productStandardCost.findMany({
      where: { organizationId: ctx.organizationId, productId },
      select: { id: true, unitCost: true, effectiveFrom: true, note: true, createdAt: true },
      orderBy: { effectiveFrom: "desc" },
      take: 50,
    }),
  );
}

/** Active warehouses whose stock average can cost a recipe. */
export async function costWarehouseOptions(ctx: TenantContext) {
  assertPermission(ctx.grants, "recipes.costs.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.warehouse.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  );
}
