import "server-only";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString, toDecimal } from "@/lib/decimal";
import { uuidv7 } from "@/lib/uuid";
import {
  accessibleScope,
  assertPermission,
  hasPermission,
  holdsAnyGrant,
} from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { quantityInBaseUnit } from "@/modules/catalog/service";
import { planConsumptionInTx } from "@/modules/inventory/consumption";
import {
  assertActive,
  assertWarehousePermission,
  loadProductForPosting,
  loadWarehouse,
  resolveInboundLot,
  todayFor,
} from "@/modules/inventory/context";
import { reverseDocumentInTx } from "@/modules/inventory/operations";
import { nextDocumentNumber, postDocument, type PostingLine } from "@/modules/inventory/posting";
import { addDays } from "@/modules/inventory/rules";
import { loadRecipeStructureInTx } from "@/modules/recipes/costs";
import { explodeRecipe } from "@/modules/recipes/explode";
import { runIdempotent } from "@/modules/shared/idempotency";
import {
  idempotencyKeySchema,
  optionalText,
  optionalUuidSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, forbidden, notFound, validationFailed } from "@/server/errors";

/**
 * Central kitchen production (DECISIONS.md ADR-045). A production order
 * makes a batch of a PREPARATION recipe in one warehouse: the ingredients
 * of the planned quantity (gross, with waste) are taken FEFO from available
 * stock, and the recipe's output product enters stock as a lot carrying
 * exactly their value. Nothing is produced from stock that is not there.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const optionalDate = z
  .string()
  .optional()
  .transform(blank)
  .refine((v) => v === undefined || isCalendarDate(v), { error: "invalidDate" });

const createSchema = z.object({
  recipeId: uuidSchema,
  warehouseId: uuidSchema,
  plannedQuantity: decimalString({ maxScale: 6, min: "0.000001" }),
  plannedFor: optionalDate,
  note: optionalText(500),
  idempotencyKey: idempotencyKeySchema,
});

const completeSchema = z.object({
  /** Actual output in the recipe's yield unit; empty = as planned. */
  producedQuantity: z
    .string()
    .optional()
    .transform(blank)
    .pipe(decimalString({ maxScale: 6, min: "0.000001" }).optional()),
  lotCode: z
    .string()
    .optional()
    .transform((v) => blank(v)?.toUpperCase())
    .refine((v) => v === undefined || /^[A-Z0-9][A-Z0-9._/-]{0,39}$/.test(v), {
      error: "invalidLotCode",
    }),
  expiresOn: optionalDate,
  idempotencyKey: idempotencyKeySchema,
});

const reasonSchema = z.object({ reason: requiredText(500) });

async function audit(
  tx: Tx,
  ctx: TenantContext,
  order: { id: string; number: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `production_order.${action}`,
    entityType: "production_order",
    entityId: order.id,
    changes: { number: order.number, ...changes },
  });
}

// ─── Recipe output ───

/** Set the stock item a preparation produces (or clear it). Needs `recipes.manage`. */
export async function setRecipeOutputProduct(
  ctx: TenantContext,
  recipeId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "recipes.manage");
  const parsed = z.object({ productId: optionalUuidSchema }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const productId = parsed.data.productId ?? null;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const recipe = await tx.recipe.findFirst({
      where: { organizationId: ctx.organizationId, id: recipeId },
    });
    if (!recipe) throw notFound("Recipe");
    if (recipe.type !== "PREPARATION")
      throw businessRuleViolation(
        "OUTPUT_ONLY_FOR_PREPARATIONS",
        "Only preparations are produced into stock",
        { field: "productId" },
      );
    if (productId) {
      const product = await tx.product.findFirst({
        where: { organizationId: ctx.organizationId, id: productId, archivedAt: null },
        select: { id: true },
      });
      if (!product) throw notFound("Product");
      // The yield must be convertible into the product's stock unit.
      const active = await tx.recipeVersion.findFirst({
        where: { organizationId: ctx.organizationId, recipeId, status: "ACTIVE" },
        select: { yieldUomId: true },
      });
      if (active)
        await quantityInBaseUnit(
          tx,
          ctx,
          await loadProductForPosting(tx, ctx, productId),
          active.yieldUomId,
          "1",
        );
    }
    await tx.recipe.update({ where: { id: recipe.id }, data: { outputProductId: productId } });
    await recordAudit(tx, actorOf(ctx), {
      action: "recipe.output_product_set",
      entityType: "recipe",
      entityId: recipe.id,
      changes: { outputProductId: { from: recipe.outputProductId, to: productId } },
    });
  });
}

// ─── Orders ───

export async function createProductionOrder(ctx: TenantContext, rawInput: unknown) {
  const parsed = createSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "production_order.create", input },
    async (tx) => {
      const wh = await loadWarehouse(tx, ctx, input.warehouseId);
      assertWarehousePermission(ctx, "production.manage", wh);
      assertActive(wh);
      const recipe = await tx.recipe.findFirst({
        where: { organizationId: ctx.organizationId, id: input.recipeId, archivedAt: null },
        select: { id: true, code: true, outputProductId: true },
      });
      if (!recipe) throw notFound("Recipe");
      if (!recipe.outputProductId)
        throw businessRuleViolation(
          "RECIPE_HAS_NO_OUTPUT",
          "Set the product this preparation produces first",
          { field: "recipeId" },
        );
      const active = await tx.recipeVersion.findFirst({
        where: { organizationId: ctx.organizationId, recipeId: recipe.id, status: "ACTIVE" },
        select: { id: true, yieldUomId: true },
      });
      if (!active)
        throw businessRuleViolation("NO_ACTIVE_VERSION", "The recipe has no active version", {
          field: "recipeId",
        });
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "PRD",
        Number(todayFor(wh).slice(0, 4)),
      );
      const order = await tx.productionOrder.create({
        data: {
          organizationId: ctx.organizationId,
          number,
          recipeId: recipe.id,
          versionId: active.id,
          warehouseId: wh.id,
          outputProductId: recipe.outputProductId,
          plannedQuantity: input.plannedQuantity,
          plannedUomId: active.yieldUomId,
          plannedFor: input.plannedFor ? new Date(`${input.plannedFor}T00:00:00Z`) : null,
          note: input.note,
          createdByUserId: ctx.userId,
        },
        select: { id: true, number: true },
      });
      await audit(tx, ctx, order, "created", {
        recipe: recipe.code,
        warehouseId: wh.id,
        plannedQuantity: input.plannedQuantity,
      });
      return order;
    },
  );
}

async function lockOrder(tx: Tx, ctx: TenantContext, orderId: string) {
  const found = await tx.productionOrder.findFirst({
    where: { organizationId: ctx.organizationId, id: orderId },
    select: { id: true },
  });
  if (!found) throw notFound("Production order");
  await tx.$executeRaw`SELECT 1 FROM "production_orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  const order = await tx.productionOrder.findFirstOrThrow({ where: { id: orderId } });
  const wh = await loadWarehouse(tx, ctx, order.warehouseId);
  assertWarehousePermission(ctx, "production.manage", wh);
  return { order, wh };
}

/** What a batch of `plannedQuantity` uses (gross, in base units), and why it cannot be expanded. */
async function ingredientsFor(
  tx: Tx,
  ctx: TenantContext,
  versionId: string,
  plannedQuantity: Decimal,
) {
  const s = (await loadRecipeStructureInTx(tx, ctx, [versionId])).get(versionId);
  if (!s) throw notFound("Recipe version");
  return explodeRecipe(s.root, s.world, plannedQuantity, false);
}

/**
 * Record the batch as made: consume ingredients FEFO, put the output into
 * stock as a lot. The output's expiry may not be later than the earliest
 * expiry of a lot it was made from.
 */
export async function completeProduction(ctx: TenantContext, orderId: string, rawInput: unknown) {
  const parsed = completeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: `production_order.complete:${orderId}`, input },
    async (tx) => {
      const { order, wh } = await lockOrder(tx, ctx, orderId);
      if (order.status !== "PLANNED")
        throw businessRuleViolation(
          "PRODUCTION_NOT_PLANNED",
          "Only planned orders can be completed",
          { status: order.status },
        );
      assertActive(wh);
      const planned = dec(order.plannedQuantity);
      const exploded = await ingredientsFor(tx, ctx, order.versionId, planned);
      if (exploded.problems.length > 0)
        throw businessRuleViolation(
          "RECIPE_NOT_EXPANDABLE",
          "Part of the recipe cannot be expanded",
          {
            problem: exploded.problems[0].kind,
          },
        );
      if (exploded.usage.size === 0)
        throw businessRuleViolation("RECIPE_HAS_NO_INGREDIENTS", "The recipe has no ingredients");
      const plan = await planConsumptionInTx(tx, ctx, wh, exploded.usage);
      if (plan.shortages.length > 0) {
        const products = await tx.product.findMany({
          where: {
            organizationId: ctx.organizationId,
            id: { in: plan.shortages.map((s) => s.productId) },
          },
          select: { id: true, sku: true },
        });
        throw businessRuleViolation(
          "INSUFFICIENT_STOCK_FOR_PRODUCTION",
          "Not enough usable stock for the ingredients",
          {
            products: plan.shortages
              .map(
                (s) =>
                  `${products.find((p) => p.id === s.productId)?.sku}: ${s.available.toFixed()} / ${s.required.toFixed()}`,
              )
              .join(", "),
          },
        );
      }
      const product = await loadProductForPosting(tx, ctx, order.outputProductId);
      const producedInYield = input.producedQuantity ? toDecimal(input.producedQuantity) : planned;
      const producedBase = await quantityInBaseUnit(
        tx,
        ctx,
        product,
        order.plannedUomId,
        producedInYield.toFixed(),
      );
      const today = todayFor(wh);
      // Earliest expiry among the lots used; the output may not outlive it.
      const lotIds = plan.picks.map((p) => p.lotId).filter((v): v is string => !!v);
      const inputLots = await tx.inventoryLot.findMany({
        where: { organizationId: ctx.organizationId, id: { in: lotIds } },
        select: { expiresOn: true },
      });
      const earliest = inputLots
        .map((l) => l.expiresOn?.toISOString().slice(0, 10))
        .filter((v): v is string => !!v)
        .sort()[0];
      const expiresOn =
        input.expiresOn ??
        (product.lotTracking === "LOT_AND_EXPIRY" && product.shelfLifeDays
          ? [addDays(today, product.shelfLifeDays), earliest]
              .filter((v): v is string => !!v)
              .sort()[0]
          : undefined);
      if (expiresOn && earliest && expiresOn > earliest)
        throw businessRuleViolation(
          "OUTPUT_OUTLIVES_INPUT",
          "The batch cannot expire after an ingredient it was made from",
          {
            field: "expiresOn",
            latest: earliest,
          },
        );
      const lot = await resolveInboundLot(tx, ctx, product, {
        lotCode: product.lotTracking === "NONE" ? undefined : (input.lotCode ?? order.number),
        expiresOn: product.lotTracking === "NONE" ? undefined : expiresOn,
      });
      const id = uuidv7();
      const lines: PostingLine[] = plan.picks.map((p, i) => ({
        movementType: "CONSUMPTION",
        warehouseId: wh.id,
        locationId: p.locationId,
        productId: p.productId,
        lotId: p.lotId,
        stockStatus: "AVAILABLE",
        quantityDelta: p.quantity.negated(),
        enteredQuantity: p.quantity.negated(),
        enteredUomId: p.uomId,
        reasonCode: "PRODUCTION",
        postingKey: `production:${id}:in:${i + 1}`,
      }));
      lines.push({
        movementType: "PRODUCTION_OUTPUT",
        warehouseId: wh.id,
        locationId: null,
        productId: product.id,
        lotId: lot?.id ?? null,
        stockStatus: "AVAILABLE",
        quantityDelta: producedBase,
        enteredQuantity: producedInYield,
        enteredUomId: order.plannedUomId,
        costFromLines: plan.picks.map((_, i) => i),
        reasonCode: "PRODUCTION",
        postingKey: `production:${id}:out`,
      });
      const posted = await postDocument(
        tx,
        ctx,
        {
          id,
          type: "PRODUCTION",
          warehouseId: wh.id,
          reasonCode: "PRODUCTION",
          note: order.number,
        },
        lines,
        { year: Number(today.slice(0, 4)), auditChanges: { productionOrder: order.number } },
      );
      const value = await tx.inventoryLedgerEntry.aggregate({
        where: {
          organizationId: ctx.organizationId,
          documentId: posted.documentId,
          quantityDelta: { gt: 0 },
        },
        _sum: { valueDelta: true },
      });
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          status: "COMPLETED",
          producedQuantityBase: producedBase.toFixed(),
          outputLotId: lot?.id ?? null,
          cost: dec(value._sum.valueDelta ?? 0).toFixed(),
          documentId: posted.documentId,
          completedAt: new Date(),
          completedByUserId: ctx.userId,
        },
      });
      await audit(tx, ctx, order, "completed", {
        producedQuantityBase: producedBase.toFixed(),
        lot: lot?.lotCode ?? null,
        document: posted.number,
      });
      return { id: order.id, documentNumber: posted.number };
    },
  );
}

export async function cancelProductionOrder(
  ctx: TenantContext,
  orderId: string,
  rawInput: unknown,
) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { order } = await lockOrder(tx, ctx, orderId);
    if (order.status !== "PLANNED")
      throw businessRuleViolation(
        "PRODUCTION_NOT_PLANNED",
        "Only planned orders can be cancelled",
        { status: order.status },
      );
    await tx.productionOrder.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
        closedAt: new Date(),
        closedByUserId: ctx.userId,
        closeReason: parsed.data.reason,
      },
    });
    await audit(tx, ctx, order, "cancelled", { reason: parsed.data.reason });
  });
}

/** Undo a completed batch: ingredients back, output out — only while the output is all still there. */
export async function reverseProduction(ctx: TenantContext, orderId: string, rawInput: unknown) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { order } = await lockOrder(tx, ctx, orderId);
    if (order.status !== "COMPLETED" || !order.documentId)
      throw businessRuleViolation(
        "PRODUCTION_NOT_COMPLETED",
        "Only completed orders can be reversed",
        { status: order.status },
      );
    const reversal = await reverseDocumentInTx(
      tx,
      ctx,
      order.documentId,
      { reasonCode: "ENTERED_IN_ERROR", note: parsed.data.reason },
      { allowReceipt: false, allowProduction: true, permission: "production.manage" },
    );
    await tx.productionOrder.update({
      where: { id: order.id },
      data: {
        status: "REVERSED",
        reversalDocumentId: reversal.documentId,
        closedAt: new Date(),
        closedByUserId: ctx.userId,
        closeReason: parsed.data.reason,
      },
    });
    await audit(tx, ctx, order, "reversed", {
      reason: parsed.data.reason,
      document: reversal.number,
    });
  });
}

// ─── Queries ───

function scopeWhere(ctx: TenantContext) {
  if (!holdsAnyGrant(ctx.grants, "production.view")) throw forbidden();
  const s = accessibleScope(ctx.grants, "production.view");
  return s.all ? {} : { OR: [{ branchId: { in: s.branchIds } }, { id: { in: s.warehouseIds } }] };
}

export async function listProductionOrders(
  ctx: TenantContext,
  filters: { status?: "PLANNED" | "COMPLETED" | "REVERSED" | "CANCELLED" } = {},
) {
  const warehouse = scopeWhere(ctx);
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.productionOrder.findMany({
      where: {
        organizationId: ctx.organizationId,
        warehouse,
        ...(filters.status ? { status: filters.status } : {}),
      },
      include: {
        recipe: { select: { code: true, name: true, nameAr: true } },
        warehouse: { select: { code: true } },
        plannedUom: { select: { code: true } },
        outputProduct: { select: { sku: true, baseUom: { select: { code: true } } } },
        outputLot: { select: { lotCode: true } },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 200,
    }),
  );
}

export async function getProductionOrder(ctx: TenantContext, orderId: string) {
  const warehouse = scopeWhere(ctx);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const order = await tx.productionOrder.findFirst({
      where: { organizationId: ctx.organizationId, id: orderId, warehouse },
      include: {
        recipe: { select: { id: true, code: true, name: true, nameAr: true } },
        version: { select: { versionNo: true, yieldQuantity: true } },
        warehouse: { select: { id: true, code: true, name: true, branchId: true } },
        plannedUom: { select: { code: true } },
        outputProduct: {
          select: {
            id: true,
            sku: true,
            nameEn: true,
            nameAr: true,
            lotTracking: true,
            baseUom: { select: { code: true } },
          },
        },
        outputLot: { select: { id: true, lotCode: true, expiresOn: true } },
        document: { select: { id: true, number: true } },
        reversal: { select: { id: true, number: true } },
      },
    });
    if (!order) throw notFound("Production order");
    // What was used (completed), or what the batch will need (planned).
    const used = order.documentId
      ? (
          await tx.inventoryLedgerEntry.findMany({
            where: {
              organizationId: ctx.organizationId,
              documentId: order.documentId,
              quantityDelta: { lt: 0 },
            },
            include: {
              product: {
                select: {
                  id: true,
                  sku: true,
                  nameEn: true,
                  nameAr: true,
                  baseUom: { select: { code: true } },
                },
              },
              lot: { select: { id: true, lotCode: true, expiresOn: true } },
            },
            orderBy: { id: "asc" },
          })
        ).map((e) => ({
          product: e.product,
          lot: e.lot,
          quantity: dec(e.quantityDelta).negated(),
          value: dec(e.valueDelta).negated(),
        }))
      : [];
    let needed: Array<{
      product: {
        id: string;
        sku: string;
        nameEn: string;
        nameAr: string | null;
        baseUom: { code: string };
      };
      quantity: Decimal;
      available: Decimal;
    }> = [];
    let problems: string[] = [];
    if (order.status === "PLANNED") {
      const exploded = await ingredientsFor(tx, ctx, order.versionId, dec(order.plannedQuantity));
      problems = exploded.problems.map((p) => p.kind);
      const wh = await loadWarehouse(tx, ctx, order.warehouseId);
      const plan = await planConsumptionInTx(tx, ctx, wh, exploded.usage);
      const products = await tx.product.findMany({
        where: { organizationId: ctx.organizationId, id: { in: [...exploded.usage.keys()] } },
        select: {
          id: true,
          sku: true,
          nameEn: true,
          nameAr: true,
          baseUom: { select: { code: true } },
        },
      });
      needed = [...exploded.usage].map(([productId, quantity]) => {
        const short = plan.shortages.find((s) => s.productId === productId);
        return {
          product: products.find((p) => p.id === productId)!,
          quantity,
          available: short ? short.available : quantity,
        };
      });
    }
    const manage = hasPermission(ctx.grants, "production.manage", {
      branchId: order.warehouse.branchId,
      warehouseId: order.warehouse.id,
    });
    return {
      ...order,
      used,
      needed,
      problems,
      can: {
        complete: manage && order.status === "PLANNED",
        cancel: manage && order.status === "PLANNED",
        reverse: manage && order.status === "COMPLETED",
      },
    };
  });
}

/** Preparations that can be produced (have an output product and an active version). */
export async function producibleRecipes(ctx: TenantContext) {
  scopeWhere(ctx);
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.recipe.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        outputProductId: { not: null },
        versions: { some: { status: "ACTIVE" } },
      },
      select: {
        id: true,
        code: true,
        name: true,
        nameAr: true,
        outputProduct: { select: { id: true, sku: true, baseUom: { select: { code: true } } } },
        versions: {
          where: { status: "ACTIVE" },
          select: { yieldQuantity: true, yieldUom: { select: { id: true, code: true } } },
        },
      },
      orderBy: { code: "asc" },
    }),
  );
}

/**
 * What to produce in a warehouse: open branch requisitions for each output
 * product (not yet ordered from a supplier) plus what is needed to reach the
 * warehouse's reorder maximum when below its minimum, less usable stock and
 * batches already planned. Rounded up to whole recipe batches.
 */
export async function productionPlan(ctx: TenantContext, warehouseId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wh = await loadWarehouse(tx, ctx, warehouseId);
    assertWarehousePermission(ctx, "production.view", wh);
    const today = todayFor(wh);
    const recipes = await tx.recipe.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        outputProductId: { not: null },
        versions: { some: { status: "ACTIVE" } },
      },
      select: {
        id: true,
        code: true,
        name: true,
        nameAr: true,
        outputProductId: true,
        versions: {
          where: { status: "ACTIVE" },
          select: { yieldQuantity: true, yieldUomId: true, yieldUom: { select: { code: true } } },
        },
      },
    });
    const rows = [];
    for (const r of recipes) {
      const productId = r.outputProductId as string;
      const v = r.versions[0];
      const product = await loadProductForPosting(tx, ctx, productId);
      const batchBase = await quantityInBaseUnit(
        tx,
        ctx,
        product,
        v.yieldUomId,
        dec(v.yieldQuantity).toFixed(),
      );
      const [requested, stock, rule, planned] = await Promise.all([
        tx.purchaseRequisitionLine.aggregate({
          where: {
            organizationId: ctx.organizationId,
            productId,
            purchaseOrderLineId: null,
            requisition: { status: { in: ["SUBMITTED", "PARTIALLY_ORDERED"] } },
          },
          _sum: { quantityBase: true },
        }),
        tx.stockBalance.findMany({
          where: {
            organizationId: ctx.organizationId,
            warehouseId: wh.id,
            productId,
            stockStatus: "AVAILABLE",
            onHandQuantity: { gt: 0 },
          },
          select: {
            onHandQuantity: true,
            reservedQuantity: true,
            lot: { select: { expiresOn: true, recallHold: true } },
          },
        }),
        tx.reorderRule.findFirst({
          where: { organizationId: ctx.organizationId, warehouseId: wh.id, productId },
        }),
        tx.productionOrder.findMany({
          where: {
            organizationId: ctx.organizationId,
            warehouseId: wh.id,
            outputProductId: productId,
            status: "PLANNED",
          },
          select: { plannedQuantity: true, plannedUomId: true },
        }),
      ]);
      const usable = stock
        .filter(
          (b) =>
            !b.lot ||
            (!b.lot.recallHold &&
              (!b.lot.expiresOn || b.lot.expiresOn.toISOString().slice(0, 10) >= today)),
        )
        .reduce(
          (a, b) => a.plus(dec(b.onHandQuantity)).minus(dec(b.reservedQuantity)),
          new Decimal(0),
        );
      let plannedBase = new Decimal(0);
      for (const p of planned)
        plannedBase = plannedBase.plus(
          await quantityInBaseUnit(
            tx,
            ctx,
            product,
            p.plannedUomId,
            dec(p.plannedQuantity).toFixed(),
          ),
        );
      const demand = dec(requested._sum.quantityBase ?? 0);
      const minimum = rule ? dec(rule.minQuantityBase) : new Decimal(0);
      const target =
        rule && usable.minus(demand).lt(minimum) ? dec(rule.maxQuantityBase) : new Decimal(0);
      const need = Decimal.max(demand.plus(target).minus(usable).minus(plannedBase), 0);
      const batches = need.gt(0) ? need.dividedBy(batchBase).ceil() : new Decimal(0);
      rows.push({
        recipe: { id: r.id, code: r.code, name: r.name, nameAr: r.nameAr },
        product: { id: productId, sku: product.sku, unit: product.baseUom.code },
        demand,
        usable,
        planned: plannedBase,
        reorderMax: rule ? dec(rule.maxQuantityBase) : null,
        need,
        batches,
        suggestedQuantity: batches.times(dec(v.yieldQuantity)),
        yieldUnit: v.yieldUom.code,
      });
    }
    return {
      warehouse: wh,
      rows: rows.sort(
        (a, b) => b.need.comparedTo(a.need) || a.recipe.code.localeCompare(b.recipe.code),
      ),
    };
  });
}
