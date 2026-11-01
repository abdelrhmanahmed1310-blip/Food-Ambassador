import "server-only";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { emailSchema, requiredText, uuidSchema } from "@/modules/shared/schemas";
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
import { normalizePhone, pointsEarned, pointsToReverse } from "./loyalty-rules";

/**
 * Customers and loyalty points (DECISIONS.md ADR-068). A customer is a guest
 * who gave a phone number. Cashiers find one by the exact number and may add
 * one at the till; the customer list is for managers (customers.view).
 * Erasing (PDPL) removes the personal data and keeps the anonymous history.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());

const phoneSchema = z.string({ error: "required" }).transform((v, c) => {
  const p = normalizePhone(v);
  if (!p) {
    c.addIssue({ code: "custom", message: "invalidPhone" });
    return z.NEVER;
  }
  return p;
});
const consentSchema = z
  .union([z.literal("on"), z.literal("true"), z.boolean(), z.literal("")])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true");

const customerSchema = z.object({
  name: requiredText(120),
  phone: phoneSchema,
  email: z
    .union([emailSchema, z.literal("")])
    .optional()
    .transform((v) => v || null),
  marketingConsent: consentSchema,
});

async function audit(tx: Tx, ctx: TenantContext, id: string, action: string, changes = {}) {
  await recordAudit(tx, actorOf(ctx), {
    action: `pos_customer.${action}`,
    entityType: "pos_customer",
    entityId: id,
    changes,
  });
}

const canSell = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "pos.sell");

/** Add a customer (managers, or a cashier at the till). */
export async function createCustomer(ctx: TenantContext, rawInput: unknown) {
  if (!hasPermission(ctx.grants, "customers.manage") && !canSell(ctx))
    throw forbidden("You cannot add customers");
  const parsed = customerSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const c = await tx.posCustomer.create({
        data: {
          organizationId: ctx.organizationId,
          name: v.name,
          phone: v.phone,
          email: v.email,
          marketingConsent: v.marketingConsent,
          consentAt: v.marketingConsent ? new Date() : null,
        },
        select: { id: true, name: true, pointsBalance: true },
      });
      // The audit keeps no personal data: it outlives an erasure.
      await audit(tx, ctx, c.id, "created", { marketingConsent: v.marketingConsent });
      return { id: c.id, name: c.name, points: c.pointsBalance };
    });
  } catch (error) {
    if (isUniqueViolation(error, "pos_customers_organization_id_phone_key"))
      throw conflict("A customer has this phone number", { field: "phone", reason: "phoneTaken" });
    throw error;
  }
}

const updateSchema = customerSchema.omit({ phone: true });

export async function updateCustomer(ctx: TenantContext, customerId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "customers.manage");
  const parsed = updateSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCustomer(tx, ctx, customerId);
    await tx.posCustomer.update({
      where: { id: c.id },
      data: {
        name: v.name,
        email: v.email,
        marketingConsent: v.marketingConsent,
        consentAt: v.marketingConsent ? (c.consentAt ?? new Date()) : null,
      },
    });
    await audit(tx, ctx, c.id, "updated", { marketingConsent: v.marketingConsent });
  });
}

async function loadCustomer(tx: Tx, ctx: TenantContext, customerId: string, lock = false) {
  const id = uuidSchema.safeParse(customerId);
  if (!id.success) throw notFound("Customer");
  if (lock)
    await tx.$queryRaw`SELECT 1 FROM "pos_customers" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${id.data}::uuid FOR UPDATE`;
  const c = await tx.posCustomer.findFirst({
    where: { organizationId: ctx.organizationId, id: id.data, erasedAt: null },
  });
  if (!c) throw notFound("Customer");
  return c;
}

/** Erase a customer's personal data (PDPL request). Orders and points history stay, anonymous. */
export async function eraseCustomer(ctx: TenantContext, customerId: string) {
  assertPermission(ctx.grants, "customers.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCustomer(tx, ctx, customerId, true);
    if (c.pointsBalance > 0)
      await tx.loyaltyEntry.create({
        data: {
          organizationId: ctx.organizationId,
          customerId: c.id,
          kind: "ADJUSTMENT",
          points: -c.pointsBalance,
          reason: "erased",
          createdByUserId: ctx.userId,
        },
      });
    await tx.posCustomer.update({
      where: { id: c.id },
      data: {
        name: "—",
        phone: null,
        email: null,
        marketingConsent: false,
        consentAt: null,
        pointsBalance: 0,
        erasedAt: new Date(),
      },
    });
    await audit(tx, ctx, c.id, "erased");
  });
}

const adjustSchema = z.object({
  points: z.coerce
    .number({ error: "invalid" })
    .int({ error: "invalid" })
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0, { error: "invalid" }),
  reason: requiredText(200),
});

/** Correct a customer's points (a complaint, a goodwill gesture), with a reason. */
export async function adjustPoints(ctx: TenantContext, customerId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "customers.manage");
  const parsed = adjustSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCustomer(tx, ctx, customerId, true);
    if (c.pointsBalance + v.points < 0)
      throw businessRuleViolation("POINTS_NOT_ENOUGH", "The customer does not have these points", {
        field: "points",
      });
    await addPointsInTx(tx, ctx, c.id, "ADJUSTMENT", v.points, null, v.reason);
    await audit(tx, ctx, c.id, "points_adjusted", v);
  });
}

async function addPointsInTx(
  tx: Tx,
  ctx: TenantContext,
  customerId: string,
  kind: "EARN" | "REDEEM" | "REVERSAL" | "ADJUSTMENT",
  points: number,
  orderId: string | null,
  reason: string | null = null,
) {
  if (points === 0) return;
  await tx.loyaltyEntry.create({
    data: {
      organizationId: ctx.organizationId,
      customerId,
      kind,
      points,
      orderId,
      reason,
      createdByUserId: ctx.userId,
    },
  });
  await tx.posCustomer.update({
    where: { id: customerId },
    data: { pointsBalance: { increment: points } },
  });
}

/** The customer with this phone number, for the till: name and points only. */
export async function findCustomerByPhone(ctx: TenantContext, rawPhone: unknown) {
  if (!canSell(ctx) && !hasPermission(ctx.grants, "customers.view"))
    throw forbidden("You cannot look up customers");
  const phone = phoneSchema.safeParse(rawPhone);
  if (!phone.success) throw validationFailed(phone.error);
  const c = await withTenantTx(ctx.organizationId, (tx) =>
    tx.posCustomer.findFirst({
      where: { organizationId: ctx.organizationId, phone: phone.data, erasedAt: null },
      select: { id: true, name: true, pointsBalance: true },
    }),
  );
  if (!c) throw notFound("Customer");
  return { id: c.id, name: c.name, points: c.pointsBalance };
}

const listSchema = z.object({
  q: z.string().trim().max(60).optional().default(""),
  page: z.coerce.number().int().min(1).catch(1),
});

export async function listCustomers(ctx: TenantContext, rawInput: unknown = {}) {
  assertPermission(ctx.grants, "customers.view");
  const { q, page } = listSchema.parse(rawInput);
  const take = 50;
  const digits = q.replace(/\D/g, "");
  const where = {
    organizationId: ctx.organizationId,
    erasedAt: null,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            ...(digits.length >= 3 ? [{ phone: { contains: digits.replace(/^0/, "") } }] : []),
          ],
        }
      : {}),
  };
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [rows, total] = await Promise.all([
      tx.posCustomer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip: (page - 1) * take,
        select: {
          id: true,
          name: true,
          phone: true,
          pointsBalance: true,
          marketingConsent: true,
          createdAt: true,
        },
      }),
      tx.posCustomer.count({ where }),
    ]);
    return { rows, total, page, pages: Math.max(1, Math.ceil(total / take)) };
  });
}

export async function getCustomer(ctx: TenantContext, customerId: string) {
  assertPermission(ctx.grants, "customers.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCustomer(tx, ctx, customerId);
    const [entries, orders] = await Promise.all([
      tx.loyaltyEntry.findMany({
        where: { organizationId: ctx.organizationId, customerId: c.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      tx.posOrder.findMany({
        where: { organizationId: ctx.organizationId, customerId: c.id },
        select: { id: true, number: true, orderedAt: true, grossAmount: true, status: true },
        orderBy: { orderedAt: "desc" },
        take: 20,
      }),
    ]);
    return { ...c, entries, orders };
  });
}

// ─── Loyalty settings and the order engine ───

const settingsSchema = z.object({
  enabled: consentSchema,
  earnRate: decimalString({ maxScale: 4, min: "0", max: "1000" }),
  pointValue: decimalString({ maxScale: 4, min: "0.0001", max: "1000" }),
  minRedeemPoints: z.coerce.number().int().min(0).max(1_000_000),
});

export async function saveLoyaltySettings(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = settingsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const data = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    await tx.loyaltySettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ...data },
      update: data,
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "loyalty_settings.saved",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: data,
    });
  });
}

export async function loyaltySettingsInTx(tx: Tx, ctx: TenantContext) {
  const s = await tx.loyaltySettings.findUnique({ where: { organizationId: ctx.organizationId } });
  return s
    ? {
        enabled: s.enabled,
        earnRate: dec(s.earnRate),
        pointValue: dec(s.pointValue),
        minRedeemPoints: s.minRedeemPoints,
      }
    : null;
}

export async function loyaltySettings(ctx: TenantContext) {
  return withTenantTx(ctx.organizationId, (tx) => loyaltySettingsInTx(tx, ctx));
}

/** The order's customer, locked when points are spent. */
export async function orderCustomerInTx(
  tx: Tx,
  ctx: TenantContext,
  customerId: string,
  lock: boolean,
) {
  return loadCustomer(tx, ctx, customerId, lock);
}

/** Points spent on an order and points earned on what was paid. */
export async function postOrderPointsInTx(
  tx: Tx,
  ctx: TenantContext,
  a: { customerId: string; orderId: string; redeemed: number; paid: Decimal },
) {
  const settings = await loyaltySettingsInTx(tx, ctx);
  if (a.redeemed > 0) await addPointsInTx(tx, ctx, a.customerId, "REDEEM", -a.redeemed, a.orderId);
  const earned = settings?.enabled ? pointsEarned(a.paid, settings.earnRate) : 0;
  await addPointsInTx(tx, ctx, a.customerId, "EARN", earned, a.orderId);
  return earned;
}

/**
 * Points back on a void (all) or a refund (the refunded share of what was
 * earned). Points already spent cannot be taken back below zero; the balance
 * stops at zero.
 */
export async function reverseOrderPointsInTx(
  tx: Tx,
  ctx: TenantContext,
  order: {
    id: string;
    customerId: string | null;
    grossAmount: { toString(): string };
    refundedAmount: { toString(): string };
  },
  refund: Decimal | null,
) {
  if (!order.customerId) return;
  const c = await tx.posCustomer.findFirst({
    where: { organizationId: ctx.organizationId, id: order.customerId },
  });
  if (!c || c.erasedAt) return;
  await tx.$queryRaw`SELECT 1 FROM "pos_customers" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "id" = ${c.id}::uuid FOR UPDATE`;
  const entries = await tx.loyaltyEntry.findMany({
    where: { organizationId: ctx.organizationId, orderId: order.id },
  });
  const sum = (kind: string) =>
    entries.filter((e) => e.kind === kind).reduce((a, e) => a + e.points, 0);
  const earned = sum("EARN");
  const redeemed = -sum("REDEEM");
  const balance = (await tx.posCustomer.findUniqueOrThrow({ where: { id: c.id } })).pointsBalance;
  let take: number;
  let giveBack = 0;
  if (refund === null) {
    // Void: the points earned go, the points spent come back.
    take = earned;
    giveBack = redeemed;
  } else {
    take = pointsToReverse(earned, dec(order.grossAmount), dec(order.refundedAmount), refund);
  }
  const net = giveBack - Math.min(take, balance + giveBack);
  await addPointsInTx(tx, ctx, c.id, "REVERSAL", net, order.id);
}
