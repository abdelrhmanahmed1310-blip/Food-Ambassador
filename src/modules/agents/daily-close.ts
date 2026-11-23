import "server-only";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, holdsAnyGrant } from "@/modules/access/authorize";
import { addDays, businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { dailyCloseFindings, type BranchDay, type DailyCloseSettings } from "./rules";

/**
 * The daily close agent (DECISIONS.md ADR-140): after the day, per branch it
 * may see, it checks shifts left open, cash counted against expected, voids,
 * refunds, sales against the same weekday a week earlier and stock shortfalls
 * not posted, and reports what needs a look. It only reads.
 */

const dec = (v: unknown) => new Decimal(v === null || v === undefined ? 0 : String(v));
const localDate = (at: Date, timeZone: string) => businessDate(timeZone, at);

/** Branches the agent may look at: where its person sells, manages or sees the POS. */
function branchScope(ctx: TenantContext) {
  const scopes = ["pos.manage", "pos.view", "pos.sell"].map((p) =>
    accessibleScope(ctx.grants, p as "pos.manage"),
  );
  if (scopes.some((s) => s.all)) return "all" as const;
  return new Set(scopes.flatMap((s) => (s.all ? [] : s.branchIds)));
}

export function canRunDailyClose(ctx: TenantContext) {
  return ["pos.manage", "pos.view", "pos.sell"].some((p) =>
    holdsAnyGrant(ctx.grants, p as "pos.manage"),
  );
}

export async function runDailyClose(
  ctx: TenantContext,
  settings: DailyCloseSettings,
  date: string | null,
  count: () => void,
) {
  const org = ctx.organizationId;
  const day = date ?? addDays(businessDate(ctx.timeZone), -1);
  const weekAgo = addDays(day, -7);
  const scope = branchScope(ctx);
  const branches = await withTenantTx(org, (tx) =>
    tx.branch.findMany({
      where: {
        organizationId: org,
        archivedAt: null,
        ...(settings.branchIds.length ? { id: { in: settings.branchIds } } : {}),
        ...(scope === "all" ? {} : { id: { in: [...scope] } }),
      },
      select: { id: true, code: true, name: true, timeZone: true },
      orderBy: { code: "asc" },
    }),
  );
  count();
  const days: BranchDay[] = [];
  const figures: Array<Record<string, string | number>> = [];
  for (const b of branches) {
    const tz = b.timeZone ?? ctx.timeZone;
    const data = await withTenantTx(org, async (tx) => {
      const where = { organizationId: org, branchId: b.id };
      const [registers, paid, voided, refunded, before, openShifts, closedShifts, shortfalls] =
        await Promise.all([
          tx.posRegister.count({ where: { ...where, archivedAt: null } }),
          tx.posOrder.aggregate({
            where: { ...where, status: "PAID", businessDate: new Date(day) },
            _count: true,
            _sum: { grossAmount: true },
          }),
          tx.posOrder.aggregate({
            where: { ...where, status: "VOIDED", businessDate: new Date(day) },
            _count: true,
            _sum: { grossAmount: true },
          }),
          tx.posOrder.aggregate({
            where: { ...where, businessDate: new Date(day), refundedAmount: { gt: 0 } },
            _count: true,
            _sum: { refundedAmount: true },
          }),
          tx.posOrder.aggregate({
            where: { ...where, status: "PAID", businessDate: new Date(weekAgo) },
            _count: true,
            _sum: { grossAmount: true },
          }),
          tx.posShift.findMany({
            where: { organizationId: org, status: "OPEN", register: { branchId: b.id } },
            select: { openedAt: true, register: { select: { code: true } } },
          }),
          tx.posShift.findMany({
            where: {
              organizationId: org,
              status: "CLOSED",
              register: { branchId: b.id },
              // A day either side, then exactly by the branch's local date.
              closedAt: {
                gte: new Date(`${addDays(day, -1)}T00:00:00Z`),
                lt: new Date(`${addDays(day, 2)}T00:00:00Z`),
              },
            },
            select: {
              number: true,
              closedAt: true,
              cashDifference: true,
              register: { select: { code: true } },
            },
          }),
          tx.warehouse
            .findMany({ where: { organizationId: org, branchId: b.id }, select: { id: true } })
            .then((ws) =>
              tx.posConsumptionShortfall.count({
                where: {
                  organizationId: org,
                  status: "OPEN",
                  warehouseId: { in: ws.map((w) => w.id) },
                },
              }),
            ),
        ]);
      return { registers, paid, voided, refunded, before, openShifts, closedShifts, shortfalls };
    });
    count();
    const sales = dec(data.paid._sum.grossAmount);
    days.push({
      branchId: b.id,
      code: b.code,
      registers: data.registers,
      orders: data.paid._count,
      sales,
      voids: data.voided._count,
      voidAmount: dec(data.voided._sum.grossAmount),
      refunds: data.refunded._count,
      refundAmount: dec(data.refunded._sum.refundedAmount),
      salesWeekAgo: data.before._count > 0 ? dec(data.before._sum.grossAmount) : null,
      shiftsLeftOpen: data.openShifts
        // Opened on or before the day checked and still open once that day is over.
        .filter((s) => localDate(s.openedAt, tz) <= day)
        .map((s) => ({ register: s.register.code, openedOn: localDate(s.openedAt, tz) })),
      cashDifferences: data.closedShifts
        .filter((s) => s.closedAt && localDate(s.closedAt, tz) === day && s.cashDifference !== null)
        .map((s) => ({
          register: s.register.code,
          shift: s.number,
          difference: dec(s.cashDifference),
        })),
      shortfalls: data.shortfalls,
    });
    figures.push({
      branchId: b.id,
      code: b.code,
      name: b.name,
      orders: data.paid._count,
      sales: sales.toFixed(2),
      voids: data.voided._count,
      refunds: data.refunded._count,
    });
  }
  const findings = dailyCloseFindings(days, settings);
  return {
    businessDate: day,
    summary: { branches: branches.length, findings: findings.length, figures },
    findings,
  };
}
