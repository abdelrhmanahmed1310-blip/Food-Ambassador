import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { findProduct, quantityInBaseUnit } from "@/modules/catalog/service";
import { planConsumptionInTx } from "@/modules/inventory/consumption";
import { loadWarehouse } from "@/modules/inventory/context";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { addShipmentLineInTx, createShipmentInTx } from "@/modules/inventory/shipments";
import { businessDate } from "@/modules/inventory/rules";
import { runIdempotent } from "@/modules/shared/idempotency";
import { idempotencyKeySchema, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import {
  addDraftLineInTx,
  canOnWarehouse,
  createDraftOrderInTx,
  loadWarehouseRef,
  recomputeTotal,
  warehouseScope,
} from "./orders";
import { lockRequisitions, refreshRequisitionStatus } from "./requisition-links";
import { requisitionActions, type RequisitionStatus } from "./rules";
import {
  createRequisitionSchema,
  orderRequisitionSchema,
  reasonSchema,
  requisitionLineSchema,
} from "./schemas";

/**
 * Purchase requisitions (DECISIONS.md ADR-029): a branch asks for goods for
 * one of its warehouses; buyers turn the open lines into draft purchase
 * orders, or reject / close the request. Requesters need
 * `purchasing.request`, buyers `purchasing.manage`, at the warehouse.
 */

export const REQUISITION_PAGE_SIZE = 25;
const dec = (v: { toString(): string }) => new Decimal(v.toString());

type WarehouseRef = Awaited<ReturnType<typeof loadWarehouseRef>>;

const canSee = (ctx: TenantContext, wh: WarehouseRef) =>
  canOnWarehouse(ctx, "purchasing.view", wh) || canOnWarehouse(ctx, "purchasing.request", wh);
const target = (wh: WarehouseRef) => ({ branchId: wh.branchId, warehouseId: wh.id });

async function lockRequisition(tx: Tx, ctx: TenantContext, requisitionId: string) {
  await lockRequisitions(tx, ctx, [requisitionId]);
  const req = await tx.purchaseRequisition.findFirst({
    where: { organizationId: ctx.organizationId, id: requisitionId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!req) throw notFound("Requisition");
  const wh = await loadWarehouseRef(tx, ctx, req.warehouseId);
  if (!canSee(ctx, wh)) throw notFound("Requisition");
  return { ...req, warehouse: wh };
}

function actions(req: {
  status: RequisitionStatus;
  lines: Array<{ purchaseOrderLineId: string | null; shipmentId: string | null }>;
}) {
  return requisitionActions(
    req.status,
    req.lines.filter((l) => l.purchaseOrderLineId || l.shipmentId).length,
  );
}

function requireStatus(ok: boolean, status: string) {
  if (!ok)
    throw businessRuleViolation("REQUISITION_STATUS", "Not possible in the requisition's status", {
      status,
    });
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  req: { id: string; number: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `requisition.${action}`,
    entityType: "requisition",
    entityId: req.id,
    changes: { number: req.number, ...changes },
  });
}

// ─── Requester ───

export async function createRequisition(ctx: TenantContext, rawInput: unknown) {
  const parsed = createRequisitionSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "requisition.create", input },
    async (tx) => {
      const wh = await loadWarehouseRef(tx, ctx, input.warehouseId);
      if (!canSee(ctx, wh)) throw notFound("Warehouse");
      assertPermission(ctx.grants, "purchasing.request", target(wh));
      if (wh.archivedAt || wh.branch.archivedAt)
        throw businessRuleViolation("WAREHOUSE_ARCHIVED", "The warehouse is archived");
      const today = businessDate(wh.branch.timeZone ?? ctx.timeZone);
      const number = await nextDocumentNumber(
        tx,
        ctx.organizationId,
        "REQ",
        Number(today.slice(0, 4)),
      );
      const req = await tx.purchaseRequisition.create({
        data: {
          organizationId: ctx.organizationId,
          number,
          warehouseId: wh.id,
          neededBy: input.neededBy ? new Date(`${input.neededBy}T00:00:00Z`) : null,
          note: input.note,
          createdByUserId: ctx.userId,
        },
        select: { id: true, number: true },
      });
      await audit(tx, ctx, req, "created", { warehouseId: wh.id });
      return req;
    },
  );
}

export async function addRequisitionLine(
  ctx: TenantContext,
  requisitionId: string,
  rawInput: unknown,
) {
  const parsed = requisitionLineSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const req = await lockRequisition(tx, ctx, requisitionId);
      assertPermission(ctx.grants, "purchasing.request", target(req.warehouse));
      requireStatus(actions(req).edit, req.status);
      const product = await findProduct(tx, ctx, input.productId);
      if (product.archivedAt)
        throw businessRuleViolation("PRODUCT_ARCHIVED", "The product is archived");
      const quantityBase = await quantityInBaseUnit(tx, ctx, product, input.uomId, input.quantity);
      const lineNo = (req.lines.at(-1)?.lineNo ?? 0) + 1;
      await tx.purchaseRequisitionLine.create({
        data: {
          organizationId: ctx.organizationId,
          requisitionId: req.id,
          lineNo,
          productId: product.id,
          uomId: input.uomId,
          quantity: input.quantity,
          quantityBase: quantityBase.toFixed(),
          note: input.note,
        },
      });
      await audit(tx, ctx, req, "line_added", {
        lineNo,
        productId: product.id,
        quantity: input.quantity,
        uomId: input.uomId,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "purchase_requisition_lines_organization_id_requisition_id_p_key"))
      throw conflict("This product is already on the requisition", {
        reason: "duplicateProduct",
        field: "productId",
      });
    throw error;
  }
}

export async function removeRequisitionLine(
  ctx: TenantContext,
  requisitionId: string,
  lineId: string,
) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const req = await lockRequisition(tx, ctx, requisitionId);
    assertPermission(ctx.grants, "purchasing.request", target(req.warehouse));
    requireStatus(actions(req).edit, req.status);
    const line = req.lines.find((l) => l.id === lineId);
    if (!line) throw notFound("Requisition line");
    await tx.purchaseRequisitionLine.delete({ where: { id: line.id } });
    await audit(tx, ctx, req, "line_removed", { lineNo: line.lineNo, productId: line.productId });
  });
}

export async function submitRequisition(ctx: TenantContext, requisitionId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const req = await lockRequisition(tx, ctx, requisitionId);
    assertPermission(ctx.grants, "purchasing.request", target(req.warehouse));
    requireStatus(actions(req).edit, req.status);
    if (req.lines.length === 0)
      throw businessRuleViolation("REQUISITION_HAS_NO_LINES", "Add at least one line first");
    await tx.purchaseRequisition.update({
      where: { id: req.id },
      data: { status: "SUBMITTED", submittedAt: new Date(), submittedByUserId: ctx.userId },
    });
    await audit(tx, ctx, req, "submitted", { lines: req.lines.length });
  });
}

export async function cancelRequisition(
  ctx: TenantContext,
  requisitionId: string,
  rawInput: unknown,
) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const req = await lockRequisition(tx, ctx, requisitionId);
    assertPermission(ctx.grants, "purchasing.request", target(req.warehouse));
    requireStatus(actions(req).cancel, req.status);
    await decide(tx, ctx, req, "CANCELLED", parsed.data.reason);
  });
}

// ─── Buyer ───

async function decide(
  tx: Tx,
  ctx: TenantContext,
  req: { id: string; number: string },
  status: "REJECTED" | "CLOSED" | "CANCELLED",
  reason: string,
) {
  await tx.purchaseRequisition.update({
    where: { id: req.id },
    data: { status, decidedAt: new Date(), decidedByUserId: ctx.userId, decisionReason: reason },
  });
  await audit(tx, ctx, req, status.toLowerCase(), { reason });
}

export async function rejectRequisition(
  ctx: TenantContext,
  requisitionId: string,
  rawInput: unknown,
) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const req = await lockRequisition(tx, ctx, requisitionId);
    assertPermission(ctx.grants, "purchasing.manage", target(req.warehouse));
    requireStatus(actions(req).reject, req.status);
    await decide(tx, ctx, req, "REJECTED", parsed.data.reason);
  });
}

/** Close a partly ordered requisition: the remaining lines will not be ordered. */
export async function closeRequisition(
  ctx: TenantContext,
  requisitionId: string,
  rawInput: unknown,
) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const req = await lockRequisition(tx, ctx, requisitionId);
    assertPermission(ctx.grants, "purchasing.manage", target(req.warehouse));
    requireStatus(actions(req).close, req.status);
    await decide(tx, ctx, req, "CLOSED", parsed.data.reason);
  });
}

/**
 * Put selected open lines on one new draft purchase order for a supplier,
 * at the prices the buyer entered, in the requested quantity and unit. The
 * lines are linked to the order lines; the requisition becomes partly or
 * fully ordered.
 */
export async function orderRequisition(
  ctx: TenantContext,
  requisitionId: string,
  rawInput: unknown,
) {
  const parsed = orderRequisitionSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "requisition.order", input: { requisitionId, ...input } },
    async (tx) => {
      const req = await lockRequisition(tx, ctx, requisitionId);
      assertPermission(ctx.grants, "purchasing.manage", target(req.warehouse));
      requireStatus(actions(req).order, req.status);
      const chosen = input.lines.filter((l) => l.include);
      const lines = chosen.map((c) => {
        const index = input.lines.indexOf(c);
        const line = req.lines.find((l) => l.id === c.lineId);
        if (!line) throw notFound("Requisition line");
        if (line.purchaseOrderLineId || line.shipmentId)
          throw businessRuleViolation("REQUISITION_LINE_ORDERED", "This line is already ordered", {
            field: `lines.${index}.include`,
          });
        return { line, unitPrice: c.unitPrice as string };
      });
      const order = await createDraftOrderInTx(tx, ctx, {
        supplierId: input.supplierId,
        warehouseId: req.warehouse.id,
        expectedOn: input.expectedOn,
        note: `Requisition ${req.number}`,
      });
      const orderedAt = new Date();
      let lineNo = 0;
      for (const { line, unitPrice } of lines) {
        const poLine = await addDraftLineInTx(tx, ctx, order, ++lineNo, {
          productId: line.productId,
          quantity: dec(line.quantity).toFixed(),
          uomId: line.uomId,
          unitPrice,
        });
        await tx.purchaseRequisitionLine.update({
          where: { id: line.id },
          data: { purchaseOrderLineId: poLine.id, orderedAt },
        });
      }
      await recomputeTotal(tx, order.id);
      const status = await refreshRequisitionStatus(tx, ctx, req.id);
      await audit(tx, ctx, req, "ordered", {
        purchaseOrderId: order.id,
        purchaseOrderNumber: order.number,
        lines: lines.map((l) => l.line.lineNo),
        status,
      });
      return { orderId: order.id, orderNumber: order.number, status };
    },
  );
}

// ─── Queries ───

function visible(ctx: TenantContext): Prisma.PurchaseRequisitionWhereInput {
  const a = warehouseScope(ctx, "purchasing.view");
  const b = warehouseScope(ctx, "purchasing.request");
  if (Object.keys(a).length === 0 || Object.keys(b).length === 0) return {};
  return { OR: [{ warehouse: a }, { warehouse: b }] };
}

export async function listRequisitions(
  ctx: TenantContext,
  filters: { status?: RequisitionStatus; page?: number } = {},
) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.PurchaseRequisitionWhereInput = {
    organizationId: ctx.organizationId,
    ...visible(ctx),
    ...(filters.status ? { status: filters.status } : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.purchaseRequisition.count({ where }),
      tx.purchaseRequisition.findMany({
        where,
        select: {
          id: true,
          number: true,
          status: true,
          neededBy: true,
          createdAt: true,
          submittedAt: true,
          warehouse: { select: { code: true, name: true } },
          _count: { select: { lines: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * REQUISITION_PAGE_SIZE,
        take: REQUISITION_PAGE_SIZE,
      }),
    ]);
    return {
      items,
      total,
      page,
      pageCount: Math.max(1, Math.ceil(total / REQUISITION_PAGE_SIZE)),
    };
  });
}

/**
 * A requisition with what the user may do. With `supplierId`, open lines
 * carry that supplier's last price when it is quoted in the line's unit —
 * prices in another unit are not converted or guessed.
 */
export async function getRequisition(
  ctx: TenantContext,
  requisitionId: string,
  options: { supplierId?: string } = {},
) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const req = await tx.purchaseRequisition.findFirst({
      where: { organizationId: ctx.organizationId, id: requisitionId },
      include: {
        warehouse: {
          select: {
            id: true,
            code: true,
            name: true,
            branchId: true,
            archivedAt: true,
            branch: { select: { timeZone: true, archivedAt: true } },
          },
        },
        lines: {
          orderBy: { lineNo: "asc" },
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
            uom: { select: { code: true } },
            shipment: { select: { id: true, number: true, status: true } },
            purchaseOrderLine: {
              select: { purchaseOrder: { select: { id: true, number: true, status: true } } },
            },
          },
        },
      },
    });
    if (!req || !canSee(ctx, req.warehouse)) throw notFound("Requisition");
    const userIds = [req.createdByUserId, req.submittedByUserId, req.decidedByUserId].filter(
      (v): v is string => !!v,
    );
    const users = await tx.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const name = (id: string | null) =>
      id ? (users.find((u) => u.id === id)?.name ?? null) : null;
    const prices = options.supplierId
      ? await tx.supplierProduct.findMany({
          where: {
            organizationId: ctx.organizationId,
            supplierId: options.supplierId,
            archivedAt: null,
            productId: { in: req.lines.map((l) => l.productId) },
          },
          select: { productId: true, purchaseUomId: true, lastUnitPrice: true },
        })
      : [];
    const a = actions(req);
    const requester = canOnWarehouse(ctx, "purchasing.request", req.warehouse);
    const buyer = canOnWarehouse(ctx, "purchasing.manage", req.warehouse);
    return {
      ...req,
      lines: req.lines.map((l) => {
        const p = prices.find((x) => x.productId === l.productId && x.purchaseUomId === l.uomId);
        return { ...l, suggestedPrice: p?.lastUnitPrice ? dec(p.lastUnitPrice).toFixed() : null };
      }),
      names: {
        createdBy: name(req.createdByUserId),
        submittedBy: name(req.submittedByUserId),
        decidedBy: name(req.decidedByUserId),
      },
      can: {
        edit: a.edit && requester,
        cancel: a.cancel && requester,
        order: a.order && buyer,
        reject: a.reject && buyer,
        close: a.close && buyer,
      },
    };
  });
}

const fulfilSchema = z.object({
  fromWarehouseId: uuidSchema,
  lineIds: z.array(uuidSchema).min(1, { error: "required" }).max(200),
  idempotencyKey: idempotencyKeySchema,
});

/**
 * Meet selected open lines from own stock (central kitchen, ADR-046): usable
 * stock of the source is picked first-expiring-first into one draft
 * shipment to the requesting warehouse, and the lines are linked to it.
 * Needs `purchasing.manage` for the requesting site and
 * `inventory.transfer` at the source. Nothing is picked if any line is short.
 */
export async function fulfilRequisitionFromStock(
  ctx: TenantContext,
  requisitionId: string,
  rawInput: unknown,
) {
  const parsed = fulfilSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "requisition.fulfil", input: { requisitionId, ...input } },
    async (tx) => {
      const req = await lockRequisition(tx, ctx, requisitionId);
      assertPermission(ctx.grants, "purchasing.manage", target(req.warehouse));
      requireStatus(actions(req).order, req.status);
      if (input.fromWarehouseId === req.warehouse.id)
        throw businessRuleViolation("TRANSFER_SAME_PLACE", "The stock is already there", {
          field: "fromWarehouseId",
        });
      const lines = input.lineIds.map((id) => {
        const line = req.lines.find((l) => l.id === id);
        if (!line) throw notFound("Requisition line");
        if (line.purchaseOrderLineId || line.shipmentId)
          throw businessRuleViolation("REQUISITION_LINE_ORDERED", "This line is already ordered");
        return line;
      });
      const source = await loadWarehouse(tx, ctx, input.fromWarehouseId);
      const usage = new Map<string, Decimal>();
      for (const l of lines)
        usage.set(
          l.productId,
          (usage.get(l.productId) ?? new Decimal(0)).plus(dec(l.quantityBase)),
        );
      const plan = await planConsumptionInTx(tx, ctx, source, usage);
      if (plan.shortages.length > 0) {
        const products = await tx.product.findMany({
          where: {
            organizationId: ctx.organizationId,
            id: { in: plan.shortages.map((s) => s.productId) },
          },
          select: { id: true, sku: true },
        });
        throw businessRuleViolation(
          "INSUFFICIENT_STOCK_FOR_FULFILMENT",
          "Not enough usable stock at the source",
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
      const shipment = await createShipmentInTx(tx, ctx, {
        fromWarehouseId: source.id,
        toWarehouseId: req.warehouse.id,
        note: req.number,
      });
      for (const p of plan.picks)
        await addShipmentLineInTx(tx, ctx, shipment.id, {
          balanceId: p.balanceId,
          quantity: p.quantity.toFixed(),
          uomId: p.uomId,
        });
      const at = new Date();
      await tx.purchaseRequisitionLine.updateMany({
        where: { organizationId: ctx.organizationId, id: { in: lines.map((l) => l.id) } },
        data: { shipmentId: shipment.id, orderedAt: at },
      });
      await refreshRequisitionStatus(tx, ctx, req.id);
      await recordAudit(tx, actorOf(ctx), {
        action: "requisition.fulfilled_from_stock",
        entityType: "purchase_requisition",
        entityId: req.id,
        changes: { number: req.number, shipment: shipment.number, lines: lines.length },
      });
      return { shipmentId: shipment.id, number: shipment.number };
    },
  );
}
