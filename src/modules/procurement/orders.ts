import "server-only";
import { emitEvent } from "@/modules/integrations/service";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal, toDecimal } from "@/lib/decimal";
import { accessibleScope, assertPermission, hasPermission } from "@/modules/access/authorize";
import type { Permission } from "@/modules/access/permissions";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { findProduct, quantityInBaseUnit } from "@/modules/catalog/service";
import { nextDocumentNumber } from "@/modules/inventory/posting";
import { businessDate } from "@/modules/inventory/rules";
import { runIdempotent } from "@/modules/shared/idempotency";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { inSequence, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { releaseRequisitionLines } from "./requisition-links";
import {
  PO_STATUSES,
  approvalChain,
  approvalOutcome,
  holdsApprovalLevel,
  isCancellable,
  isClosable,
  isEditable,
  isReceivable,
  lineTotal,
  nextApprovalLevel,
  openQuantity,
  type ApprovalLevel,
  type PoStatus,
} from "./rules";
import { createOrderSchema, orderHeaderSchema, orderLineSchema, reasonSchema } from "./schemas";
import { loadRules } from "./settings";
import { loadSupplier } from "./suppliers";

export const ORDER_PAGE_SIZE = 25;
const dec = (v: { toString(): string }) => new Decimal(v.toString());

/** Warehouses where the user holds `permission`, as a Prisma filter. */
export function warehouseScope(
  ctx: TenantContext,
  permission: Permission,
): Prisma.WarehouseWhereInput {
  const scope = accessibleScope(ctx.grants, permission);
  if (scope.all) return {};
  return { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }] };
}

interface WarehouseRef {
  id: string;
  branchId: string;
  archivedAt: Date | null;
  branch: { timeZone: string | null; archivedAt: Date | null };
}

const target = (w: { id: string; branchId: string }) => ({
  branchId: w.branchId,
  warehouseId: w.id,
});

export function canOnWarehouse(ctx: TenantContext, permission: Permission, w: WarehouseRef) {
  return hasPermission(ctx.grants, permission, target(w));
}

export async function loadWarehouseRef(tx: Tx, ctx: TenantContext, warehouseId: string) {
  const wh = await tx.warehouse.findFirst({
    where: { organizationId: ctx.organizationId, id: warehouseId },
    select: {
      id: true,
      branchId: true,
      archivedAt: true,
      branch: { select: { timeZone: true, archivedAt: true } },
    },
  });
  if (!wh) throw notFound("Warehouse");
  return wh;
}

/**
 * Lock the order row for the rest of the transaction (all state changes and
 * receipts serialize on it), then load it. Orders outside the user's
 * purchasing scope are reported as not found.
 */
export async function lockOrder(tx: Tx, ctx: TenantContext, orderId: string) {
  await tx.$queryRaw`
    SELECT "id" FROM "purchase_orders"
    WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${orderId}::uuid
    FOR UPDATE`;
  const order = await tx.purchaseOrder.findFirst({
    where: { organizationId: ctx.organizationId, id: orderId },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      warehouse: {
        select: {
          id: true,
          branchId: true,
          archivedAt: true,
          branch: { select: { timeZone: true, archivedAt: true } },
        },
      },
    },
  });
  if (!order || !canOnWarehouse(ctx, "purchasing.view", order.warehouse))
    throw notFound("Purchase order");
  return order;
}

type LockedOrder = Awaited<ReturnType<typeof lockOrder>>;

function requireOn(ctx: TenantContext, permission: Permission, order: LockedOrder) {
  assertPermission(ctx.grants, permission, target(order.warehouse));
}

function requireStatus(order: LockedOrder, ok: boolean) {
  if (!ok)
    throw businessRuleViolation(
      "ORDER_STATUS",
      "This action is not possible for the order's status",
      {
        status: order.status,
      },
    );
}

export async function recomputeTotal(tx: Tx, orderId: string) {
  const lines = await tx.purchaseOrderLine.findMany({
    where: { purchaseOrderId: orderId },
    select: { lineTotal: true },
  });
  const total = lines.reduce((a, l) => a.plus(dec(l.lineTotal)), new Decimal(0));
  await tx.purchaseOrder.update({ where: { id: orderId }, data: { totalAmount: total.toFixed() } });
  return total;
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  order: { id: string; number: string },
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `purchase_order.${action}`,
    entityType: "purchase_order",
    entityId: order.id,
    changes: { number: order.number, ...changes },
  });
}

// ─── Queries ───

export interface OrderFilters {
  status?: PoStatus;
  supplierId?: string;
  warehouseId?: string;
  q?: string;
  page?: number;
}

export async function listOrders(ctx: TenantContext, filters: OrderFilters = {}) {
  const page = Math.max(1, filters.page ?? 1);
  const q = filters.q?.trim();
  const where: Prisma.PurchaseOrderWhereInput = {
    organizationId: ctx.organizationId,
    warehouse: warehouseScope(ctx, "purchasing.view"),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
    ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    ...(q
      ? {
          OR: [
            { number: { contains: q, mode: "insensitive" } },
            { supplier: { name: { contains: q, mode: "insensitive" } } },
            { supplier: { code: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [total, items] = await inSequence([
      tx.purchaseOrder.count({ where }),
      tx.purchaseOrder.findMany({
        where,
        select: {
          id: true,
          number: true,
          status: true,
          expectedOn: true,
          totalAmount: true,
          currency: true,
          createdAt: true,
          supplier: { select: { id: true, code: true, name: true, nameAr: true } },
          warehouse: { select: { id: true, code: true } },
          _count: { select: { lines: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * ORDER_PAGE_SIZE,
        take: ORDER_PAGE_SIZE,
      }),
    ]);
    return { items, total, page, pageCount: Math.max(1, Math.ceil(total / ORDER_PAGE_SIZE)) };
  });
}

/** Counts by status for the purchasing overview. */
export async function orderStatusCounts(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const groups = await tx.purchaseOrder.groupBy({
      by: ["status"],
      where: {
        organizationId: ctx.organizationId,
        warehouse: warehouseScope(ctx, "purchasing.view"),
      },
      _count: { _all: true },
    });
    return Object.fromEntries(
      PO_STATUSES.map((s) => [s, groups.find((g) => g.status === s)?._count._all ?? 0]),
    ) as Record<PoStatus, number>;
  });
}

export async function getOrder(ctx: TenantContext, orderId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const order = await tx.purchaseOrder.findFirst({
      where: { organizationId: ctx.organizationId, id: orderId },
      include: {
        supplier: { select: { id: true, code: true, name: true, nameAr: true, archivedAt: true } },
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
                lotTracking: true,
                storageRequirement: true,
                baseUom: { select: { code: true } },
              },
            },
            uom: { select: { id: true, code: true } },
          },
        },
        receipts: {
          orderBy: { receivedAt: "desc" },
          select: { id: true, number: true, status: true, receivedAt: true },
        },
        approvals: {
          orderBy: [{ round: "desc" }, { step: "asc" }],
          select: {
            round: true,
            step: true,
            level: true,
            approvedByUserId: true,
            approvedAt: true,
          },
        },
      },
    });
    if (!order || !canOnWarehouse(ctx, "purchasing.view", order.warehouse))
      throw notFound("Purchase order");
    const userIds = [
      order.createdByUserId,
      order.submittedByUserId,
      order.approvedByUserId,
      order.closedByUserId,
      ...order.approvals.map((a) => a.approvedByUserId),
    ].filter((v): v is string => !!v);
    const users = await tx.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const name = (id: string | null) =>
      id ? (users.find((u) => u.id === id)?.name ?? null) : null;
    const status = order.status as PoStatus;
    const on = (p: Permission) => canOnWarehouse(ctx, p, order.warehouse);
    const postedReceipts = order.receipts.filter((r) => r.status === "POSTED").length;
    // Steps of the round shown: the current submission, or the one that approved it.
    const round = order.approvals.filter((a) => a.round === order.approvalRound);
    const block =
      status === "PENDING_APPROVAL" && on("purchasing.approve")
        ? approvalBlock(
            ctx,
            order,
            round.map((a) => a.approvedByUserId),
          )
        : null;
    const chain = order.approvalRound > 0 && !order.autoApproved ? chainOf(order) : [];
    return {
      ...order,
      lines: order.lines.map((l) => {
        const open = openQuantity(dec(l.quantityBase), dec(l.receivedQuantityBase));
        // The same quantities in the order line's unit, for display and receipt defaults.
        const inOrderUnit = (base: Decimal) =>
          base.times(dec(l.quantity)).dividedBy(dec(l.quantityBase)).toDecimalPlaces(6);
        return {
          ...l,
          openQuantityBase: open,
          receivedQuantityInUnit: inOrderUnit(dec(l.receivedQuantityBase)),
          openQuantityInUnit: inOrderUnit(open),
        };
      }),
      names: {
        createdBy: name(order.createdByUserId),
        submittedBy: name(order.submittedByUserId),
        approvedBy: name(order.approvedByUserId),
        closedBy: name(order.closedByUserId),
      },
      approvalSteps: chain.map((level, i) => {
        const signed = round.find((a) => a.step === i + 1);
        return {
          step: i + 1,
          level,
          signedBy: signed ? name(signed.approvedByUserId) : null,
          signedAt: signed?.approvedAt ?? null,
          current: status === "PENDING_APPROVAL" && order.approvalsGiven === i,
        };
      }),
      can: {
        edit: isEditable(status) && on("purchasing.manage"),
        submit: isEditable(status) && order.lines.length > 0 && on("purchasing.manage"),
        approve: status === "PENDING_APPROVAL" && on("purchasing.approve") && block === null,
        reject:
          status === "PENDING_APPROVAL" &&
          holdsApprovalLevel(ctx.grants, order.pendingApprovalLevel ?? "ANY", site(order)),
        receive: isReceivable(status) && on("purchasing.receive"),
        close: isClosable(status) && on("purchasing.manage"),
        cancel: isCancellable(status, postedReceipts > 0) && on("purchasing.manage"),
      },
      /** Why an approver cannot sign the current step (own order, already signed, other level). */
      approvalBlocked: block,
    };
  });
}

// ─── Draft ───

/**
 * Create a draft order inside the caller's transaction (manual creation and
 * orders generated from reorder suggestions share it).
 */
export async function createDraftOrderInTx(
  tx: Tx,
  ctx: TenantContext,
  input: { supplierId: string; warehouseId: string; expectedOn?: string; note?: string },
) {
  const wh = await loadWarehouseRef(tx, ctx, input.warehouseId);
  if (!canOnWarehouse(ctx, "purchasing.view", wh)) throw notFound("Warehouse");
  assertPermission(ctx.grants, "purchasing.manage", target(wh));
  if (wh.archivedAt || wh.branch.archivedAt)
    throw businessRuleViolation("WAREHOUSE_ARCHIVED", "The warehouse is archived");
  const supplier = await loadSupplier(tx, ctx, input.supplierId);
  if (supplier.archivedAt)
    throw businessRuleViolation("SUPPLIER_ARCHIVED", "The supplier is archived");
  const today = businessDate(wh.branch.timeZone ?? ctx.timeZone);
  const number = await nextDocumentNumber(tx, ctx.organizationId, "PO", Number(today.slice(0, 4)));
  const order = await tx.purchaseOrder.create({
    data: {
      organizationId: ctx.organizationId,
      number,
      supplierId: supplier.id,
      warehouseId: wh.id,
      currency: ctx.baseCurrency,
      expectedOn: input.expectedOn ? new Date(`${input.expectedOn}T00:00:00Z`) : null,
      note: input.note,
      createdByUserId: ctx.userId,
    },
    select: { id: true, number: true },
  });
  await audit(tx, ctx, order, "created", { supplierId: supplier.id, warehouseId: wh.id });
  return order;
}

/** Add a line to a draft order created in the same transaction. */
export async function addDraftLineInTx(
  tx: Tx,
  ctx: TenantContext,
  order: { id: string; number: string },
  lineNo: number,
  rawLine: unknown,
) {
  const { data } = await lineValues(tx, ctx, rawLine);
  const line = await tx.purchaseOrderLine.create({
    data: { ...data, organizationId: ctx.organizationId, purchaseOrderId: order.id, lineNo },
    select: { id: true },
  });
  await audit(tx, ctx, order, "line_added", data);
  return line;
}

export async function createOrder(ctx: TenantContext, rawInput: unknown) {
  const parsed = createOrderSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { idempotencyKey, ...input } = parsed.data;
  return runIdempotent(
    ctx,
    { key: idempotencyKey, operation: "purchase_order.create", input },
    async (tx) => {
      const order = await createDraftOrderInTx(tx, ctx, input);
      return { id: order.id, number: order.number };
    },
  );
}

export async function updateOrderHeader(ctx: TenantContext, orderId: string, rawInput: unknown) {
  const parsed = orderHeaderSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireOn(ctx, "purchasing.manage", order);
    requireStatus(order, isEditable(order.status));
    if (input.warehouseId !== order.warehouseId) {
      const wh = await loadWarehouseRef(tx, ctx, input.warehouseId);
      if (!canOnWarehouse(ctx, "purchasing.view", wh)) throw notFound("Warehouse");
      assertPermission(ctx.grants, "purchasing.manage", target(wh));
      if (wh.archivedAt || wh.branch.archivedAt)
        throw businessRuleViolation("WAREHOUSE_ARCHIVED", "The warehouse is archived");
    }
    if (input.supplierId !== order.supplierId) {
      const supplier = await loadSupplier(tx, ctx, input.supplierId);
      if (supplier.archivedAt)
        throw businessRuleViolation("SUPPLIER_ARCHIVED", "The supplier is archived");
    }
    const data = {
      supplierId: input.supplierId,
      warehouseId: input.warehouseId,
      expectedOn: input.expectedOn ? new Date(`${input.expectedOn}T00:00:00Z`) : null,
      note: input.note ?? null,
    };
    await tx.purchaseOrder.update({ where: { id: order.id }, data });
    await audit(tx, ctx, order, "updated", { ...input });
  });
}

async function lineValues(tx: Tx, ctx: TenantContext, raw: unknown) {
  const parsed = orderLineSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  assertPermission(ctx.grants, "catalog.view");
  const product = await findProduct(tx, ctx, input.productId);
  if (product.archivedAt)
    throw businessRuleViolation("PRODUCT_ARCHIVED", "The product is archived");
  const quantityBase = await quantityInBaseUnit(tx, ctx, product, input.uomId, input.quantity);
  return {
    input,
    data: {
      productId: product.id,
      uomId: input.uomId,
      quantity: input.quantity,
      quantityBase: quantityBase.toFixed(),
      unitPrice: input.unitPrice,
      lineTotal: lineTotal(toDecimal(input.quantity), toDecimal(input.unitPrice)).toFixed(),
      note: input.note ?? null,
    },
  };
}

const productAlreadyOnOrder = () =>
  conflict("This product is already on the order", {
    field: "productId",
    reason: "productAlreadyOnOrder",
  });

/** A concurrent edit can still hit the unique key; report it the same way. */
function duplicateProduct(error: unknown): never {
  if (isUniqueViolation(error, "purchase_order_lines_organization_id_purchase_order_id_prod_key"))
    throw productAlreadyOnOrder();
  throw error;
}

export async function addOrderLine(ctx: TenantContext, orderId: string, rawInput: unknown) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireOn(ctx, "purchasing.manage", order);
    requireStatus(order, isEditable(order.status));
    const { data } = await lineValues(tx, ctx, rawInput);
    if (order.lines.some((l) => l.productId === data.productId)) throw productAlreadyOnOrder();
    const lineNo = order.lines.reduce((m, l) => Math.max(m, l.lineNo), 0) + 1;
    const line = await tx.purchaseOrderLine
      .create({
        data: { ...data, organizationId: ctx.organizationId, purchaseOrderId: order.id, lineNo },
        select: { id: true },
      })
      .catch(duplicateProduct);
    const total = await recomputeTotal(tx, order.id);
    await audit(tx, ctx, order, "line_added", { ...data, total: total.toFixed() });
    return line;
  });
}

export async function updateOrderLine(
  ctx: TenantContext,
  orderId: string,
  lineId: string,
  rawInput: unknown,
) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireOn(ctx, "purchasing.manage", order);
    requireStatus(order, isEditable(order.status));
    const existing = order.lines.find((l) => l.id === lineId);
    if (!existing) throw notFound("Order line");
    const { data } = await lineValues(tx, ctx, rawInput);
    if (order.lines.some((l) => l.id !== existing.id && l.productId === data.productId))
      throw productAlreadyOnOrder();
    await tx.purchaseOrderLine.update({ where: { id: existing.id }, data }).catch(duplicateProduct);
    const total = await recomputeTotal(tx, order.id);
    await audit(tx, ctx, order, "line_updated", {
      lineNo: existing.lineNo,
      ...data,
      total: total.toFixed(),
    });
  });
}

export async function removeOrderLine(ctx: TenantContext, orderId: string, lineId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireOn(ctx, "purchasing.manage", order);
    requireStatus(order, isEditable(order.status));
    const existing = order.lines.find((l) => l.id === lineId);
    if (!existing) throw notFound("Order line");
    await releaseRequisitionLines(tx, ctx, [existing.id]);
    await tx.purchaseOrderLine.delete({ where: { id: existing.id } });
    const total = await recomputeTotal(tx, order.id);
    await audit(tx, ctx, order, "line_removed", {
      lineNo: existing.lineNo,
      productId: existing.productId,
      total: total.toFixed(),
    });
  });
}

// ─── Approval workflow ───

/**
 * Submit a draft. With no approval threshold, or a total at or below it, the
 * order is approved at once; otherwise it enters the approval chain fixed
 * now from the settings (ADR-049): branch steps, then head office.
 */
export async function submitOrder(ctx: TenantContext, orderId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireOn(ctx, "purchasing.manage", order);
    requireStatus(order, isEditable(order.status));
    if (order.lines.length === 0)
      throw businessRuleViolation("ORDER_HAS_NO_LINES", "Add at least one line first");
    const supplier = await loadSupplier(tx, ctx, order.supplierId);
    if (supplier.archivedAt)
      throw businessRuleViolation("SUPPLIER_ARCHIVED", "The supplier is archived");
    const rules = await loadRules(tx, ctx);
    const total = dec(order.totalAmount);
    const outcome = approvalOutcome(total, rules.approvalThreshold);
    const chain = approvalChain(rules);
    const now = new Date();
    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: {
        submittedAt: now,
        submittedByUserId: ctx.userId,
        rejectionNote: null,
        approvalRound: { increment: 1 },
        approvalsGiven: 0,
        ...(outcome === "AUTO_APPROVED"
          ? {
              status: "APPROVED",
              approvedAt: now,
              approvedByUserId: ctx.userId,
              autoApproved: true,
              branchApprovalsRequired: 0,
              headOfficeApprovalRequired: false,
              pendingApprovalLevel: null,
            }
          : {
              status: "PENDING_APPROVAL",
              branchApprovalsRequired: chain.filter((l) => l === "BRANCH").length,
              headOfficeApprovalRequired: chain.includes("HEAD_OFFICE"),
              pendingApprovalLevel: chain[0],
            }),
      },
    });
    await audit(tx, ctx, order, "submitted", {
      total: total.toFixed(),
      threshold: rules.approvalThreshold?.toFixed() ?? null,
      outcome,
      ...(outcome === "AUTO_APPROVED" ? {} : { chain }),
    });
    if (outcome === "AUTO_APPROVED")
      await emitEvent(tx, ctx, "purchase_order.approved", order.id, orderEvent(order, total));
    return { status: outcome === "AUTO_APPROVED" ? "APPROVED" : "PENDING_APPROVAL" };
  });
}

/** Outbound webhook payload (ADR-048): identifiers and totals only. */
function orderEvent(
  order: { id: string; number: string; supplierId: string; warehouseId: string },
  total: Decimal,
) {
  return {
    orderId: order.id,
    number: order.number,
    supplierId: order.supplierId,
    warehouseId: order.warehouseId,
    total: total.toFixed(),
  };
}

/** The chain an order was submitted with (ADR-049). */
function chainOf(order: {
  branchApprovalsRequired: number;
  headOfficeApprovalRequired: boolean;
}): ApprovalLevel[] {
  return approvalChain({
    branchApprovalSteps: order.branchApprovalsRequired,
    headOfficeApproval: order.headOfficeApprovalRequired,
  });
}

const site = (order: { warehouseId: string; warehouse: { branchId: string } }) => ({
  branchId: order.warehouse.branchId,
  warehouseId: order.warehouseId,
});

/**
 * Why this user cannot sign the order's next step, or null if they can:
 * they created or submitted it, already signed this round, or do not hold
 * the step's level for the order's site.
 */
function approvalBlock(
  ctx: TenantContext,
  order: {
    createdByUserId: string;
    submittedByUserId: string | null;
    pendingApprovalLevel: ApprovalLevel | null;
    warehouseId: string;
    warehouse: { branchId: string };
  },
  signedThisRound: readonly string[],
): "SELF" | "ALREADY_SIGNED" | "LEVEL" | null {
  if (order.createdByUserId === ctx.userId || order.submittedByUserId === ctx.userId) return "SELF";
  if (signedThisRound.includes(ctx.userId)) return "ALREADY_SIGNED";
  const level = order.pendingApprovalLevel ?? "ANY";
  return holdsApprovalLevel(ctx.grants, level, site(order)) ? null : "LEVEL";
}

/**
 * Sign the next approval step of a pending order. Each step is a different
 * person, never its author; the last step approves the order.
 */
export async function approveOrder(ctx: TenantContext, orderId: string) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireOn(ctx, "purchasing.approve", order);
    requireStatus(order, order.status === "PENDING_APPROVAL");
    const signed = await tx.purchaseOrderApproval.findMany({
      where: {
        organizationId: ctx.organizationId,
        purchaseOrderId: order.id,
        round: order.approvalRound,
      },
      select: { approvedByUserId: true },
    });
    const block = approvalBlock(
      ctx,
      order,
      signed.map((a) => a.approvedByUserId),
    );
    const level = order.pendingApprovalLevel ?? "ANY";
    if (block === "SELF")
      throw businessRuleViolation(
        "SELF_APPROVAL_NOT_ALLOWED",
        "Orders must be approved by someone other than their author",
      );
    if (block === "ALREADY_SIGNED")
      throw businessRuleViolation(
        "APPROVAL_ALREADY_SIGNED",
        "Each approval step needs a different person",
      );
    if (block === "LEVEL")
      throw businessRuleViolation("APPROVAL_LEVEL_REQUIRED", "This step needs another approver", {
        level,
      });
    const chain = chainOf(order);
    const step = order.approvalsGiven + 1;
    const now = new Date();
    await tx.purchaseOrderApproval.create({
      data: {
        organizationId: ctx.organizationId,
        purchaseOrderId: order.id,
        round: order.approvalRound,
        step,
        level,
        approvedByUserId: ctx.userId,
        approvedAt: now,
      },
    });
    const next = nextApprovalLevel(chain, step);
    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: next
        ? { approvalsGiven: step, pendingApprovalLevel: next }
        : {
            approvalsGiven: step,
            pendingApprovalLevel: null,
            status: "APPROVED",
            approvedAt: now,
            approvedByUserId: ctx.userId,
            autoApproved: false,
          },
    });
    await audit(tx, ctx, order, next ? "approval_step_signed" : "approved", {
      step,
      of: chain.length,
      level,
      total: dec(order.totalAmount).toFixed(),
    });
    if (!next)
      await emitEvent(
        tx,
        ctx,
        "purchase_order.approved",
        order.id,
        orderEvent(order, dec(order.totalAmount)),
      );
    return { status: next ? "PENDING_APPROVAL" : "APPROVED", step, of: chain.length };
  });
}

/** Send a pending order back to draft with the approver's reason. */
export async function rejectOrder(ctx: TenantContext, orderId: string, rawInput: unknown) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireOn(ctx, "purchasing.approve", order);
    requireStatus(order, order.status === "PENDING_APPROVAL");
    // Whoever may sign the current step may send the order back instead.
    const level = order.pendingApprovalLevel ?? "ANY";
    if (!holdsApprovalLevel(ctx.grants, level, site(order)))
      throw businessRuleViolation("APPROVAL_LEVEL_REQUIRED", "This step needs another approver", {
        level,
      });
    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: {
        status: "DRAFT",
        rejectionNote: parsed.data.reason,
        submittedAt: null,
        submittedByUserId: null,
        pendingApprovalLevel: null,
        approvalsGiven: 0,
      },
    });
    await audit(tx, ctx, order, "rejected", {
      reason: parsed.data.reason,
      atStep: order.approvalsGiven + 1,
      level,
    });
  });
}

/** Cancel an order nothing has been received against. */
export async function cancelOrder(ctx: TenantContext, orderId: string, rawInput: unknown) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireOn(ctx, "purchasing.manage", order);
    const posted = await tx.goodsReceipt.count({
      where: { organizationId: ctx.organizationId, purchaseOrderId: order.id, status: "POSTED" },
    });
    requireStatus(order, isCancellable(order.status, posted > 0));
    await releaseRequisitionLines(
      tx,
      ctx,
      order.lines.map((l) => l.id),
    );
    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
        pendingApprovalLevel: null,
        closedAt: new Date(),
        closedByUserId: ctx.userId,
        closeReason: parsed.data.reason,
      },
    });
    await audit(tx, ctx, order, "cancelled", { reason: parsed.data.reason });
  });
}

/** Close an order early: whatever is still open will not be delivered. */
export async function closeOrder(ctx: TenantContext, orderId: string, rawInput: unknown) {
  const parsed = reasonSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const order = await lockOrder(tx, ctx, orderId);
    requireOn(ctx, "purchasing.manage", order);
    requireStatus(order, isClosable(order.status));
    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        closedByUserId: ctx.userId,
        closeReason: parsed.data.reason,
      },
    });
    await audit(tx, ctx, order, "closed", { reason: parsed.data.reason });
  });
}

/** Active warehouses (with locations) where the user holds `permission`, for pickers. */
export async function purchasingWarehouseOptions(
  ctx: TenantContext,
  permission: Permission = "purchasing.manage",
) {
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.warehouse.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        branch: { archivedAt: null },
        ...warehouseScope(ctx, permission),
      },
      select: {
        id: true,
        code: true,
        name: true,
        locations: {
          where: { archivedAt: null },
          select: { id: true, code: true, name: true },
          orderBy: { code: "asc" },
        },
      },
      orderBy: { code: "asc" },
    }),
  );
}
