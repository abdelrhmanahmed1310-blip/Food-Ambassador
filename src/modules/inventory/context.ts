import "server-only";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import type { Permission } from "@/modules/access/permissions";
import { findProduct, loadUnits, toUnitDef } from "@/modules/catalog/service";
import { toBaseQuantity } from "@/modules/catalog/units";
import type { TenantContext } from "@/modules/tenancy/context";
import type { Tx } from "@/server/db/transactions";
import { AppError, businessRuleViolation, notFound } from "@/server/errors";
import { toDecimal, type Decimal } from "@/lib/decimal";
import { businessDate } from "./rules";

/** Shared lookups for inventory operations; all tenant- and scope-checked. */

export interface WarehouseInfo {
  id: string;
  code: string;
  name: string;
  branchId: string;
  archived: boolean;
  timeZone: string;
}

export async function loadWarehouse(
  tx: Tx,
  ctx: TenantContext,
  warehouseId: string,
): Promise<WarehouseInfo> {
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
  if (
    !wh ||
    !hasPermission(ctx.grants, "inventory.view", { branchId: wh.branchId, warehouseId: wh.id })
  )
    throw notFound("Warehouse");
  return {
    id: wh.id,
    code: wh.code,
    name: wh.name,
    branchId: wh.branchId,
    archived: wh.archivedAt !== null || wh.branch.archivedAt !== null,
    timeZone: wh.branch.timeZone ?? ctx.timeZone,
  };
}

export function assertWarehousePermission(
  ctx: TenantContext,
  permission: Permission,
  wh: WarehouseInfo,
) {
  assertPermission(ctx.grants, permission, { branchId: wh.branchId, warehouseId: wh.id });
}

export function assertActive(wh: WarehouseInfo) {
  if (wh.archived) throw businessRuleViolation("WAREHOUSE_ARCHIVED", "The warehouse is archived");
}

export function todayFor(wh: WarehouseInfo): string {
  return businessDate(wh.timeZone);
}

export async function loadLocation(
  tx: Tx,
  ctx: TenantContext,
  warehouseId: string,
  locationId: string | undefined,
  forInbound: boolean,
) {
  if (!locationId) return null;
  const loc = await tx.storageLocation.findFirst({
    where: { organizationId: ctx.organizationId, warehouseId, id: locationId },
    select: { id: true, archivedAt: true },
  });
  if (!loc) throw notFound("Storage location");
  if (forInbound && loc.archivedAt)
    throw businessRuleViolation("LOCATION_ARCHIVED", "The storage location is archived");
  return loc.id;
}

export type PostingProduct = Awaited<ReturnType<typeof findProduct>>;

export async function loadProductForPosting(tx: Tx, ctx: TenantContext, productId: string) {
  assertPermission(ctx.grants, "catalog.view");
  return findProduct(tx, ctx, productId);
}

/** Convert an entered quantity to the product's base unit (rejects incompatible units). */
export async function toBase(
  tx: Tx,
  ctx: TenantContext,
  product: PostingProduct,
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

const toDateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export interface LotInfo {
  id: string;
  lotCode: string;
  expiresOn: string | null;
  recallHold: boolean;
}

/** Find or create the lot for incoming stock, enforcing the product's lot rules. */
export async function resolveInboundLot(
  tx: Tx,
  ctx: TenantContext,
  product: PostingProduct,
  input: { lotCode?: string; expiresOn?: string; bestBeforeOn?: string },
): Promise<LotInfo | null> {
  if (product.lotTracking === "NONE") {
    if (input.lotCode || input.expiresOn)
      throw businessRuleViolation("PRODUCT_NOT_LOT_TRACKED", "This product is not lot-tracked");
    return null;
  }
  if (!input.lotCode) throw fieldError("lotCode", "lotRequired");
  const existing = await tx.inventoryLot.findFirst({
    where: { organizationId: ctx.organizationId, productId: product.id, lotCode: input.lotCode },
    select: { id: true, lotCode: true, expiresOn: true, recallHold: true },
  });
  if (existing) {
    const stored = toDateOnly(existing.expiresOn);
    if (input.expiresOn && input.expiresOn !== stored) {
      throw businessRuleViolation(
        "LOT_EXPIRY_MISMATCH",
        "This lot already exists with a different expiry date",
        { expiresOn: stored },
      );
    }
    return {
      id: existing.id,
      lotCode: existing.lotCode,
      expiresOn: stored,
      recallHold: existing.recallHold,
    };
  }
  if (product.lotTracking === "LOT_AND_EXPIRY" && !input.expiresOn)
    throw fieldError("expiresOn", "expiryRequired");
  const lot = await tx.inventoryLot.create({
    data: {
      organizationId: ctx.organizationId,
      productId: product.id,
      lotCode: input.lotCode,
      expiresOn: input.expiresOn ? new Date(`${input.expiresOn}T00:00:00Z`) : null,
      bestBeforeOn: input.bestBeforeOn ? new Date(`${input.bestBeforeOn}T00:00:00Z`) : null,
      createdByUserId: ctx.userId,
    },
    select: { id: true, lotCode: true, expiresOn: true, recallHold: true },
  });
  return {
    id: lot.id,
    lotCode: lot.lotCode,
    expiresOn: toDateOnly(lot.expiresOn),
    recallHold: lot.recallHold,
  };
}

/** An existing lot referenced by id (outbound movements). */
export async function resolveExistingLot(
  tx: Tx,
  ctx: TenantContext,
  product: PostingProduct,
  lotId: string | undefined,
): Promise<LotInfo | null> {
  if (product.lotTracking === "NONE") {
    if (lotId)
      throw businessRuleViolation("PRODUCT_NOT_LOT_TRACKED", "This product is not lot-tracked");
    return null;
  }
  if (!lotId) throw fieldError("lotId", "lotRequired");
  const lot = await tx.inventoryLot.findFirst({
    where: { organizationId: ctx.organizationId, productId: product.id, id: lotId },
    select: { id: true, lotCode: true, expiresOn: true, recallHold: true },
  });
  if (!lot) throw notFound("Lot");
  return {
    id: lot.id,
    lotCode: lot.lotCode,
    expiresOn: toDateOnly(lot.expiresOn),
    recallHold: lot.recallHold,
  };
}

/** A field-level validation error, shaped like Zod failures so forms highlight the field. */
export function fieldError(path: string, message: string): AppError {
  return new AppError("VALIDATION_FAILED", "Input validation failed", {
    issues: [{ path, message }],
  });
}

export function decimalOrNull(v: string | undefined): Decimal | null {
  return v === undefined ? null : toDecimal(v);
}
