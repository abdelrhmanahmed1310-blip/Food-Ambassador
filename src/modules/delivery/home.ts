import "server-only";
import { z } from "zod";
import { isUuid } from "@/lib/uuid";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import { CONTACT_RETENTION_DAYS, mapLink, minutesBetween, riderStats } from "./home-rules";

/**
 * The restaurant's own delivery riders (DECISIONS.md ADR-117). A paid
 * delivery order sold at a branch (not a platform order — the platform
 * delivers those) gets a home delivery with the customer's address and
 * phone; a dispatcher (`pos.dispatch` at the branch) assigns one of the
 * branch's riders (`logistics.deliver` covering it), who picks it up and
 * delivers it or records why not. Contact details are erased 30 days
 * after the delivery ends.
 */

const createSchema = z.object({
  posOrderId: uuidSchema,
  contactName: optionalText(120),
  phone: z
    .string({ error: "required" })
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/, { error: "invalidPhone" }),
  address: requiredText(500),
  directions: optionalText(500),
});

export const canDispatch = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "pos.dispatch");
export const canRide = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "logistics.deliver");

const at = (branchId: string) => ({ branchId });

async function audit(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  action: string,
  changes: Record<string, unknown>,
) {
  // Never the address or phone: the audit log outlives the 30-day erasure.
  await recordAudit(tx, actorOf(ctx), {
    action: `home_delivery.${action}`,
    entityType: "home_delivery",
    entityId: id,
    changes,
  });
}

/** Members who may ride for a branch: an active role with `logistics.deliver` covering it. */
async function ridersFor(tx: Tx, ctx: TenantContext, branchId: string) {
  const rows = await tx.organizationMembership.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: "ACTIVE",
      user: { status: "ACTIVE" },
      roles: {
        some: {
          role: { permissions: { some: { permission: "logistics.deliver" } } },
          OR: [{ scopeType: "ORGANIZATION" }, { scopeType: "BRANCH", branchId }],
        },
      },
    },
    select: { user: { select: { id: true, name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return rows.map((r) => r.user);
}

export async function createHomeDelivery(ctx: TenantContext, rawInput: unknown) {
  const parsed = createSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const order = await tx.posOrder.findFirst({
        where: { organizationId: ctx.organizationId, id: input.posOrderId },
        select: {
          id: true,
          number: true,
          branchId: true,
          channel: true,
          status: true,
          deliveryOrder: { select: { id: true } },
        },
      });
      if (!order || !hasPermission(ctx.grants, "pos.dispatch", at(order.branchId)))
        throw notFound("Order");
      if (order.channel !== "DELIVERY" || order.status !== "PAID")
        throw businessRuleViolation(
          "NOT_A_DELIVERY_ORDER",
          "Only paid delivery orders are delivered",
          { field: "posOrderId" },
        );
      if (order.deliveryOrder)
        throw businessRuleViolation(
          "PLATFORM_DELIVERS",
          "The delivery platform delivers this order",
          { field: "posOrderId" },
        );
      const d = await tx.homeDelivery.create({
        data: {
          organizationId: ctx.organizationId,
          posOrderId: order.id,
          branchId: order.branchId,
          contactName: input.contactName ?? null,
          phone: input.phone,
          address: input.address,
          directions: input.directions ?? null,
          createdByUserId: ctx.userId,
        },
        select: { id: true },
      });
      await audit(tx, ctx, d.id, "created", { order: order.number });
      return d;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("Already out for delivery", { reason: "deliveryExists", field: "posOrderId" });
    throw error;
  }
}

async function loadDelivery(tx: Tx, ctx: TenantContext, deliveryId: string) {
  if (!isUuid(deliveryId)) throw notFound("Delivery");
  const d = await tx.homeDelivery.findFirst({
    where: { organizationId: ctx.organizationId, id: deliveryId },
    include: { posOrder: { select: { number: true, status: true } } },
  });
  if (!d) throw notFound("Delivery");
  const dispatch = hasPermission(ctx.grants, "pos.dispatch", at(d.branchId));
  const ride =
    hasPermission(ctx.grants, "logistics.deliver", at(d.branchId)) && d.riderUserId === ctx.userId;
  if (!dispatch && !ride) throw notFound("Delivery");
  return { ...d, dispatch, ride };
}

function assertStatus(d: { status: string }, allowed: string[], rule: string) {
  if (!allowed.includes(d.status))
    throw businessRuleViolation(rule, `Not possible while ${d.status}`, { status: d.status });
}

function assertOrderPaid(d: { posOrder: { status: string } }) {
  if (d.posOrder.status !== "PAID")
    throw businessRuleViolation("ORDER_VOIDED", "The order was voided: cancel the delivery");
}

/** Give it to one of the branch's riders (again, until it leaves). */
export async function assignRider(ctx: TenantContext, deliveryId: string, rawInput: unknown) {
  const parsed = z.object({ riderUserId: uuidSchema }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const d = await loadDelivery(tx, ctx, deliveryId);
    if (!d.dispatch) throw forbidden();
    assertStatus(d, ["WAITING", "ASSIGNED"], "DELIVERY_ALREADY_LEFT");
    assertOrderPaid(d);
    if (!(await ridersFor(tx, ctx, d.branchId)).some((r) => r.id === parsed.data.riderUserId))
      throw businessRuleViolation(
        "RIDER_NOT_ALLOWED",
        "This person does not ride for this branch",
        { field: "riderUserId" },
      );
    await tx.homeDelivery.update({
      where: { id: d.id },
      data: { status: "ASSIGNED", riderUserId: parsed.data.riderUserId, assignedAt: new Date() },
    });
    await audit(tx, ctx, d.id, "assigned", { riderUserId: parsed.data.riderUserId });
  });
}

export async function pickUp(ctx: TenantContext, deliveryId: string) {
  await withTenantTx(ctx.organizationId, async (tx) => {
    const d = await loadDelivery(tx, ctx, deliveryId);
    if (!d.ride) throw forbidden();
    assertStatus(d, ["ASSIGNED"], "DELIVERY_NOT_ASSIGNED");
    assertOrderPaid(d);
    const moved = await tx.homeDelivery.updateMany({
      where: {
        organizationId: ctx.organizationId,
        id: d.id,
        status: "ASSIGNED",
        riderUserId: ctx.userId,
      },
      data: { status: "OUT", pickedUpAt: new Date() },
    });
    if (!moved.count) throw conflict("The delivery changed meanwhile");
    await audit(tx, ctx, d.id, "picked_up", {});
  });
}

/** Handed over: by the rider, or a dispatcher recording it for them. */
export async function markDelivered(
  ctx: TenantContext,
  deliveryId: string,
  rawInput: unknown = {},
) {
  const parsed = z.object({ recipientName: optionalText(120) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const d = await loadDelivery(tx, ctx, deliveryId);
    if (!d.ride && !d.dispatch) throw forbidden();
    assertStatus(d, ["OUT"], "DELIVERY_NOT_OUT");
    await tx.homeDelivery.update({
      where: { id: d.id },
      data: {
        status: "DELIVERED",
        deliveredAt: new Date(),
        recipientName: parsed.data.recipientName ?? null,
      },
    });
    await audit(tx, ctx, d.id, "delivered", {});
  });
}

export async function markFailed(ctx: TenantContext, deliveryId: string, rawInput: unknown) {
  const parsed = z.object({ reason: requiredText(300) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const d = await loadDelivery(tx, ctx, deliveryId);
    if (!d.ride && !d.dispatch) throw forbidden();
    assertStatus(d, ["OUT"], "DELIVERY_NOT_OUT");
    await tx.homeDelivery.update({
      where: { id: d.id },
      data: { status: "FAILED", failedAt: new Date(), failureReason: parsed.data.reason },
    });
    await audit(tx, ctx, d.id, "failed", { reason: parsed.data.reason });
  });
}

/** Before it leaves, with a reason (e.g. the order was voided). */
export async function cancelHomeDelivery(
  ctx: TenantContext,
  deliveryId: string,
  rawInput: unknown,
) {
  const parsed = z.object({ reason: requiredText(300) }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const d = await loadDelivery(tx, ctx, deliveryId);
    if (!d.dispatch) throw forbidden();
    assertStatus(d, ["WAITING", "ASSIGNED"], "DELIVERY_ALREADY_LEFT");
    await tx.homeDelivery.update({
      where: { id: d.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: parsed.data.reason },
    });
    await audit(tx, ctx, d.id, "cancelled", { reason: parsed.data.reason });
  });
}

const view = <
  T extends {
    address: string | null;
    createdAt: Date;
    pickedUpAt: Date | null;
    deliveredAt: Date | null;
  },
>(
  d: T,
  now: Date,
) => ({
  ...d,
  mapUrl: d.address ? mapLink(d.address) : null,
  minutesSinceOrder: d.deliveredAt ? null : minutesBetween(d.createdAt, now),
  roadMinutes: minutesBetween(d.pickedUpAt, d.deliveredAt),
  totalMinutes: minutesBetween(d.createdAt, d.deliveredAt),
});

/**
 * A branch's dispatch board for one business day: delivery orders still
 * without a delivery, deliveries by status, the branch's riders with what
 * they carry, and each rider's figures for the day.
 */
export async function dispatchBoard(ctx: TenantContext, branchId: string, rawDate?: string) {
  if (!isUuid(branchId) || !hasPermission(ctx.grants, "pos.dispatch", at(branchId)))
    throw notFound("Branch");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await tx.branch.findFirst({
      where: { organizationId: ctx.organizationId, id: branchId },
      select: { id: true, code: true, name: true, timeZone: true },
    });
    if (!branch) throw notFound("Branch");
    const date =
      rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
        ? rawDate
        : businessDate(branch.timeZone ?? ctx.timeZone);
    const dayStart = new Date(`${date}T00:00:00Z`);
    const [orders, deliveries, riders] = await Promise.all([
      tx.posOrder.findMany({
        where: {
          organizationId: ctx.organizationId,
          branchId,
          channel: "DELIVERY",
          status: "PAID",
          businessDate: dayStart,
          deliveryOrder: null,
          homeDelivery: null,
        },
        select: { id: true, number: true, grossAmount: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      tx.homeDelivery.findMany({
        where: {
          organizationId: ctx.organizationId,
          branchId,
          posOrder: { businessDate: dayStart },
        },
        include: {
          posOrder: { select: { number: true, status: true, grossAmount: true } },
          rider: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      ridersFor(tx, ctx, branchId),
    ]);
    const now = new Date();
    const stats = riderStats(deliveries);
    return {
      branch,
      date,
      ordersWithoutDelivery: orders,
      deliveries: deliveries.map((d) => view(d, now)),
      riders: riders.map((r) => ({
        ...r,
        carrying: deliveries.filter(
          (d) => d.riderUserId === r.id && (d.status === "ASSIGNED" || d.status === "OUT"),
        ).length,
        stats: stats.find((s) => s.riderUserId === r.id) ?? null,
      })),
    };
  });
}

/** Branches the user dispatches for. */
export async function dispatchBranches(ctx: TenantContext) {
  if (!canDispatch(ctx)) throw forbidden();
  const scope = accessibleScope(ctx.grants, "pos.dispatch");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(scope.all ? {} : { id: { in: scope.branchIds } }),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  );
}

/** The rider's own deliveries still to do, oldest first, and what they finished today. */
export async function myDeliveries(ctx: TenantContext) {
  if (!canRide(ctx)) throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const since = new Date(`${addDays(businessDate(ctx.timeZone), -1)}T00:00:00Z`);
    const rows = await tx.homeDelivery.findMany({
      where: {
        organizationId: ctx.organizationId,
        riderUserId: ctx.userId,
        OR: [{ status: { in: ["ASSIGNED", "OUT"] } }, { updatedAt: { gte: since } }],
      },
      include: {
        posOrder: { select: { number: true, status: true, grossAmount: true } },
        branch: { select: { code: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    const now = new Date();
    return rows
      .filter((d) => hasPermission(ctx.grants, "logistics.deliver", at(d.branchId)))
      .map((d) => view(d, now));
  });
}

/**
 * Erase customer contact details 30 days after a delivery ended (a daily
 * job, ADR-087). Counts only; across organizations.
 */
export async function purgeDeliveryContacts(options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - CONTACT_RETENTION_DAYS * 86_400_000);
  return withSystemTx(async (tx) => {
    const r = await tx.homeDelivery.updateMany({
      where: {
        contactPurgedAt: null,
        OR: [
          { status: "DELIVERED", deliveredAt: { lt: cutoff } },
          { status: "FAILED", failedAt: { lt: cutoff } },
          { status: "CANCELLED", cancelledAt: { lt: cutoff } },
        ],
      },
      data: {
        contactName: null,
        phone: null,
        address: null,
        directions: null,
        contactPurgedAt: now,
      },
    });
    return { purged: r.count };
  });
}
