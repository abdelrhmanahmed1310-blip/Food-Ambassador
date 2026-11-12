import "server-only";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { postTransfer } from "@/modules/inventory/operations";
import { optionalUuidSchema, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { categoryParentsInTx } from "@/modules/catalog/categories";
import { lineage } from "@/modules/catalog/category-tree";
import { locationFits, PUTAWAY_TARGET_ZONES, suggestLocation, type RuleCandidate } from "./rules";

/**
 * Directed put-away (DECISIONS.md ADR-101). Per warehouse, put-away rules
 * say where received stock goes (by product, category or storage
 * temperature, lowest priority number first). The worklist is available
 * stock sitting in receiving locations — or without a location in a
 * warehouse that has storage locations — each with a suggested place. A
 * put-away is a transfer between locations through the ledger, and only
 * into a storage or picking location at the product's temperature.
 * Rules need `warehouses.manage`; put-away needs `inventory.transfer`.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());

const ruleSchema = z.object({
  priority: z
    .string({ error: "required" })
    .trim()
    .regex(/^\d{1,4}$/, { error: "invalidPositiveInteger" })
    .transform(Number)
    .refine((v) => v >= 1 && v <= 9999, { error: "invalidPositiveInteger" }),
  productId: optionalUuidSchema,
  categoryId: optionalUuidSchema,
  storageRequirement: z
    .enum(["AMBIENT", "CHILLED", "FROZEN", ""], { error: "invalidOption" })
    .optional()
    .transform((v) => (v ? v : undefined)),
  locationId: uuidSchema,
});

const putAwaySchema = z.object({
  balanceId: uuidSchema,
  toLocationId: uuidSchema,
  quantity: decimalString({ maxScale: 6, min: "0.000001" }),
});

async function visibleWarehouse(tx: Tx, ctx: TenantContext, warehouseId: string) {
  const wh = isUuid(warehouseId)
    ? await tx.warehouse.findFirst({
        where: { organizationId: ctx.organizationId, id: warehouseId },
        select: { id: true, code: true, name: true, branchId: true, archivedAt: true },
      })
    : null;
  if (
    !wh ||
    !hasPermission(ctx.grants, "inventory.view", { branchId: wh.branchId, warehouseId: wh.id })
  )
    throw notFound("Warehouse");
  return wh;
}

const target = (wh: { id: string; branchId: string }) => ({
  branchId: wh.branchId,
  warehouseId: wh.id,
});

export async function createPutawayRule(
  ctx: TenantContext,
  warehouseId: string,
  rawInput: unknown,
) {
  const parsed = ruleSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wh = await visibleWarehouse(tx, ctx, warehouseId);
    assertPermission(ctx.grants, "warehouses.manage", target(wh));
    const location = await tx.storageLocation.findFirst({
      where: { organizationId: ctx.organizationId, warehouseId: wh.id, id: input.locationId },
      select: { id: true, zone: true, temperatureZone: true, archivedAt: true },
    });
    if (!location) throw notFound("Storage location");
    if (location.archivedAt || !PUTAWAY_TARGET_ZONES.includes(location.zone))
      throw businessRuleViolation(
        "PUTAWAY_LOCATION_NOT_STORAGE",
        "Put-away rules point at an active storage or picking location",
        { field: "locationId" },
      );
    if (input.storageRequirement && input.storageRequirement !== location.temperatureZone)
      throw businessRuleViolation(
        "PUTAWAY_TEMPERATURE_MISMATCH",
        "The location's temperature does not match",
        { field: "locationId" },
      );
    if (input.productId) {
      const p = await tx.product.findFirst({
        where: { organizationId: ctx.organizationId, id: input.productId },
        select: { storageRequirement: true },
      });
      if (!p) throw notFound("Product");
      if (p.storageRequirement !== location.temperatureZone)
        throw businessRuleViolation(
          "PUTAWAY_TEMPERATURE_MISMATCH",
          "The location's temperature does not match",
          { field: "locationId" },
        );
    }
    if (input.categoryId) {
      const c = await tx.productCategory.findFirst({
        where: { organizationId: ctx.organizationId, id: input.categoryId },
        select: { id: true },
      });
      if (!c) throw notFound("Category");
    }
    const rule = await tx.putawayRule.create({
      data: {
        organizationId: ctx.organizationId,
        warehouseId: wh.id,
        priority: input.priority,
        productId: input.productId ?? null,
        categoryId: input.categoryId ?? null,
        storageRequirement: input.storageRequirement ?? null,
        locationId: location.id,
        createdByUserId: ctx.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "putaway_rule.created",
      entityType: "putaway_rule",
      entityId: rule.id,
      changes: { warehouseId: wh.id, ...input },
    });
    return rule;
  });
}

export async function archivePutawayRule(ctx: TenantContext, ruleId: string) {
  if (!isUuid(ruleId)) throw notFound("Put-away rule");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const rule = await tx.putawayRule.findFirst({
      where: { organizationId: ctx.organizationId, id: ruleId, archivedAt: null },
      select: { id: true, warehouseId: true },
    });
    if (!rule) throw notFound("Put-away rule");
    const wh = await visibleWarehouse(tx, ctx, rule.warehouseId);
    assertPermission(ctx.grants, "warehouses.manage", target(wh));
    await tx.putawayRule.update({ where: { id: rule.id }, data: { archivedAt: new Date() } });
    await recordAudit(tx, actorOf(ctx), {
      action: "putaway_rule.archived",
      entityType: "putaway_rule",
      entityId: rule.id,
      changes: {},
    });
  });
}

async function activeRules(tx: Tx, ctx: TenantContext, warehouseId: string) {
  return tx.putawayRule.findMany({
    where: { organizationId: ctx.organizationId, warehouseId, archivedAt: null },
    include: {
      location: {
        select: { id: true, code: true, zone: true, temperatureZone: true, archivedAt: true },
      },
      product: { select: { sku: true, nameEn: true, nameAr: true } },
      category: { select: { code: true, name: true, nameAr: true } },
    },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
}

const asCandidate = (r: Awaited<ReturnType<typeof activeRules>>[number]): RuleCandidate => ({
  id: r.id,
  priority: r.priority,
  productId: r.productId,
  categoryId: r.categoryId,
  storageRequirement: r.storageRequirement,
  location: {
    id: r.location.id,
    zone: r.location.zone,
    temperatureZone: r.location.temperatureZone,
    archived: r.location.archivedAt !== null,
  },
});

/** The warehouse's locations, rules, and the stock waiting to be put away with a suggestion each. */
export async function putawayWorklist(ctx: TenantContext, warehouseId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const wh = await visibleWarehouse(tx, ctx, warehouseId);
    const locations = await tx.storageLocation.findMany({
      where: { organizationId: ctx.organizationId, warehouseId: wh.id },
      select: {
        id: true,
        code: true,
        name: true,
        zone: true,
        temperatureZone: true,
        archivedAt: true,
      },
      orderBy: { code: "asc" },
    });
    const rules = await activeRules(tx, ctx, wh.id);
    const receiving = locations.filter((l) => l.zone === "RECEIVING").map((l) => l.id);
    const hasStorage = locations.some(
      (l) => !l.archivedAt && PUTAWAY_TARGET_ZONES.includes(l.zone),
    );
    // A put-away rule on a category also covers its subcategories (ADR-134).
    const parents = await categoryParentsInTx(tx, ctx);
    const balances = await tx.stockBalance.findMany({
      where: {
        organizationId: ctx.organizationId,
        warehouseId: wh.id,
        stockStatus: "AVAILABLE",
        onHandQuantity: { gt: 0 },
        OR: [{ locationId: { in: receiving } }, ...(hasStorage ? [{ locationId: null }] : [])],
      },
      select: {
        id: true,
        locationId: true,
        onHandQuantity: true,
        product: {
          select: {
            id: true,
            sku: true,
            nameEn: true,
            nameAr: true,
            categoryId: true,
            storageRequirement: true,
            baseUom: { select: { code: true } },
          },
        },
        lot: { select: { id: true, lotCode: true, expiresOn: true } },
      },
      orderBy: [{ product: { sku: "asc" } }],
      take: 300,
    });
    // Where each product already sits in a fitting place (for the fallback suggestion).
    const productIds = [...new Set(balances.map((b) => b.product.id))];
    const held = productIds.length
      ? await tx.stockBalance.findMany({
          where: {
            organizationId: ctx.organizationId,
            warehouseId: wh.id,
            productId: { in: productIds },
            onHandQuantity: { gt: 0 },
            locationId: { not: null },
          },
          select: { productId: true, locationId: true },
          distinct: ["productId", "locationId"],
        })
      : [];
    const byId = new Map(locations.map((l) => [l.id, l]));
    const fact = (l: (typeof locations)[number]) => ({
      id: l.id,
      zone: l.zone,
      temperatureZone: l.temperatureZone,
      archived: l.archivedAt !== null,
    });
    const candidates = rules.map(asCandidate);
    return {
      warehouse: wh,
      locations,
      rules,
      canManage: hasPermission(ctx.grants, "warehouses.manage", target(wh)),
      canPutAway: hasPermission(ctx.grants, "inventory.transfer", target(wh)),
      items: balances.map((b) => {
        const holding = held
          .filter((h) => h.productId === b.product.id && h.locationId)
          .map((h) => byId.get(h.locationId as string))
          .filter((l): l is (typeof locations)[number] => !!l)
          .map(fact);
        return {
          ...b,
          location: b.locationId ? (byId.get(b.locationId) ?? null) : null,
          suggestion: suggestLocation(
            candidates,
            {
              ...b.product,
              categoryLineage: b.product.categoryId ? lineage(b.product.categoryId, parents) : [],
            },
            holding,
          ),
          /** Places this product may go to. */
          targets: locations.filter((l) => locationFits(fact(l), b.product)),
        };
      }),
    };
  });
}

/** Move received stock into its storage place: a location-to-location transfer in the ledger. */
export async function putAway(ctx: TenantContext, rawInput: unknown) {
  const parsed = putAwaySchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  const prepared = await withTenantTx(ctx.organizationId, async (tx) => {
    const balance = await tx.stockBalance.findFirst({
      where: { organizationId: ctx.organizationId, id: input.balanceId },
      select: {
        warehouseId: true,
        locationId: true,
        lotId: true,
        stockStatus: true,
        onHandQuantity: true,
        product: { select: { id: true, baseUomId: true, storageRequirement: true } },
      },
    });
    if (!balance) throw notFound("Stock");
    const wh = await visibleWarehouse(tx, ctx, balance.warehouseId);
    assertPermission(ctx.grants, "inventory.transfer", target(wh));
    if (balance.stockStatus !== "AVAILABLE")
      throw businessRuleViolation("PUTAWAY_NOT_AVAILABLE", "Only available stock is put away");
    if (dec(balance.onHandQuantity).lt(input.quantity))
      throw businessRuleViolation("INSUFFICIENT_STOCK", "Not enough stock", {
        field: "quantity",
        available: dec(balance.onHandQuantity).toFixed(),
      });
    const to = await tx.storageLocation.findFirst({
      where: { organizationId: ctx.organizationId, warehouseId: wh.id, id: input.toLocationId },
      select: { id: true, zone: true, temperatureZone: true, archivedAt: true },
    });
    if (!to) throw notFound("Storage location");
    if (to.archivedAt || !PUTAWAY_TARGET_ZONES.includes(to.zone))
      throw businessRuleViolation(
        "PUTAWAY_LOCATION_NOT_STORAGE",
        "Put stock away into an active storage or picking location",
        { field: "toLocationId" },
      );
    if (to.temperatureZone !== balance.product.storageRequirement)
      throw businessRuleViolation(
        "PUTAWAY_TEMPERATURE_MISMATCH",
        "The location's temperature does not match the product's storage requirement",
        { field: "toLocationId" },
      );
    if (to.id === balance.locationId)
      throw businessRuleViolation("TRANSFER_SAME_PLACE", "Source and destination are the same");
    return balance;
  });
  return postTransfer(ctx, {
    warehouseId: prepared.warehouseId,
    toWarehouseId: prepared.warehouseId,
    locationId: prepared.locationId ?? undefined,
    toLocationId: input.toLocationId,
    productId: prepared.product.id,
    lotId: prepared.lotId ?? undefined,
    quantity: input.quantity,
    uomId: prepared.product.baseUomId,
    note: "Put-away",
  });
}
