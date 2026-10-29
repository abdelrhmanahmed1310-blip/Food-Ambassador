import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, diff, recordAudit } from "@/modules/audit/service";
import { findProduct, quantityInBaseUnit } from "@/modules/catalog/service";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { ListStatus } from "@/modules/sites/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { supplierPerformance } from "./rules";
import { createSupplierSchema, supplierProductSchema, supplierSchema } from "./schemas";

export const SUPPLIER_PAGE_SIZE = 25;

const dec = (v: { toString(): string }) => new Decimal(v.toString());

function codeConflict(error: unknown): never {
  if (isUniqueViolation(error, "suppliers_organization_id_code_key"))
    throw conflict("A supplier with this code already exists", {
      field: "code",
      reason: "codeTaken",
    });
  throw error;
}

export async function loadSupplier(tx: Tx, ctx: TenantContext, supplierId: string) {
  const supplier = await tx.supplier.findFirst({
    where: { organizationId: ctx.organizationId, id: supplierId },
  });
  if (!supplier) throw notFound("Supplier");
  return supplier;
}

export async function listSuppliers(
  ctx: TenantContext,
  options: { q?: string; status?: ListStatus; page?: number } = {},
) {
  assertPermission(ctx.grants, "suppliers.view");
  const page = Math.max(1, options.page ?? 1);
  const q = options.q?.trim();
  const status = options.status ?? "active";
  const where: Prisma.SupplierWhereInput = {
    organizationId: ctx.organizationId,
    ...(status === "active"
      ? { archivedAt: null }
      : status === "archived"
        ? { archivedAt: { not: null } }
        : {}),
    ...(q
      ? {
          OR: [
            { code: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
            { nameAr: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.supplier.count({ where }),
      tx.supplier.findMany({
        where,
        orderBy: { code: "asc" },
        skip: (page - 1) * SUPPLIER_PAGE_SIZE,
        take: SUPPLIER_PAGE_SIZE,
        include: { _count: { select: { products: { where: { archivedAt: null } } } } },
      }),
    ]);
    return {
      items,
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / SUPPLIER_PAGE_SIZE)),
    };
  });
}

/** Active suppliers for pickers. */
export async function supplierOptions(ctx: TenantContext) {
  assertPermission(ctx.grants, "suppliers.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.supplier.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      select: { id: true, code: true, name: true, nameAr: true },
      orderBy: { code: "asc" },
      take: 2000,
    }),
  );
}

export async function createSupplier(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "suppliers.manage");
  const parsed = createSupplierSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  try {
    return await runIdempotent(
      ctx,
      { key: idempotencyKey, operation: "supplier.create", input },
      async (tx) => {
        const supplier = await tx.supplier.create({
          data: { ...input, organizationId: ctx.organizationId },
          select: { id: true },
        });
        await recordAudit(tx, actorOf(ctx), {
          action: "supplier.created",
          entityType: "supplier",
          entityId: supplier.id,
          changes: input,
        });
        return { id: supplier.id };
      },
    );
  } catch (error) {
    codeConflict(error);
  }
}

export async function updateSupplier(ctx: TenantContext, supplierId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "suppliers.manage");
  const parsed = supplierSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const d = parsed.data;
  // Cleared optional fields are stored as null.
  const input = {
    code: d.code,
    name: d.name,
    nameAr: d.nameAr ?? null,
    taxId: d.taxId ?? null,
    contactName: d.contactName ?? null,
    email: d.email ?? null,
    phone: d.phone ?? null,
    address: d.address ?? null,
    paymentTermsDays: d.paymentTermsDays ?? null,
    leadTimeDays: d.leadTimeDays ?? null,
    note: d.note ?? null,
  };
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const before = await loadSupplier(tx, ctx, supplierId);
      await tx.supplier.update({ where: { id: before.id }, data: input });
      const changes = diff(before as unknown as Record<string, unknown>, input);
      if (Object.keys(changes).length > 0)
        await recordAudit(tx, actorOf(ctx), {
          action: "supplier.updated",
          entityType: "supplier",
          entityId: before.id,
          changes,
        });
    });
  } catch (error) {
    codeConflict(error);
  }
}

export async function setSupplierArchived(
  ctx: TenantContext,
  supplierId: string,
  archived: boolean,
) {
  assertPermission(ctx.grants, "suppliers.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const supplier = await loadSupplier(tx, ctx, supplierId);
    if (archived) {
      const open = await tx.purchaseOrder.count({
        where: {
          organizationId: ctx.organizationId,
          supplierId: supplier.id,
          status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PARTIALLY_RECEIVED"] },
        },
      });
      if (open > 0)
        throw businessRuleViolation(
          "SUPPLIER_HAS_OPEN_ORDERS",
          "Close or cancel this supplier's open orders first",
        );
    }
    await tx.supplier.update({
      where: { id: supplier.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "supplier.archived" : "supplier.restored",
      entityType: "supplier",
      entityId: supplier.id,
    });
  });
}

// ─── Supplier products ───

/** Add or update what this supplier sells a product as (unit, SKU, price, lead time). */
export async function saveSupplierProduct(
  ctx: TenantContext,
  supplierId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "suppliers.manage");
  assertPermission(ctx.grants, "catalog.view");
  const parsed = supplierProductSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const supplier = await loadSupplier(tx, ctx, supplierId);
    const product = await findProduct(tx, ctx, input.productId);
    // The purchase unit must convert to the product's base unit.
    await quantityInBaseUnit(tx, ctx, product, input.purchaseUomId, "1");
    const data = {
      purchaseUomId: input.purchaseUomId,
      supplierSku: input.supplierSku ?? null,
      lastUnitPrice: input.lastUnitPrice ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      minOrderQuantity: input.minOrderQuantity ?? null,
      preferred: input.preferred,
      archivedAt: null,
    };
    const row = await tx.supplierProduct.upsert({
      where: {
        organizationId_supplierId_productId: {
          organizationId: ctx.organizationId,
          supplierId: supplier.id,
          productId: product.id,
        },
      },
      create: {
        ...data,
        organizationId: ctx.organizationId,
        supplierId: supplier.id,
        productId: product.id,
        lastPriceAt: input.lastUnitPrice ? new Date() : null,
      },
      update: data,
      select: { id: true },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.product_saved",
      entityType: "supplier",
      entityId: supplier.id,
      changes: input,
    });
    return row;
  });
}

export async function removeSupplierProduct(
  ctx: TenantContext,
  supplierId: string,
  supplierProductId: string,
) {
  assertPermission(ctx.grants, "suppliers.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const row = await tx.supplierProduct.findFirst({
      where: { organizationId: ctx.organizationId, supplierId, id: supplierProductId },
    });
    if (!row) throw notFound("Supplier product");
    // Kept (archived) so price history and order defaults stay explainable.
    await tx.supplierProduct.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
    await recordAudit(tx, actorOf(ctx), {
      action: "supplier.product_removed",
      entityType: "supplier",
      entityId: supplierId,
      changes: { productId: row.productId },
    });
  });
}

/** Supplier page: details, products, recent orders and the scorecard. */
export async function getSupplier(ctx: TenantContext, supplierId: string) {
  assertPermission(ctx.grants, "suppliers.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const supplier = await loadSupplier(tx, ctx, supplierId);
    const [products, receipts, finished] = await inSequence([
      tx.supplierProduct.findMany({
        where: { organizationId: ctx.organizationId, supplierId: supplier.id, archivedAt: null },
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
          purchaseUom: { select: { id: true, code: true } },
        },
        orderBy: { product: { sku: "asc" } },
      }),
      tx.goodsReceipt.findMany({
        where: { organizationId: ctx.organizationId, supplierId: supplier.id, status: "POSTED" },
        select: {
          receivedAt: true,
          purchaseOrder: { select: { expectedOn: true } },
          warehouse: { select: { branch: { select: { timeZone: true } } } },
          lines: {
            select: {
              acceptedQuantity: true,
              rejectedQuantity: true,
              acceptedQuantityBase: true,
              rejectedQuantityBase: true,
              unitPrice: true,
              orderedUnitPrice: true,
            },
          },
        },
      }),
      tx.purchaseOrderLine.findMany({
        where: {
          organizationId: ctx.organizationId,
          purchaseOrder: { supplierId: supplier.id, status: { in: ["RECEIVED", "CLOSED"] } },
        },
        select: { purchaseOrderId: true, quantityBase: true, receivedQuantityBase: true },
      }),
    ]);
    const byOrder = new Map<string, { orderedBase: Decimal; acceptedBase: Decimal }>();
    for (const l of finished) {
      const o = byOrder.get(l.purchaseOrderId) ?? {
        orderedBase: new Decimal(0),
        acceptedBase: new Decimal(0),
      };
      o.orderedBase = o.orderedBase.plus(dec(l.quantityBase));
      o.acceptedBase = o.acceptedBase.plus(dec(l.receivedQuantityBase));
      byOrder.set(l.purchaseOrderId, o);
    }
    const dateIn = (d: Date, tz: string) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
    const performance = supplierPerformance({
      receipts: receipts.map((r) => {
        const tz = r.warehouse.branch.timeZone ?? ctx.timeZone;
        return {
          receivedOn: dateIn(r.receivedAt, tz),
          expectedOn: r.purchaseOrder.expectedOn?.toISOString().slice(0, 10) ?? null,
          receivedBase: r.lines.reduce(
            (a, l) => a.plus(dec(l.acceptedQuantityBase)).plus(dec(l.rejectedQuantityBase)),
            new Decimal(0),
          ),
          acceptedBase: r.lines.reduce(
            (a, l) => a.plus(dec(l.acceptedQuantityBase)),
            new Decimal(0),
          ),
          rejectedBase: r.lines.reduce(
            (a, l) => a.plus(dec(l.rejectedQuantityBase)),
            new Decimal(0),
          ),
          priceVariance: r.lines.reduce(
            (a, l) =>
              a.plus(
                dec(l.unitPrice).minus(dec(l.orderedUnitPrice)).times(dec(l.acceptedQuantity)),
              ),
            new Decimal(0),
          ),
        };
      }),
      finishedOrders: [...byOrder.values()],
    });
    return { supplier, products, performance };
  });
}
