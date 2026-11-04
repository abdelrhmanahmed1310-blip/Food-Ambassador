import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { Decimal, decimalString } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { optionalText, requiredText } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { conflict, notFound, validationFailed } from "@/server/errors";
import { matches, rfm, RFM_GROUPS, type CustomerStats, type SegmentRules } from "./rules";

/**
 * Customer segments and RFM (DECISIONS.md ADR-118): groups of guests by
 * their paid orders, worked out when looked at — never stored lists.
 * Erased customers are never included. Viewing needs `customers.view`;
 * saving segments and exporting their members `customers.manage`, and an
 * export is audited (by count, never by person).
 */

const dec = (v: { toString(): string } | null) => new Decimal(v?.toString() ?? "0");
const optInt = (max: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : Number(v)))
    .refine((v) => v === undefined || (Number.isInteger(v) && v >= 0 && v <= max), {
      error: "invalidNumber",
    });

export const rulesSchema = z
  .object({
    windowDays: z
      .union([z.number(), z.string()])
      .optional()
      .transform((v) => (v === undefined || v === "" ? 365 : Number(v)))
      .refine((v) => Number.isInteger(v) && v >= 1 && v <= 1095, { error: "invalidNumber" }),
    visitedWithinDays: optInt(1095),
    notVisitedForDays: optInt(1095),
    minOrders: optInt(100000),
    maxOrders: optInt(100000),
    minSpend: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() ? v.trim() : undefined))
      .pipe(decimalString({ maxScale: 2, min: "0" }).optional()),
    branchIds: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .transform((v) =>
        v === undefined ? undefined : (Array.isArray(v) ? v : [v]).filter(Boolean),
      )
      .refine((v) => v === undefined || v.every(isUuid), { error: "invalidOption" })
      .transform((v) => (v && v.length ? v : undefined)),
    consentOnly: z
      .union([z.boolean(), z.enum(["on", "true", "false", ""])])
      .optional()
      .transform((v) => v === true || v === "on" || v === "true"),
    minPoints: optInt(100_000_000),
  })
  .refine(
    (r) => r.minOrders === undefined || r.maxOrders === undefined || r.minOrders <= r.maxOrders,
    {
      error: "rangeReversed",
      path: ["maxOrders"],
    },
  );

const segmentSchema = z.object({
  name: requiredText(80),
  description: optionalText(300),
  rules: rulesSchema,
});

/** Each customer's paid orders and spend in the window, last visit ever, branches, consent, points. */
export async function customerStatsInTx(
  tx: Tx,
  ctx: TenantContext,
  windowDays: number,
): Promise<CustomerStats[]> {
  const today = businessDate(ctx.timeZone);
  const from = addDays(today, -windowDays + 1);
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      marketing_consent: boolean;
      points_balance: number;
      orders: bigint | null;
      spend: Prisma.Decimal | null;
      last_visit: Date | null;
      branch_ids: string[] | null;
    }>
  >`
    SELECT c.id, c.marketing_consent, c.points_balance,
           w.orders, w.spend, a.last_visit, w.branch_ids
    FROM pos_customers c
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS orders, SUM(o.gross_amount - o.refunded_amount) AS spend,
             array_agg(DISTINCT o.branch_id::text) AS branch_ids
      FROM pos_orders o
      WHERE o.organization_id = c.organization_id AND o.customer_id = c.id AND o.status = 'PAID'
        AND o.business_date >= ${from}::date
    ) w ON true
    LEFT JOIN LATERAL (
      SELECT MAX(o.business_date) AS last_visit FROM pos_orders o
      WHERE o.organization_id = c.organization_id AND o.customer_id = c.id AND o.status = 'PAID'
    ) a ON true
    WHERE c.organization_id = ${ctx.organizationId}::uuid AND c.erased_at IS NULL`;
  return rows.map((r) => ({
    customerId: r.id,
    orders: Number(r.orders ?? 0),
    spend: dec(r.spend),
    lastVisit: r.last_visit ? r.last_visit.toISOString().slice(0, 10) : null,
    branchIds: r.branch_ids ?? [],
    marketingConsent: r.marketing_consent,
    points: r.points_balance,
  }));
}

function parseRules(raw: unknown): SegmentRules {
  const r = rulesSchema.safeParse(raw);
  return r.success ? r.data : { windowDays: 365 };
}

async function audit(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  action: string,
  changes: Record<string, unknown>,
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `customer_segment.${action}`,
    entityType: "customer_segment",
    entityId: id,
    changes,
  });
}

/** How many customers a set of conditions selects, before saving it. */
export async function previewSegment(ctx: TenantContext, rawRules: unknown) {
  assertPermission(ctx.grants, "customers.view");
  const parsed = rulesSchema.safeParse(rawRules);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const stats = await customerStatsInTx(tx, ctx, parsed.data.windowDays);
    const today = businessDate(ctx.timeZone);
    const hit = stats.filter((s) => matches(s, parsed.data, today));
    return { count: hit.length, withConsent: hit.filter((s) => s.marketingConsent).length };
  });
}

export async function saveSegment(ctx: TenantContext, rawInput: unknown, segmentId?: string) {
  assertPermission(ctx.grants, "customers.manage");
  const parsed = segmentSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { name, description, rules } = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const data = {
        name,
        description: description ?? null,
        rules: rules as unknown as Prisma.InputJsonValue,
      };
      const same = await tx.customerSegment.findFirst({
        where: {
          organizationId: ctx.organizationId,
          name: { equals: name, mode: "insensitive" },
          ...(segmentId ? { NOT: { id: segmentId } } : {}),
        },
        select: { id: true },
      });
      if (same) throw conflict("Name already used", { reason: "nameTaken", field: "name" });
      if (segmentId) {
        if (!isUuid(segmentId)) throw notFound("Segment");
        const moved = await tx.customerSegment.updateMany({
          where: { organizationId: ctx.organizationId, id: segmentId, archivedAt: null },
          data,
        });
        if (!moved.count) throw notFound("Segment");
        await audit(tx, ctx, segmentId, "updated", { name, rules });
        return { id: segmentId };
      }
      const s = await tx.customerSegment.create({
        data: { organizationId: ctx.organizationId, ...data, createdByUserId: ctx.userId },
        select: { id: true },
      });
      await audit(tx, ctx, s.id, "created", { name, rules });
      return s;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict("Name already used", { reason: "nameTaken", field: "name" });
    throw error;
  }
}

export async function archiveSegment(ctx: TenantContext, segmentId: string) {
  assertPermission(ctx.grants, "customers.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    if (!isUuid(segmentId)) throw notFound("Segment");
    const moved = await tx.customerSegment.updateMany({
      where: { organizationId: ctx.organizationId, id: segmentId, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (!moved.count) throw notFound("Segment");
    await audit(tx, ctx, segmentId, "archived", {});
  });
}

/** Saved segments with how many customers each selects today. */
export async function listSegments(ctx: TenantContext) {
  assertPermission(ctx.grants, "customers.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const segments = await tx.customerSegment.findMany({
      where: { organizationId: ctx.organizationId, archivedAt: null },
      orderBy: { name: "asc" },
    });
    const today = businessDate(ctx.timeZone);
    const cache = new Map<number, CustomerStats[]>();
    const out = [];
    for (const s of segments) {
      const rules = parseRules(s.rules);
      if (!cache.has(rules.windowDays))
        cache.set(rules.windowDays, await customerStatsInTx(tx, ctx, rules.windowDays));
      const hit = cache.get(rules.windowDays)!.filter((c) => matches(c, rules, today));
      out.push({
        ...s,
        rules,
        count: hit.length,
        withConsent: hit.filter((c) => c.marketingConsent).length,
      });
    }
    return { segments: out, canManage: hasPermission(ctx.grants, "customers.manage") };
  });
}

/** One segment's customers today, biggest spenders first. */
export async function segmentMembers(ctx: TenantContext, segmentId: string) {
  assertPermission(ctx.grants, "customers.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    if (!isUuid(segmentId)) throw notFound("Segment");
    const segment = await tx.customerSegment.findFirst({
      where: { organizationId: ctx.organizationId, id: segmentId, archivedAt: null },
    });
    if (!segment) throw notFound("Segment");
    const rules = parseRules(segment.rules);
    const today = businessDate(ctx.timeZone);
    const hit = (await customerStatsInTx(tx, ctx, rules.windowDays)).filter((c) =>
      matches(c, rules, today),
    );
    const people = await tx.posCustomer.findMany({
      where: { organizationId: ctx.organizationId, id: { in: hit.map((h) => h.customerId) } },
      select: { id: true, name: true, phone: true, email: true },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    const members = hit
      .map((h) => ({ ...h, person: byId.get(h.customerId)! }))
      .sort((a, b) => b.spend.comparedTo(a.spend) || a.person.name.localeCompare(b.person.name));
    return {
      segment: { ...segment, rules },
      members,
      canManage: hasPermission(ctx.grants, "customers.manage"),
    };
  });
}

/**
 * The members as CSV for use elsewhere; only those who agreed to receive
 * offers carry their phone and e-mail. The export is audited by count.
 */
export async function exportSegmentCsv(ctx: TenantContext, segmentId: string) {
  assertPermission(ctx.grants, "customers.manage");
  const r = await segmentMembers(ctx, segmentId);
  await withTenantTx(ctx.organizationId, (tx) =>
    audit(tx, ctx, segmentId, "exported", {
      members: r.members.length,
      withContact: r.members.filter((m) => m.marketingConsent).length,
    }),
  );
  return toCsv(
    ["name", "phone", "email", "marketing consent", "orders", "spend", "last visit", "points"],
    r.members.map((m) => [
      m.person.name,
      m.marketingConsent ? (m.person.phone ?? "") : "",
      m.marketingConsent ? (m.person.email ?? "") : "",
      m.marketingConsent ? "yes" : "no",
      m.orders,
      m.spend.toFixed(2),
      m.lastVisit ?? "",
      m.points,
    ]),
  );
}

/** RFM groups of customers who bought in the last year: how many, and their spend. */
export async function rfmOverview(ctx: TenantContext, windowDays = 365) {
  assertPermission(ctx.grants, "customers.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const stats = await customerStatsInTx(tx, ctx, windowDays);
    const scored = rfm(stats, businessDate(ctx.timeZone));
    const byId = new Map(stats.map((s) => [s.customerId, s]));
    return {
      windowDays,
      groups: RFM_GROUPS.map((g) => {
        const list = scored.filter((x) => x.group === g);
        return {
          group: g,
          customers: list.length,
          spend: list.reduce((a, x) => a.plus(byId.get(x.customerId)!.spend), new Decimal(0)),
          withConsent: list.filter((x) => byId.get(x.customerId)!.marketingConsent).length,
        };
      }),
    };
  });
}
