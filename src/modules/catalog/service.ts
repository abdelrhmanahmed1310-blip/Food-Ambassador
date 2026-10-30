import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, diff, recordAudit } from "@/modules/audit/service";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  notFound,
  validationFailed,
  AppError,
} from "@/server/errors";
import { validateBarcode } from "./barcodes";
import {
  barcodeSchema,
  conversionSchema,
  createProductSchema,
  productSchema,
  unitSchema,
} from "./schemas";
import { conversionFactor, toBaseQuantity, type UnitDef } from "./units";
import type { Decimal } from "@/lib/decimal";
import type { ListStatus } from "@/modules/sites/schemas";

export const PRODUCT_PAGE_SIZE = 25;

// ─── Units ───

const unitSelect = {
  id: true,
  organizationId: true,
  code: true,
  nameEn: true,
  nameAr: true,
  dimension: true,
  factorToBase: true,
  archivedAt: true,
} as const;

/** System units plus this organization's own units. */
export async function listUnits(ctx: TenantContext, options: { includeArchived?: boolean } = {}) {
  assertPermission(ctx.grants, "catalog.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    loadUnits(tx, ctx, options.includeArchived ?? false),
  );
}

export async function loadUnits(tx: Tx, ctx: TenantContext, includeArchived = false) {
  return tx.unitOfMeasure.findMany({
    where: {
      OR: [{ organizationId: null }, { organizationId: ctx.organizationId }],
      ...(includeArchived ? {} : { archivedAt: null }),
    },
    select: unitSelect,
    orderBy: [
      { dimension: "asc" },
      { organizationId: { sort: "asc", nulls: "first" } },
      { factorToBase: { sort: "asc", nulls: "last" } },
      { code: "asc" },
    ],
  });
}

export function toUnitDef(u: {
  id: string;
  code: string;
  dimension: UnitDef["dimension"];
  factorToBase: Prisma.Decimal | null;
}): UnitDef {
  return {
    id: u.id,
    code: u.code,
    dimension: u.dimension,
    factorToBase: u.factorToBase === null ? null : u.factorToBase.toString(),
  };
}

export async function createUnit(ctx: TenantContext, rawInput: unknown): Promise<{ id: string }> {
  assertPermission(ctx.grants, "catalog.manage");
  const parsed = unitSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const unit = await tx.unitOfMeasure.create({
        data: {
          ...parsed.data,
          organizationId: ctx.organizationId,
          factorToBase: parsed.data.factorToBase ?? null,
        },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "unit.created",
        entityType: "unit",
        entityId: unit.id,
        changes: parsed.data,
      });
      return unit;
    });
  } catch (error) {
    if (isUniqueViolation(error, "units_of_measure_code_key")) {
      throw conflict("A unit with this code already exists", {
        field: "code",
        reason: "codeTaken",
      });
    }
    throw error;
  }
}

// ─── Products ───

const productListSelect = {
  id: true,
  sku: true,
  nameEn: true,
  nameAr: true,
  type: true,
  lotTracking: true,
  storageRequirement: true,
  archivedAt: true,
  baseUom: { select: { id: true, code: true } },
  category: { select: { id: true, code: true, name: true, nameAr: true } },
} satisfies Prisma.ProductSelect;

export async function listProducts(
  ctx: TenantContext,
  options: { q?: string; status?: ListStatus; categoryId?: string; page?: number } = {},
) {
  assertPermission(ctx.grants, "catalog.view");
  const page = Math.max(1, options.page ?? 1);
  const q = options.q?.trim();
  const status = options.status ?? "active";
  const where: Prisma.ProductWhereInput = {
    organizationId: ctx.organizationId,
    ...(options.categoryId ? { categoryId: options.categoryId } : {}),
    ...(status === "active"
      ? { archivedAt: null }
      : status === "archived"
        ? { archivedAt: { not: null } }
        : {}),
    ...(q
      ? {
          OR: [
            { sku: { contains: q, mode: "insensitive" } },
            { nameEn: { contains: q, mode: "insensitive" } },
            { nameAr: { contains: q, mode: "insensitive" } },
            { barcodes: { some: { barcode: q } } },
          ],
        }
      : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.product.count({ where }),
      tx.product.findMany({
        where,
        select: productListSelect,
        orderBy: { sku: "asc" },
        skip: (page - 1) * PRODUCT_PAGE_SIZE,
        take: PRODUCT_PAGE_SIZE,
      }),
    ]);
    return { items, total, page, pageCount: Math.max(1, Math.ceil(total / PRODUCT_PAGE_SIZE)) };
  });
}

export async function findProduct(tx: Tx, ctx: TenantContext, productId: string) {
  const product = await tx.product.findFirst({
    where: { organizationId: ctx.organizationId, id: productId },
    select: {
      ...productListSelect,
      categoryId: true,
      shelfLifeDays: true,
      baseUomId: true,
      baseUom: { select: unitSelect },
      barcodes: {
        select: { id: true, barcode: true, symbology: true, uom: { select: { code: true } } },
        orderBy: { createdAt: "asc" },
      },
      conversions: {
        select: { id: true, uomId: true, factorToBase: true, uom: { select: unitSelect } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!product) throw notFound("Product");
  return product;
}

/**
 * Convert a quantity entered in `uomId` to the product's base unit, using
 * system factors or the product's own conversions. Rejects incompatible
 * units and quantities that round to zero.
 */
export async function quantityInBaseUnit(
  tx: Tx,
  ctx: TenantContext,
  product: Awaited<ReturnType<typeof findProduct>>,
  uomId: string,
  quantity: string,
): Promise<Decimal> {
  const units = await loadUnits(tx, ctx, true);
  const from = units.find((u) => u.id === uomId);
  if (!from) throw notFound("Unit");
  const conversions = product.conversions.map((c) => ({
    uomId: c.uomId,
    factorToBase: c.factorToBase.toString(),
  }));
  const base = toBaseQuantity(quantity, toUnitDef(from), toUnitDef(product.baseUom), conversions);
  if (base.isZero())
    throw businessRuleViolation("ZERO_QUANTITY", "Quantity rounds to zero in the base unit");
  return base;
}

export async function getProduct(ctx: TenantContext, productId: string) {
  assertPermission(ctx.grants, "catalog.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const product = await findProduct(tx, ctx, productId);
    const hasHistory =
      (await tx.inventoryLedgerEntry.count({
        where: { organizationId: ctx.organizationId, productId },
      })) > 0;
    return { ...product, hasHistory };
  });
}

async function assertUnitUsable(tx: Tx, ctx: TenantContext, uomId: string) {
  const unit = await tx.unitOfMeasure.findFirst({
    where: {
      id: uomId,
      archivedAt: null,
      OR: [{ organizationId: null }, { organizationId: ctx.organizationId }],
    },
    select: unitSelect,
  });
  if (!unit) throw notFound("Unit");
  return unit;
}

function skuConflict(error: unknown): never {
  if (isUniqueViolation(error, "products_organization_id_sku_key"))
    throw conflict("SKU already exists", { field: "sku", reason: "skuTaken" });
  throw error;
}

export async function createProduct(
  ctx: TenantContext,
  rawInput: unknown,
): Promise<{ id: string }> {
  assertPermission(ctx.grants, "catalog.manage");
  const parsed = createProductSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  try {
    return await runIdempotent(
      ctx,
      { key: idempotencyKey, operation: "product.create", input },
      async (tx) => {
        await assertUnitUsable(tx, ctx, input.baseUomId);
        await assertCategoryUsable(tx, ctx, input.categoryId);
        const product = await tx.product.create({
          data: {
            ...input,
            organizationId: ctx.organizationId,
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          },
          select: { id: true },
        });
        await recordAudit(tx, actorOf(ctx), {
          action: "product.created",
          entityType: "product",
          entityId: product.id,
          changes: input,
        });
        return { id: product.id };
      },
    );
  } catch (error) {
    skuConflict(error);
  }
}

export async function updateProduct(
  ctx: TenantContext,
  productId: string,
  rawInput: unknown,
): Promise<void> {
  assertPermission(ctx.grants, "catalog.manage");
  const parsed = productSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = {
    ...parsed.data,
    nameAr: parsed.data.nameAr ?? null,
    shelfLifeDays: parsed.data.shelfLifeDays ?? null,
    categoryId: parsed.data.categoryId ?? null,
  };
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const before = await findProduct(tx, ctx, productId);
      if (input.categoryId !== before.categoryId)
        await assertCategoryUsable(tx, ctx, input.categoryId ?? undefined);
      if (input.baseUomId !== before.baseUomId || input.lotTracking !== before.lotTracking) {
        // Stock history is expressed in the base unit and lot identity: both are frozen once used.
        const used = await tx.inventoryLedgerEntry.count({
          where: { organizationId: ctx.organizationId, productId },
        });
        if (used > 0)
          throw businessRuleViolation(
            "PRODUCT_HAS_HISTORY",
            "Base unit and lot tracking cannot change after stock movements",
          );
        await assertUnitUsable(tx, ctx, input.baseUomId);
      }
      await tx.product.update({
        where: { organizationId_id: { organizationId: ctx.organizationId, id: productId } },
        data: { ...input, updatedByUserId: ctx.userId },
      });
      const changes = diff(
        {
          sku: before.sku,
          nameEn: before.nameEn,
          nameAr: before.nameAr,
          type: before.type,
          baseUomId: before.baseUomId,
          lotTracking: before.lotTracking,
          shelfLifeDays: before.shelfLifeDays,
          storageRequirement: before.storageRequirement,
          categoryId: before.categoryId,
        },
        input,
      );
      if (Object.keys(changes).length > 0)
        await recordAudit(tx, actorOf(ctx), {
          action: "product.updated",
          entityType: "product",
          entityId: productId,
          changes,
        });
    });
  } catch (error) {
    skuConflict(error);
  }
}

/** A category may be assigned only if it belongs to this organization and is not archived. */
async function assertCategoryUsable(tx: Tx, ctx: TenantContext, categoryId: string | undefined) {
  if (!categoryId) return;
  const category = await tx.productCategory.findFirst({
    where: { organizationId: ctx.organizationId, id: categoryId },
    select: { archivedAt: true },
  });
  if (!category) throw notFound("Category");
  if (category.archivedAt)
    throw businessRuleViolation("CATEGORY_ARCHIVED", "The category is archived");
}

export async function setProductArchived(
  ctx: TenantContext,
  productId: string,
  archived: boolean,
): Promise<void> {
  assertPermission(ctx.grants, "catalog.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const product = await findProduct(tx, ctx, productId);
    if (archived === (product.archivedAt !== null)) return;
    if (archived) {
      const inStock = await tx.stockBalance.count({
        where: { organizationId: ctx.organizationId, productId, onHandQuantity: { gt: 0 } },
      });
      if (inStock > 0)
        throw businessRuleViolation(
          "PRODUCT_HAS_STOCK",
          "Products with stock on hand cannot be archived",
        );
    }
    await tx.product.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id: productId } },
      data: { archivedAt: archived ? new Date() : null, updatedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "product.archived" : "product.restored",
      entityType: "product",
      entityId: productId,
    });
  });
}

// ─── Barcodes and conversions ───

export async function addBarcode(
  ctx: TenantContext,
  productId: string,
  rawInput: unknown,
): Promise<void> {
  assertPermission(ctx.grants, "catalog.manage");
  const parsed = barcodeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const problem = validateBarcode(parsed.data.barcode, parsed.data.symbology);
  if (problem)
    throw new AppError("VALIDATION_FAILED", "Invalid barcode", {
      issues: [{ path: "barcode", message: problem }],
    });
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      await findProduct(tx, ctx, productId);
      if (parsed.data.uomId) await assertUnitUsable(tx, ctx, parsed.data.uomId);
      const row = await tx.productBarcode.create({
        data: {
          ...parsed.data,
          organizationId: ctx.organizationId,
          productId,
          createdByUserId: ctx.userId,
        },
        select: { id: true },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "product.barcode_added",
        entityType: "product",
        entityId: productId,
        changes: { barcodeId: row.id, ...parsed.data },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "product_barcodes_organization_id_barcode_key")) {
      throw conflict("Barcode already assigned", { field: "barcode", reason: "barcodeTaken" });
    }
    throw error;
  }
}

export async function removeBarcode(
  ctx: TenantContext,
  productId: string,
  barcodeId: string,
): Promise<void> {
  assertPermission(ctx.grants, "catalog.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { count } = await tx.productBarcode.deleteMany({
      where: { organizationId: ctx.organizationId, productId, id: barcodeId },
    });
    if (count === 0) throw notFound("Barcode");
    await recordAudit(tx, actorOf(ctx), {
      action: "product.barcode_removed",
      entityType: "product",
      entityId: productId,
      changes: { barcodeId },
    });
  });
}

export async function addConversion(
  ctx: TenantContext,
  productId: string,
  rawInput: unknown,
): Promise<void> {
  assertPermission(ctx.grants, "catalog.manage");
  const parsed = conversionSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const product = await findProduct(tx, ctx, productId);
      if (parsed.data.uomId === product.baseUomId)
        throw businessRuleViolation("CONVERSION_TO_SELF", "The base unit needs no conversion");
      await assertUnitUsable(tx, ctx, parsed.data.uomId);
      await tx.productUomConversion.create({
        data: { organizationId: ctx.organizationId, productId, ...parsed.data },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "product.conversion_added",
        entityType: "product",
        entityId: productId,
        changes: parsed.data,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "product_uom_conversions_organization_id_product_id_uom_id_key")) {
      throw conflict("Conversion already defined", { field: "uomId", reason: "conversionExists" });
    }
    throw error;
  }
}

/** Past movements keep their base quantities, so removing a conversion only affects future entries. */
export async function removeConversion(
  ctx: TenantContext,
  productId: string,
  conversionId: string,
): Promise<void> {
  assertPermission(ctx.grants, "catalog.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const { count } = await tx.productUomConversion.deleteMany({
      where: { organizationId: ctx.organizationId, productId, id: conversionId },
    });
    if (count === 0) throw notFound("Conversion");
    await recordAudit(tx, actorOf(ctx), {
      action: "product.conversion_removed",
      entityType: "product",
      entityId: productId,
      changes: { conversionId },
    });
  });
}

/** Units this product can be entered in, with their factor to the base unit. */
export async function productUnitOptions(tx: Tx, ctx: TenantContext, productId: string) {
  const product = await findProduct(tx, ctx, productId);
  const units = await loadUnits(tx, ctx);
  const base = toUnitDef(product.baseUom);
  const conversions = product.conversions.map((c) => ({
    uomId: c.uomId,
    factorToBase: c.factorToBase.toString(),
  }));
  const options: Array<{ id: string; code: string; factor: string }> = [];
  for (const u of units) {
    try {
      options.push({
        id: u.id,
        code: u.code,
        factor: conversionFactor(toUnitDef(u), base, conversions).toFixed(),
      });
    } catch {
      // incompatible: not offered
    }
  }
  return { product, options };
}

/** Active products for pickers (MVP: plain select; a search picker is planned for large catalogs). */
export async function listProductOptions(ctx: TenantContext) {
  assertPermission(ctx.grants, "catalog.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.product.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: {
        id: true,
        sku: true,
        nameEn: true,
        nameAr: true,
        lotTracking: true,
        baseUom: { select: { code: true } },
      },
      orderBy: { sku: "asc" },
      take: 2000,
    }),
  );
}

export async function exportProductsCsv(ctx: TenantContext): Promise<string> {
  assertPermission(ctx.grants, "catalog.view");
  const rows = await withTenantTx(ctx.organizationId, (tx) =>
    tx.product.findMany({
      where: { organizationId: ctx.organizationId },
      select: {
        sku: true,
        nameEn: true,
        nameAr: true,
        type: true,
        lotTracking: true,
        shelfLifeDays: true,
        storageRequirement: true,
        archivedAt: true,
        baseUom: { select: { code: true } },
        barcodes: { select: { barcode: true } },
      },
      orderBy: { sku: "asc" },
    }),
  );
  return toCsv(
    [
      "sku",
      "name_en",
      "name_ar",
      "type",
      "base_unit",
      "lot_tracking",
      "shelf_life_days",
      "storage",
      "barcodes",
      "archived",
    ],
    rows.map((p) => [
      p.sku,
      p.nameEn,
      p.nameAr,
      p.type,
      p.baseUom.code,
      p.lotTracking,
      p.shelfLifeDays,
      p.storageRequirement,
      p.barcodes.map((b) => b.barcode).join(" "),
      p.archivedAt ? "yes" : "",
    ]),
  );
}

/** Units a quantity of this product can be entered in (base unit first). */
export async function productEntryUnits(ctx: TenantContext, productId: string) {
  assertPermission(ctx.grants, "catalog.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { product, options } = await productUnitOptions(tx, ctx, productId);
    return options.sort((a, b) =>
      a.id === product.baseUomId ? -1 : b.id === product.baseUomId ? 1 : 0,
    );
  });
}

/**
 * Fill in a product's Arabic name from a linked library record (ADR-041);
 * a name someone already entered is never replaced. Returns whether it was set.
 */
export async function setArabicNameIfEmptyInTx(
  tx: Tx,
  ctx: TenantContext,
  productId: string,
  nameAr: string,
): Promise<boolean> {
  const { count } = await tx.product.updateMany({
    where: { organizationId: ctx.organizationId, id: productId, nameAr: null },
    data: { nameAr: nameAr.slice(0, 160), updatedByUserId: ctx.userId },
  });
  if (count > 0)
    await recordAudit(tx, actorOf(ctx), {
      action: "product.updated",
      entityType: "product",
      entityId: productId,
      changes: { nameAr: { from: null, to: nameAr.slice(0, 160) }, via: "ingredient_library" },
    });
  return count > 0;
}
