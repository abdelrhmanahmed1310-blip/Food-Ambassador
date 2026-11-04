import "server-only";
import { z } from "zod";
import { isCountryCode } from "@/lib/countries";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import {
  accessibleScope,
  assertPermission,
  hasPermission,
  holdsAnyGrant,
} from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import {
  CONTAINER_TYPES,
  daysLate,
  INCOTERMS,
  isCancellable,
  isEditable,
  isValidContainerNumber,
  NEXT_STATUS,
  normalizeContainerNumber,
  REEFERS,
  SHIPMENT_STATUSES,
  takesReceipts,
  TRANSPORT_MODES,
  type ShipmentStatus,
} from "./rules";

/**
 * Import shipments (DECISIONS.md ADR-113): goods bought abroad travelling
 * to one warehouse — supplier, purchase orders, containers, transport
 * documents, dates — through planned → in transit → arrived → cleared →
 * closed, and the receipts that took them in. Viewing needs `trade.view`
 * at the destination warehouse, changes `trade.manage` there.
 */

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (s: string | undefined | null) => (s ? new Date(`${s}T00:00:00Z`) : null);

const optionalDate = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined))
  .refine((v) => v === undefined || isCalendarDate(v), { error: "invalidDate" });
const optionalCountry = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim().toUpperCase() : undefined))
  .refine((v) => v === undefined || isCountryCode(v), { error: "invalidOption" });
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.literal(""), z.enum(values, { error: "invalidOption" })])
    .optional()
    .transform((v) => (v ? (v as T[number]) : undefined));

const headerSchema = z
  .object({
    mode: z.enum(TRANSPORT_MODES, { error: "invalidOption" }),
    incoterm: optionalEnum(INCOTERMS),
    originCountry: optionalCountry,
    portOfLoading: optionalText(120),
    portOfDischarge: optionalText(120),
    carrier: optionalText(120),
    transportDocument: optionalText(60),
    vesselOrFlight: optionalText(120),
    etd: optionalDate,
    eta: optionalDate,
    note: optionalText(1000),
  })
  .refine((v) => !v.etd || !v.eta || v.eta >= v.etd, { error: "etaBeforeEtd", path: ["eta"] });

const createSchema = headerSchema.and(
  z.object({ supplierId: uuidSchema, warehouseId: uuidSchema }),
);

const containerSchema = z
  .object({
    number: z
      .string({ error: "required" })
      .transform(normalizeContainerNumber)
      .refine(isValidContainerNumber, { error: "invalidContainerNumber" }),
    type: z.enum(CONTAINER_TYPES, { error: "invalidOption" }),
    sealNumber: optionalText(40),
    temperatureC: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined))
      .pipe(decimalString({ maxScale: 1, min: "-60", max: "40", allowNegative: true }).optional()),
  })
  .refine((v) => v.temperatureC === undefined || REEFERS.has(v.type), {
    error: "temperatureReeferOnly",
    path: ["temperatureC"],
  });

const listSchema = z.object({
  status: z
    .union([z.literal(""), z.literal("OPEN"), z.enum(SHIPMENT_STATUSES)])
    .optional()
    .transform((v) => v || undefined),
  supplierId: z
    .string()
    .optional()
    .transform((v) => (v && isUuid(v) ? v : undefined)),
});

export const canSeeShipments = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "trade.view");
export const canManageShipments = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "trade.manage");

function scopeWhere(ctx: TenantContext) {
  const scope = accessibleScope(ctx.grants, "trade.view");
  if (scope.all) return {};
  return {
    OR: [
      { warehouseId: { in: scope.warehouseIds } },
      { warehouse: { branchId: { in: scope.branchIds } } },
    ],
  };
}

const target = (s: { warehouseId: string; warehouse: { branchId: string } }) => ({
  warehouseId: s.warehouseId,
  branchId: s.warehouse.branchId,
});

async function loadShipment(tx: Tx, ctx: TenantContext, shipmentId: string, manage = false) {
  if (!isUuid(shipmentId)) throw notFound("Shipment");
  const s = await tx.importShipment.findFirst({
    where: { organizationId: ctx.organizationId, id: shipmentId },
    include: { warehouse: { select: { branchId: true } } },
  });
  if (!s || !hasPermission(ctx.grants, "trade.view", target(s))) throw notFound("Shipment");
  if (manage && !hasPermission(ctx.grants, "trade.manage", target(s))) throw forbidden();
  return s;
}

function assertStatus(
  s: { status: ShipmentStatus },
  ok: (st: ShipmentStatus) => boolean,
  rule: string,
) {
  if (!ok(s.status))
    throw businessRuleViolation(rule, `Not possible while the shipment is ${s.status}`, {
      status: s.status,
    });
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  action: string,
  changes: Record<string, unknown>,
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `import_shipment.${action}`,
    entityType: "import_shipment",
    entityId: id,
    changes,
  });
}

function headerData(h: z.output<typeof headerSchema>) {
  return {
    mode: h.mode,
    incoterm: h.incoterm ?? null,
    originCountry: h.originCountry ?? null,
    portOfLoading: h.portOfLoading ?? null,
    portOfDischarge: h.portOfDischarge ?? null,
    carrier: h.carrier ?? null,
    transportDocument: h.transportDocument ?? null,
    vesselOrFlight: h.vesselOrFlight ?? null,
    etd: toDate(h.etd),
    eta: toDate(h.eta),
    note: h.note ?? null,
  };
}

export async function createShipment(ctx: TenantContext, rawInput: unknown) {
  if (!canManageShipments(ctx)) throw forbidden();
  const parsed = createSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const warehouse = await tx.warehouse.findFirst({
      where: { organizationId: ctx.organizationId, id: input.warehouseId, archivedAt: null },
      select: { id: true, branchId: true, branch: { select: { companyId: true } } },
    });
    if (
      !warehouse ||
      !hasPermission(ctx.grants, "trade.view", {
        warehouseId: warehouse.id,
        branchId: warehouse.branchId,
      })
    )
      throw notFound("Warehouse");
    assertPermission(ctx.grants, "trade.manage", {
      warehouseId: warehouse.id,
      branchId: warehouse.branchId,
    });
    const supplier = await tx.supplier.findFirst({
      where: { organizationId: ctx.organizationId, id: input.supplierId },
      select: { id: true },
    });
    if (!supplier) throw notFound("Supplier");
    const today = businessDate(ctx.timeZone);
    const number = await nextDocumentNumber(
      tx,
      ctx.organizationId,
      "IMP",
      Number(today.slice(0, 4)),
    );
    const s = await tx.importShipment.create({
      data: {
        organizationId: ctx.organizationId,
        number,
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        companyId: warehouse.branch.companyId,
        ...headerData(input),
        createdByUserId: ctx.userId,
      },
      select: { id: true, number: true },
    });
    await audit(tx, ctx, s.id, "created", {
      number,
      supplierId: supplier.id,
      warehouseId: warehouse.id,
    });
    return s;
  });
}

/** Transport details and expected dates; while planned, in transit or arrived. */
export async function updateShipment(ctx: TenantContext, shipmentId: string, rawInput: unknown) {
  const parsed = headerSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShipment(tx, ctx, shipmentId, true);
    assertStatus(s, isEditable, "SHIPMENT_NOT_EDITABLE");
    const data = headerData(parsed.data);
    await tx.importShipment.update({ where: { id: s.id }, data });
    await audit(tx, ctx, s.id, "updated", {
      ...data,
      etd: parsed.data.etd ?? null,
      eta: parsed.data.eta ?? null,
    });
  });
}

export async function addContainer(ctx: TenantContext, shipmentId: string, rawInput: unknown) {
  const parsed = containerSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const c = parsed.data;
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const s = await loadShipment(tx, ctx, shipmentId, true);
      assertStatus(s, isEditable, "SHIPMENT_NOT_EDITABLE");
      await tx.importShipmentContainer.create({
        data: {
          organizationId: ctx.organizationId,
          shipmentId: s.id,
          number: c.number,
          type: c.type,
          sealNumber: c.sealNumber ?? null,
          temperatureC: c.temperatureC ?? null,
        },
      });
      await audit(tx, ctx, s.id, "container_added", { number: c.number, type: c.type });
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("Container already on this shipment", {
        reason: "containerTaken",
        field: "number",
      });
    throw error;
  }
}

export async function removeContainer(ctx: TenantContext, shipmentId: string, containerId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShipment(tx, ctx, shipmentId, true);
    assertStatus(s, isEditable, "SHIPMENT_NOT_EDITABLE");
    if (!isUuid(containerId)) throw notFound("Container");
    const gone = await tx.importShipmentContainer.deleteMany({
      where: { organizationId: ctx.organizationId, shipmentId: s.id, id: containerId },
    });
    if (!gone.count) throw notFound("Container");
    await audit(tx, ctx, s.id, "container_removed", { containerId });
  });
}

const OPEN_PO = ["APPROVED", "PARTIALLY_RECEIVED"] as const;

/** A purchase order from the shipment's supplier to its warehouse, approved and not fully received. */
export async function linkOrder(ctx: TenantContext, shipmentId: string, rawInput: unknown) {
  const parsed = z.object({ purchaseOrderId: uuidSchema }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const s = await loadShipment(tx, ctx, shipmentId, true);
      assertStatus(s, isEditable, "SHIPMENT_NOT_EDITABLE");
      const po = await tx.purchaseOrder.findFirst({
        where: { organizationId: ctx.organizationId, id: parsed.data.purchaseOrderId },
        select: { id: true, number: true, supplierId: true, warehouseId: true, status: true },
      });
      if (!po) throw notFound("PurchaseOrder");
      if (po.supplierId !== s.supplierId || po.warehouseId !== s.warehouseId)
        throw businessRuleViolation(
          "ORDER_OTHER_SUPPLIER_OR_WAREHOUSE",
          "The order is for another supplier or warehouse",
          {
            field: "purchaseOrderId",
          },
        );
      if (!(OPEN_PO as readonly string[]).includes(po.status))
        throw businessRuleViolation(
          "ORDER_NOT_OPEN",
          "Only approved orders still to be received can travel",
          {
            field: "purchaseOrderId",
          },
        );
      await tx.importShipmentOrder.create({
        data: { organizationId: ctx.organizationId, shipmentId: s.id, purchaseOrderId: po.id },
      });
      await audit(tx, ctx, s.id, "order_linked", { purchaseOrderId: po.id, number: po.number });
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("The order is already on this shipment", {
        reason: "orderTaken",
        field: "purchaseOrderId",
      });
    throw error;
  }
}

export async function unlinkOrder(ctx: TenantContext, shipmentId: string, purchaseOrderId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShipment(tx, ctx, shipmentId, true);
    assertStatus(s, isEditable, "SHIPMENT_NOT_EDITABLE");
    if (!isUuid(purchaseOrderId)) throw notFound("PurchaseOrder");
    const linked = await tx.goodsReceipt.count({
      where: { organizationId: ctx.organizationId, importShipmentId: s.id, purchaseOrderId },
    });
    if (linked)
      throw businessRuleViolation(
        "ORDER_HAS_SHIPMENT_RECEIPTS",
        "Receipts of this order are linked to the shipment",
      );
    const gone = await tx.importShipmentOrder.deleteMany({
      where: { organizationId: ctx.organizationId, shipmentId: s.id, purchaseOrderId },
    });
    if (!gone.count) throw notFound("PurchaseOrder");
    await audit(tx, ctx, s.id, "order_unlinked", { purchaseOrderId });
  });
}

const advanceSchema = z.object({
  date: optionalDate,
});

/**
 * The next step: departed, arrived, cleared (each on a date, today by
 * default, never in the future nor before the previous step) or closed.
 */
export async function advanceShipment(
  ctx: TenantContext,
  shipmentId: string,
  rawInput: unknown = {},
) {
  const parsed = advanceSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShipment(tx, ctx, shipmentId, true);
    const next = NEXT_STATUS[s.status];
    if (!next) assertStatus(s, () => false, "SHIPMENT_NOT_ADVANCEABLE");
    const today = businessDate(ctx.timeZone);
    const date = parsed.data.date ?? today;
    if (date > today)
      throw businessRuleViolation("DATE_IN_FUTURE", "The date is in the future", { field: "date" });
    const previous = day(
      s.status === "IN_TRANSIT" ? s.departedOn : s.status === "ARRIVED" ? s.arrivedOn : null,
    );
    if (previous && date < previous)
      throw businessRuleViolation(
        "DATE_BEFORE_PREVIOUS_STEP",
        "The date is before the previous step",
        { field: "date" },
      );
    const data =
      next === "IN_TRANSIT"
        ? { departedOn: toDate(date) }
        : next === "ARRIVED"
          ? { arrivedOn: toDate(date) }
          : next === "CLEARED"
            ? { clearedOn: toDate(date) }
            : { closedAt: new Date() };
    if (next === "IN_TRANSIT") {
      const orders = await tx.importShipmentOrder.count({
        where: { organizationId: ctx.organizationId, shipmentId: s.id },
      });
      if (!orders)
        throw businessRuleViolation("SHIPMENT_HAS_NO_ORDERS", "Add the purchase orders first");
    }
    const moved = await tx.importShipment.updateMany({
      where: { organizationId: ctx.organizationId, id: s.id, status: s.status },
      data: { status: next, ...data },
    });
    if (!moved.count) throw conflict("The shipment changed meanwhile");
    await audit(tx, ctx, s.id, "advanced", {
      from: s.status,
      to: next,
      date: next === "CLOSED" ? today : date,
    });
  });
}

export async function cancelShipment(ctx: TenantContext, shipmentId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(500) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShipment(tx, ctx, shipmentId, true);
    assertStatus(s, isCancellable, "SHIPMENT_NOT_CANCELLABLE");
    const moved = await tx.importShipment.updateMany({
      where: { organizationId: ctx.organizationId, id: s.id, status: s.status },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: parsed.data.reason },
    });
    if (!moved.count) throw conflict("The shipment changed meanwhile");
    await audit(tx, ctx, s.id, "cancelled", { reason: parsed.data.reason });
  });
}

/** A posted receipt of one of the shipment's orders took its goods in (after arrival). */
export async function linkReceipt(ctx: TenantContext, shipmentId: string, rawInput: unknown) {
  const parsed = z.object({ receiptId: uuidSchema }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const s = await loadShipment(tx, ctx, shipmentId, true);
    assertStatus(s, takesReceipts, "SHIPMENT_NOT_ARRIVED");
    const r = await tx.goodsReceipt.findFirst({
      where: { organizationId: ctx.organizationId, id: parsed.data.receiptId },
      select: {
        id: true,
        number: true,
        status: true,
        purchaseOrderId: true,
        importShipmentId: true,
      },
    });
    if (!r) throw notFound("Receipt");
    const onShipment = await tx.importShipmentOrder.count({
      where: {
        organizationId: ctx.organizationId,
        shipmentId: s.id,
        purchaseOrderId: r.purchaseOrderId,
      },
    });
    if (!onShipment)
      throw businessRuleViolation(
        "RECEIPT_ORDER_NOT_ON_SHIPMENT",
        "The receipt is for an order not on this shipment",
        {
          field: "receiptId",
        },
      );
    if (r.status !== "POSTED")
      throw businessRuleViolation("RECEIPT_REVERSED", "The receipt was reversed", {
        field: "receiptId",
      });
    if (r.importShipmentId && r.importShipmentId !== s.id)
      throw businessRuleViolation(
        "RECEIPT_ON_OTHER_SHIPMENT",
        "The receipt is linked to another shipment",
        {
          field: "receiptId",
        },
      );
    await tx.goodsReceipt.update({ where: { id: r.id }, data: { importShipmentId: s.id } });
    await audit(tx, ctx, s.id, "receipt_linked", { receiptId: r.id, number: r.number });
  });
}

export async function listShipments(ctx: TenantContext, rawFilters: unknown = {}) {
  if (!canSeeShipments(ctx)) throw forbidden();
  const f = listSchema.parse(rawFilters);
  const today = businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.importShipment.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...scopeWhere(ctx),
        ...(f.status === "OPEN"
          ? { status: { in: ["PLANNED", "IN_TRANSIT", "ARRIVED", "CLEARED"] } }
          : f.status
            ? { status: f.status }
            : {}),
        ...(f.supplierId ? { supplierId: f.supplierId } : {}),
      },
      include: {
        supplier: { select: { code: true, name: true } },
        warehouse: { select: { code: true, name: true } },
        _count: { select: { containers: true, orders: true } },
      },
      orderBy: [{ eta: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: 500,
    });
    return rows.map((s) => ({
      ...s,
      etd: day(s.etd),
      eta: day(s.eta),
      daysLate: daysLate({ status: s.status, eta: day(s.eta) }, today),
    }));
  });
}

export async function getShipment(ctx: TenantContext, shipmentId: string) {
  const today = businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const base = await loadShipment(tx, ctx, shipmentId);
    const s = await tx.importShipment.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, id: base.id },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        warehouse: { select: { id: true, code: true, name: true, branchId: true } },
        company: { select: { code: true, name: true } },
        containers: { orderBy: { createdAt: "asc" } },
        orders: {
          orderBy: { createdAt: "asc" },
          include: {
            purchaseOrder: {
              select: {
                id: true,
                number: true,
                status: true,
                currency: true,
                totalAmount: true,
                lines: { select: { quantityBase: true, receivedQuantityBase: true } },
              },
            },
          },
        },
        receipts: {
          select: { id: true, number: true, status: true, purchaseOrderId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    const orderIds = s.orders.map((o) => o.purchaseOrderId);
    // Posted receipts of its orders not yet linked to any shipment.
    const linkable = orderIds.length
      ? await tx.goodsReceipt.findMany({
          where: {
            organizationId: ctx.organizationId,
            purchaseOrderId: { in: orderIds },
            status: "POSTED",
            importShipmentId: null,
          },
          select: { id: true, number: true },
          orderBy: { createdAt: "asc" },
        })
      : [];
    const openOrders = isEditable(s.status)
      ? await tx.purchaseOrder.findMany({
          where: {
            organizationId: ctx.organizationId,
            supplierId: s.supplierId,
            warehouseId: s.warehouseId,
            status: { in: [...OPEN_PO] },
            id: { notIn: orderIds },
          },
          select: { id: true, number: true },
          orderBy: { number: "asc" },
        })
      : [];
    const manage = hasPermission(ctx.grants, "trade.manage", target(s));
    return {
      ...s,
      etd: day(s.etd),
      eta: day(s.eta),
      departedOn: day(s.departedOn),
      arrivedOn: day(s.arrivedOn),
      clearedOn: day(s.clearedOn),
      daysLate: daysLate({ status: s.status, eta: day(s.eta) }, today),
      orders: s.orders.map((o) => {
        const ordered = o.purchaseOrder.lines.reduce(
          (a, l) => a.plus(l.quantityBase.toString()),
          new Decimal(0),
        );
        const received = o.purchaseOrder.lines.reduce(
          (a, l) => a.plus(l.receivedQuantityBase.toString()),
          new Decimal(0),
        );
        return {
          ...o.purchaseOrder,
          receivedShare: ordered.isZero() ? null : received.div(ordered),
        };
      }),
      linkableReceipts: manage && takesReceipts(s.status) ? linkable : [],
      openOrders: manage ? openOrders : [],
      next: NEXT_STATUS[s.status] ?? null,
      canManage: manage,
      canEdit: manage && isEditable(s.status),
      canCancel: manage && isCancellable(s.status),
    };
  });
}

/** Suppliers and the warehouses the user may ship to. */
export async function shipmentFormOptions(ctx: TenantContext) {
  if (!canManageShipments(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [suppliers, warehouses] = await Promise.all([
      tx.supplier.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
      tx.warehouse.findMany({
        where: { organizationId: ctx.organizationId, archivedAt: null },
        select: { id: true, code: true, name: true, branchId: true },
        orderBy: { code: "asc" },
      }),
    ]);
    return {
      suppliers,
      warehouses: warehouses.filter((w) =>
        hasPermission(ctx.grants, "trade.manage", { warehouseId: w.id, branchId: w.branchId }),
      ),
    };
  });
}
