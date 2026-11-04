import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { toCsv } from "@/lib/csv";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { accessibleScope, assertPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { currencyConverter, warehouseCurrencies } from "@/modules/fx/service";
import { previousPeriod } from "@/modules/procurement/spend-rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { forbidden, notFound, validationFailed } from "@/server/errors";
import {
  averageTicket,
  growth,
  isoWeekday,
  monthsCovering,
  proratedTarget,
  samePeriodLastYear,
} from "./sales-rules";

/**
 * Sales analytics and targets (DECISIONS.md ADR-105), from POS orders only:
 * paid orders, net of VAT and of refunds (a refund counts on its order's
 * business date, as on the dashboard). Each branch's sales are in its
 * company's currency and are converted into the report currency at the
 * period's average rate; a currency without a rate is left out and named.
 * Needs `sales.view` at the branches shown; targets are set with
 * `sales.targets.manage`.
 */

const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? "0");

const periodSchema = z
  .object({
    from: z.string().refine(isCalendarDate, { error: "invalidDate" }),
    to: z.string().refine(isCalendarDate, { error: "invalidDate" }),
  })
  .refine((p) => p.from <= p.to, { error: "invalidPeriod", path: ["to"] });

export const canSeeSales = (ctx: TenantContext) => holdsAnyGrant(ctx.grants, "sales.view");

async function salesWarehouses(
  tx: Tx,
  ctx: TenantContext,
  filters: { companyId?: string; branchId?: string },
) {
  if (!canSeeSales(ctx)) throw forbidden();
  const scope = accessibleScope(ctx.grants, "sales.view");
  return tx.warehouse.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(filters.companyId ? { branch: { companyId: filters.companyId } } : {}),
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(scope.all
        ? {}
        : { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }] }),
    },
    select: {
      id: true,
      branchId: true,
      branch: { select: { id: true, code: true, name: true, timeZone: true } },
    },
  });
}

/** Branches the user may see sales of (with or without a warehouse yet). */
async function salesBranches(
  tx: Tx,
  ctx: TenantContext,
  filters: { companyId?: string; branchId?: string },
) {
  if (!canSeeSales(ctx)) throw forbidden();
  const scope = accessibleScope(ctx.grants, "sales.view");
  return tx.branch.findMany({
    where: {
      organizationId: ctx.organizationId,
      archivedAt: null,
      ...(filters.companyId ? { companyId: filters.companyId } : {}),
      ...(filters.branchId ? { id: filters.branchId } : {}),
      ...(scope.all
        ? {}
        : {
            OR: [
              { id: { in: scope.branchIds } },
              { warehouses: { some: { id: { in: scope.warehouseIds } } } },
            ],
          }),
    },
    select: { id: true, code: true, name: true, company: { select: { currency: true } } },
    orderBy: { code: "asc" },
  });
}

interface Row {
  warehouse_id: string;
  key: string;
  orders: bigint;
  net: Prisma.Decimal;
}

/** Paid orders net of refunds, grouped by warehouse and one dimension. */
async function grouped(
  tx: Tx,
  ctx: TenantContext,
  ids: string[],
  period: { from: string; to: string },
  dimension: "total" | "day" | "channel" | "hour",
): Promise<Row[]> {
  const key =
    dimension === "day"
      ? Prisma.sql`to_char(o.business_date, 'YYYY-MM-DD')`
      : dimension === "channel"
        ? Prisma.sql`o.channel::text`
        : dimension === "hour"
          ? Prisma.sql`extract(hour FROM o.ordered_at AT TIME ZONE coalesce(b.time_zone, ${ctx.timeZone}))::int::text`
          : Prisma.sql`'all'`;
  return tx.$queryRaw<Row[]>`
    SELECT o.warehouse_id, ${key} AS key, COUNT(*) AS orders,
           SUM(o.net_amount - coalesce(r.net, 0)) AS net
    FROM pos_orders o
    JOIN branches b ON b.id = o.branch_id
    LEFT JOIN (
      SELECT order_id, SUM(amount - tax_amount) AS net FROM pos_refunds
      WHERE organization_id = ${ctx.organizationId}::uuid GROUP BY order_id
    ) r ON r.order_id = o.id
    WHERE o.organization_id = ${ctx.organizationId}::uuid
      AND o.status = 'PAID'
      AND o.warehouse_id = ANY(${ids}::uuid[])
      AND o.business_date BETWEEN ${period.from}::date AND ${period.to}::date
    GROUP BY o.warehouse_id, key`;
}

interface Figures {
  orders: number;
  net: Decimal;
}
const zero = (): Figures => ({ orders: 0, net: new Decimal(0) });

/** Sales by branch, channel, weekday, hour and day, against the previous period, last year and targets. */
export async function salesAnalytics(
  ctx: TenantContext,
  rawPeriod: unknown,
  filters: { companyId?: string; branchId?: string } = {},
) {
  const p = periodSchema.safeParse(rawPeriod);
  if (!p.success) throw validationFailed(p.error);
  const period = p.data;
  const previous = previousPeriod(period.from, period.to);
  const lastYear = samePeriodLastYear(period.from, period.to);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const warehouses = await salesWarehouses(tx, ctx, filters);
    const currency =
      (filters.companyId
        ? (
            await tx.company.findFirst({
              where: { organizationId: ctx.organizationId, id: filters.companyId },
              select: { currency: true },
            })
          )?.currency
        : undefined) ?? ctx.groupCurrency;
    const conv = await currencyConverter(tx, ctx, {
      to: currency,
      date: period.to,
      from: period.from,
    });
    const ids = warehouses.map((w) => w.id);
    const currencies = await warehouseCurrencies(tx, ctx, ids);
    const branchOf = new Map(warehouses.map((w) => [w.id, w.branch]));
    /** Converted figures per (branch, key). */
    const collect = async (rows: Row[]) => {
      const out = new Map<string, Figures>();
      for (const r of rows) {
        const net = await conv.convert(dec(r.net), currencies.get(r.warehouse_id)!);
        if (net === null) continue;
        const k = `${branchOf.get(r.warehouse_id)!.id}|${r.key}`;
        const f = out.get(k) ?? zero();
        f.orders += Number(r.orders);
        f.net = f.net.plus(net);
        out.set(k, f);
      }
      return out;
    };
    const sum = (
      m: Map<string, Figures>,
      pick: (branchId: string, key: string) => string | null,
    ) => {
      const out = new Map<string, Figures>();
      for (const [k, f] of m) {
        const [branchId, key] = k.split("|");
        const g = pick(branchId, key);
        if (g === null) continue;
        const e = out.get(g) ?? zero();
        e.orders += f.orders;
        e.net = e.net.plus(f.net);
        out.set(g, e);
      }
      return out;
    };
    const empty = ids.length === 0;
    const run = (per: { from: string; to: string }, d: "total" | "day" | "channel" | "hour") =>
      empty ? Promise.resolve([] as Row[]) : grouped(tx, ctx, ids, per, d);
    const [cur, prev, year, days, channels, hours] = await Promise.all([
      run(period, "total").then(collect),
      run(previous, "total").then(collect),
      run(lastYear, "total").then(collect),
      run(period, "day").then(collect),
      run(period, "channel").then(collect),
      run(period, "hour").then(collect),
    ]);
    const total = (m: Map<string, Figures>) => sum(m, () => "all").get("all") ?? zero();
    const byBranch = (m: Map<string, Figures>) => sum(m, (b) => b);

    // Targets for the months the period touches, converted like sales.
    const branchList = await salesBranches(tx, ctx, filters);
    const branchIds = branchList.map((b) => b.id);
    const months = monthsCovering(period.from, period.to);
    const targetRows = branchIds.length
      ? await tx.salesTarget.findMany({
          where: {
            organizationId: ctx.organizationId,
            branchId: { in: branchIds },
            month: { in: months.map((m) => new Date(`${m}T00:00:00Z`)) },
          },
        })
      : [];
    const targetOf = new Map<string, Decimal | null>();
    for (const b of branchIds) {
      const rows = targetRows.filter((t) => t.branchId === b);
      const converted: Array<{ month: string; amount: Decimal }> = [];
      for (const t of rows) {
        const amount = await conv.convert(dec(t.netAmount), t.currency);
        if (amount !== null) converted.push({ month: t.month.toISOString().slice(0, 10), amount });
      }
      targetOf.set(b, proratedTarget(converted, period.from, period.to));
    }
    const targets = [...targetOf.values()].filter((v): v is Decimal => v !== null);
    const totalTarget = targets.length ? targets.reduce((a, v) => a.plus(v), new Decimal(0)) : null;

    const current = total(cur);
    const share = (net: Decimal) => (current.net.gt(0) ? net.div(current.net) : null);
    const branchesCur = byBranch(cur);
    const branchesPrev = byBranch(prev);
    const branches = branchList
      .map((b) => {
        const f = branchesCur.get(b.id) ?? zero();
        const target = targetOf.get(b.id) ?? null;
        return {
          branch: { id: b.id, code: b.code, name: b.name },
          ...f,
          averageTicket: averageTicket(f.net, f.orders),
          share: share(f.net),
          growthPrevious: growth(f.net, (branchesPrev.get(b.id) ?? zero()).net),
          target,
          achievement: target && target.gt(0) ? f.net.div(target) : null,
        };
      })
      .sort((a, b) => b.net.comparedTo(a.net));
    const dayFigures = sum(days, (_, k) => k);
    const weekdays = Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, ...zero() }));
    for (const [day, f] of dayFigures) {
      const w = weekdays[isoWeekday(day) - 1];
      w.orders += f.orders;
      w.net = w.net.plus(f.net);
    }
    const hourFigures = sum(hours, (_, k) => k);
    return {
      period,
      previous,
      lastYear,
      currency: conv.currency,
      missingRates: conv.missing(),
      total: {
        ...current,
        averageTicket: averageTicket(current.net, current.orders),
        previous: total(prev),
        lastYear: total(year),
        growthPrevious: growth(current.net, total(prev).net),
        growthLastYear: growth(current.net, total(year).net),
        target: totalTarget,
        achievement: totalTarget && totalTarget.gt(0) ? current.net.div(totalTarget) : null,
      },
      branches,
      channels: [...sum(channels, (_, k) => k)]
        .map(([channel, f]) => ({ channel, ...f, share: share(f.net) }))
        .sort((a, b) => b.net.comparedTo(a.net)),
      weekdays: weekdays.map((w) => ({ ...w, averageTicket: averageTicket(w.net, w.orders) })),
      hours: Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        ...(hourFigures.get(String(h)) ?? zero()),
      })),
      days: [...dayFigures]
        .map(([day, f]) => ({ day, ...f, averageTicket: averageTicket(f.net, f.orders) }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    };
  });
}

export async function exportSalesCsv(
  ctx: TenantContext,
  rawPeriod: unknown,
  filters: { companyId?: string; branchId?: string } = {},
) {
  const r = await salesAnalytics(ctx, rawPeriod, filters);
  const f = (v: Decimal | null) => (v === null ? "" : v.toFixed(2));
  const pct = (v: Decimal | null) => (v === null ? "" : v.times(100).toFixed(1));
  const branchRows = r.branches.map((b) => [
    "branch",
    b.branch.code,
    b.branch.name,
    b.orders,
    f(b.net),
    f(b.averageTicket),
    pct(b.share),
    f(b.target),
    pct(b.achievement),
    pct(b.growthPrevious),
  ]);
  const dayRows = r.days.map((d) => [
    "day",
    d.day,
    "",
    d.orders,
    f(d.net),
    f(d.averageTicket),
    "",
    "",
    "",
    "",
  ]);
  return toCsv(
    [
      "section",
      "code",
      "name",
      "orders",
      `net (${r.currency})`,
      "average ticket",
      "share %",
      "target",
      "achievement %",
      "growth vs previous %",
    ],
    [...branchRows, ...dayRows],
  );
}

// ─── Targets ───

const targetsSchema = z.object({
  branchId: z.string().refine(isUuid, { error: "invalidOption" }),
  year: z.coerce.number().int().min(2000).max(2100),
  /** months.MM = amount; empty clears the month's target. */
  months: z.record(
    z.string().regex(/^(0[1-9]|1[0-2])$/),
    z
      .string()
      .transform((v) => v.trim())
      .pipe(
        z.union([z.literal(""), decimalString({ maxScale: 2, min: "0", max: "999999999999" })]),
      ),
  ),
});

/** Each visible branch's monthly targets for a year. */
export async function listTargets(ctx: TenantContext, year: number) {
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branches = await salesBranches(tx, ctx, {});
    const rows = await tx.salesTarget.findMany({
      where: {
        organizationId: ctx.organizationId,
        branchId: { in: branches.map((b) => b.id) },
        month: {
          gte: new Date(`${year}-01-01T00:00:00Z`),
          lte: new Date(`${year}-12-01T00:00:00Z`),
        },
      },
    });
    return {
      year,
      canManage: holdsAnyGrant(ctx.grants, "sales.targets.manage"),
      branches: branches.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        currency: b.company.currency,
        months: Object.fromEntries(
          rows
            .filter((r) => r.branchId === b.id)
            .map((r) => [
              r.month.toISOString().slice(5, 7),
              { amount: dec(r.netAmount), currency: r.currency },
            ]),
        ) as Record<string, { amount: Decimal; currency: string }>,
      })),
    };
  });
}

/** Set (or clear) a branch's monthly targets for a year, in its company's currency. */
export async function setTargets(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "sales.targets.manage");
  const parsed = targetsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { branchId, year, months } = parsed.data;
  await withTenantTx(ctx.organizationId, async (tx) => {
    const branch = await tx.branch.findFirst({
      where: { organizationId: ctx.organizationId, id: branchId },
      select: { id: true, code: true, company: { select: { currency: true } } },
    });
    if (!branch) throw notFound("Branch");
    const changes: Record<string, string> = {};
    for (const [mm, value] of Object.entries(months)) {
      const month = new Date(`${year}-${mm}-01T00:00:00Z`);
      const key = { organizationId: ctx.organizationId, branchId: branch.id, month };
      if (value === "") {
        const gone = await tx.salesTarget.deleteMany({ where: key });
        if (gone.count > 0) changes[mm] = "";
        continue;
      }
      await tx.salesTarget.upsert({
        where: { organizationId_branchId_month: key },
        create: {
          ...key,
          netAmount: value,
          currency: branch.company.currency,
          updatedByUserId: ctx.userId,
        },
        update: {
          netAmount: value,
          currency: branch.company.currency,
          updatedByUserId: ctx.userId,
        },
      });
      changes[mm] = value;
    }
    await recordAudit(tx, actorOf(ctx), {
      action: "sales_targets.set",
      entityType: "branch",
      entityId: branch.id,
      changes: { year, months: changes },
    });
  });
}
