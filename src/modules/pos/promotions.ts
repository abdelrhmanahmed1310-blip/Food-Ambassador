import "server-only";
import { z } from "zod";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { SALES_CHANNELS } from "@/modules/menu/rules";
import { requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import type { PromotionRule } from "./discounts";

/**
 * Promotions and coupons (DECISIONS.md ADR-067). A promotion is a percentage
 * off chosen items or categories, by channel, weekday, hours and dates; it is
 * never edited (orders queued offline were priced with it), only archived.
 * A coupon is a code for a discount on the whole order.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "invalid" });
const optionalDate = z
  .union([dateSchema, z.literal("")])
  .optional()
  .transform((v) => (v ? v : null));
const timeSchema = z
  .union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "invalid" }), z.literal("")])
  .optional()
  .transform((v) => (v ? v : null));
const day = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const promotionSchema = z
  .object({
    name: requiredText(80),
    percent: decimalString({ maxScale: 2, min: "0.01", max: "100" }),
    categoryIds: z.array(uuidSchema).max(100).default([]),
    itemIds: z.array(uuidSchema).max(200).default([]),
    channels: z
      .array(z.enum(SALES_CHANNELS, { error: "invalidOption" }))
      .max(10)
      .default([]),
    weekdays: z.array(z.coerce.number().int().min(1).max(7)).max(7).default([]),
    startTime: timeSchema,
    endTime: timeSchema,
    validFrom: dateSchema,
    validTo: optionalDate,
  })
  .refine((v) => v.categoryIds.length + v.itemIds.length > 0, {
    error: "required",
    path: ["categoryIds"],
  })
  .refine((v) => (v.startTime === null) === (v.endTime === null), {
    error: "required",
    path: ["endTime"],
  })
  .refine((v) => v.validTo === null || v.validTo >= v.validFrom, {
    error: "invalid",
    path: ["validTo"],
  });

async function audit(
  tx: Tx,
  ctx: TenantContext,
  type: string,
  id: string,
  action: string,
  changes = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `${type}.${action}`,
    entityType: type,
    entityId: id,
    changes,
  });
}

export async function createPromotion(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = promotionSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  const org = ctx.organizationId;
  return withTenantTx(org, async (tx) => {
    // Only this organization's items and categories.
    const categoryIds = [...new Set(v.categoryIds)];
    const itemIds = [...new Set(v.itemIds)];
    const [cats, items] = await Promise.all([
      tx.menuCategory.count({ where: { organizationId: org, id: { in: categoryIds } } }),
      tx.menuItem.count({ where: { organizationId: org, id: { in: itemIds } } }),
    ]);
    if (cats !== categoryIds.length) throw notFound("Menu category");
    if (items !== itemIds.length) throw notFound("Menu item");
    const p = await tx.posPromotion.create({
      data: {
        organizationId: org,
        name: v.name,
        percent: v.percent,
        categoryIds,
        itemIds,
        channels: [...new Set(v.channels)],
        weekdays: [...new Set(v.weekdays)].sort(),
        startTime: v.startTime,
        endTime: v.endTime,
        validFrom: day(v.validFrom),
        validTo: v.validTo ? day(v.validTo) : null,
      },
      select: { id: true },
    });
    await audit(tx, ctx, "pos_promotion", p.id, "created", { ...v, categoryIds, itemIds });
    return p;
  });
}

export async function archivePromotion(ctx: TenantContext, promotionId: string) {
  assertPermission(ctx.grants, "menu.manage");
  const org = ctx.organizationId;
  await withTenantTx(org, async (tx) => {
    const p = await tx.posPromotion.findFirst({ where: { organizationId: org, id: promotionId } });
    if (!p) throw notFound("Promotion");
    if (p.archivedAt) return;
    await tx.posPromotion.update({ where: { id: p.id }, data: { archivedAt: new Date() } });
    await audit(tx, ctx, "pos_promotion", p.id, "archived", { name: p.name });
  });
}

const couponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{3,30}$/, { error: "invalid" }),
    kind: z.enum(["PERCENT", "AMOUNT"], { error: "invalidOption" }),
    value: decimalString({ maxScale: 4, min: "0.0001", max: "1000000" }),
    validFrom: dateSchema,
    validTo: optionalDate,
    maxUses: z
      .union([z.coerce.number().int().min(1).max(1_000_000), z.literal("")])
      .optional()
      .transform((v) => (v === "" || v === undefined ? null : v)),
  })
  .refine((v) => v.kind === "AMOUNT" || dec(v.value).lte(100), {
    error: "invalid",
    path: ["value"],
  })
  .refine((v) => v.validTo === null || v.validTo >= v.validFrom, {
    error: "invalid",
    path: ["validTo"],
  });

export async function createCoupon(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = couponSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const c = await tx.posCoupon.create({
        data: {
          organizationId: ctx.organizationId,
          code: v.code,
          kind: v.kind,
          value: v.value,
          validFrom: day(v.validFrom),
          validTo: v.validTo ? day(v.validTo) : null,
          maxUses: v.maxUses,
        },
        select: { id: true },
      });
      await audit(tx, ctx, "pos_coupon", c.id, "created", v);
      return c;
    });
  } catch (error) {
    if (isUniqueViolation(error, "pos_coupons_organization_id_code_key"))
      throw conflict("This code is used", { field: "code", reason: "codeTaken" });
    throw error;
  }
}

export async function archiveCoupon(ctx: TenantContext, couponId: string) {
  assertPermission(ctx.grants, "menu.manage");
  const org = ctx.organizationId;
  await withTenantTx(org, async (tx) => {
    const c = await tx.posCoupon.findFirst({ where: { organizationId: org, id: couponId } });
    if (!c) throw notFound("Coupon");
    if (c.archivedAt) return;
    await tx.posCoupon.update({ where: { id: c.id }, data: { archivedAt: new Date() } });
    await audit(tx, ctx, "pos_coupon", c.id, "archived", { code: c.code });
  });
}

export async function listPromotions(ctx: TenantContext) {
  assertPermission(ctx.grants, "menu.view");
  const org = ctx.organizationId;
  return withTenantTx(org, async (tx) => {
    const [promotions, coupons, categories, items] = await Promise.all([
      tx.posPromotion.findMany({
        where: { organizationId: org },
        orderBy: [{ archivedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
        take: 200,
      }),
      tx.posCoupon.findMany({
        where: { organizationId: org },
        orderBy: [{ archivedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
        take: 200,
      }),
      tx.menuCategory.findMany({
        where: { organizationId: org, archivedAt: null },
        select: { id: true, name: true, nameAr: true },
        orderBy: { name: "asc" },
      }),
      tx.menuItem.findMany({
        where: { organizationId: org, archivedAt: null },
        select: { id: true, name: true, nameAr: true },
        orderBy: { name: "asc" },
      }),
    ]);
    return { promotions, coupons, categories, items };
  });
}

/** Promotions as a till that loaded its menu at `asOf` saw them (created before, not yet archived). */
export async function loadPromotionsInTx(
  tx: Tx,
  ctx: TenantContext,
  asOf: Date,
): Promise<PromotionRule[]> {
  const rows = await tx.posPromotion.findMany({
    where: {
      organizationId: ctx.organizationId,
      createdAt: { lte: asOf },
      OR: [{ archivedAt: null }, { archivedAt: { gt: asOf } }],
    },
  });
  return rows.map(toRule);
}

export function toRule(p: {
  id: string;
  name: string;
  percent: { toString(): string };
  categoryIds: string[];
  itemIds: string[];
  channels: string[];
  weekdays: number[];
  startTime: string | null;
  endTime: string | null;
  validFrom: Date;
  validTo: Date | null;
}): PromotionRule {
  return {
    id: p.id,
    name: p.name,
    percent: dec(p.percent),
    categoryIds: p.categoryIds,
    itemIds: p.itemIds,
    channels: p.channels,
    weekdays: p.weekdays,
    startTime: p.startTime,
    endTime: p.endTime,
    validFrom: iso(p.validFrom)!,
    validTo: iso(p.validTo),
  };
}

/** Promotions for the till, with decimals as strings (client data). */
export const promotionForClient = (p: PromotionRule) => ({ ...p, percent: p.percent.toFixed() });

function couponProblem(
  c: {
    archivedAt: Date | null;
    validFrom: Date;
    validTo: Date | null;
    maxUses: number | null;
    uses: number;
  },
  date: string,
) {
  if (c.archivedAt) return "COUPON_UNKNOWN";
  if (date < iso(c.validFrom)! || (c.validTo && date > iso(c.validTo)!)) return "COUPON_EXPIRED";
  if (c.maxUses !== null && c.uses >= c.maxUses) return "COUPON_USED_UP";
  return null;
}

/**
 * A coupon usable on a business date, locked for the order that uses it.
 * Refused when unknown, archived, outside its dates, or used up.
 */
export async function takeCouponInTx(tx: Tx, ctx: TenantContext, code: string, date: string) {
  const org = ctx.organizationId;
  await tx.$queryRaw`SELECT 1 FROM "pos_coupons" WHERE "organization_id" = ${org}::uuid AND "code" = ${code} FOR UPDATE`;
  const c = await tx.posCoupon.findFirst({ where: { organizationId: org, code } });
  const problem = c ? couponProblem(c, date) : "COUPON_UNKNOWN";
  if (problem || !c)
    throw businessRuleViolation(problem ?? "COUPON_UNKNOWN", "This coupon is not valid", {
      field: "couponCode",
    });
  await tx.posCoupon.update({ where: { id: c.id }, data: { uses: { increment: 1 } } });
  return { id: c.id, kind: c.kind, value: dec(c.value) };
}

export const couponCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{3,30}$/, { error: "invalid" });

/**
 * Look a coupon up for the till before the order is sent, so the cashier sees
 * the total. Codes are not sent to tills in advance (they would be readable by
 * anyone on the device), so a coupon needs the till to be online.
 */
export async function lookupCoupon(ctx: TenantContext, rawCode: unknown, date: string) {
  assertPermission(ctx.grants, "pos.sell");
  const code = couponCodeSchema.safeParse(rawCode);
  if (!code.success)
    throw businessRuleViolation("COUPON_UNKNOWN", "This coupon is not valid", {
      field: "couponCode",
    });
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.posCoupon.findFirst({
      where: { organizationId: ctx.organizationId, code: code.data },
    });
    const problem = c ? couponProblem(c, date) : "COUPON_UNKNOWN";
    if (problem || !c)
      throw businessRuleViolation(problem ?? "COUPON_UNKNOWN", "This coupon is not valid", {
        field: "couponCode",
      });
    return { code: c.code, kind: c.kind, value: dec(c.value).toFixed() };
  });
}
