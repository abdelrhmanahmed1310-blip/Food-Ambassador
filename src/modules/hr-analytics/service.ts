import "server-only";
import { z } from "zod";
import { toCsv } from "@/lib/csv";
import { Decimal } from "@/lib/decimal";
import { accessibleScope, hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { canViewHr } from "@/modules/hr/service";
import { businessDate } from "@/modules/inventory/rules";
import { trainingComplianceSummaryInTx } from "@/modules/learning/service";
import { distribution } from "@/modules/performance/rules";
import { canViewRecruitment } from "@/modules/recruitment/service";
import { shiftOutcomesInTx } from "@/modules/rosters/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { forbidden } from "@/server/errors";
import {
  absenceRate,
  daysBetween,
  daysStats,
  employedOn,
  monthBounds,
  monthlySeries,
  monthsBetween,
  newHireRetention,
  overlapDays,
  pct,
  rangeSummary,
  tenureBands,
} from "./rules";

/**
 * HR analytics (DECISIONS.md ADR-130): one page over the HR modules for a
 * range of months and, optionally, one branch. Each section shows only to
 * those who may see its source — pay with `payroll.view`, recruitment,
 * training and performance with their own rights — and every count is
 * limited to the branches the user sees in HR. Nothing is per person.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);
const dec = (v: { toString(): string } | null | undefined) => new Decimal(v?.toString() ?? "0");

function hrBranchIds(ctx: TenantContext): string[] | null {
  const v = accessibleScope(ctx.grants, "hr.view");
  const m = accessibleScope(ctx.grants, "hr.manage");
  if (v.all || m.all) return null;
  return [...new Set([...v.branchIds, ...m.branchIds])];
}

export interface AnalyticsInput {
  from?: unknown;
  to?: unknown;
  branchId?: unknown;
}

/** The months asked for: the last twelve by default, at most 36, never in the future. */
export function resolveRange(input: AnalyticsInput, today: string) {
  const current = today.slice(0, 7);
  const to = z
    .string()
    .regex(MONTH)
    .catch(current)
    .parse(input.to ?? current);
  const toMonth = to > current ? current : to;
  const [y, m] = toMonth.split("-").map(Number);
  const back = new Date(Date.UTC(y, m - 12, 1)).toISOString().slice(0, 7);
  let from = z
    .string()
    .regex(MONTH)
    .catch(back)
    .parse(input.from ?? back);
  if (from > toMonth) from = toMonth;
  const months = monthsBetween(from, toMonth).slice(-36);
  const start = monthBounds(months[0]).start;
  const endOfLast = monthBounds(months.at(-1)!).end;
  return { months, start, end: endOfLast < today ? endOfLast : today };
}

export async function hrAnalytics(ctx: TenantContext, input: AnalyticsInput = {}) {
  if (!canViewHr(ctx)) throw forbidden();
  const today = businessDate(ctx.timeZone);
  const range = resolveRange(input, today);
  const scope = hrBranchIds(ctx);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branches = await tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(scope ? { id: { in: scope } } : {}),
      },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    });
    const chosen = branches.find((b) => b.id === input.branchId) ?? null;
    const ids = chosen ? [chosen.id] : scope;
    const inBranches = ids ? { branchId: { in: ids } } : {};

    // ─── People ───
    const employees = await tx.employee.findMany({
      where: { organizationId: ctx.organizationId, ...inBranches },
      select: {
        hireDate: true,
        terminatedOn: true,
        branchId: true,
        department: { select: { name: true } },
      },
    });
    const people = employees.map((e) => ({
      hireDate: iso(e.hireDate),
      terminatedOn: e.terminatedOn ? iso(e.terminatedOn) : null,
      branchId: e.branchId,
      department: e.department?.name ?? null,
    }));
    const series = monthlySeries(people, range.months);
    const summary = rangeSummary(series);
    const at = range.end;
    const now = people.filter((p) => employedOn(p, at));
    const count = <K extends string>(keys: (string | null)[]) => {
      const m = new Map<string, number>();
      for (const k of keys) m.set(k ?? "", (m.get(k ?? "") ?? 0) + 1);
      return [...m.entries()].map(([key, n]) => ({ key: key as K, count: n }));
    };
    const code = new Map(branches.map((b) => [b.id, b.code]));
    const people_ = {
      at,
      byBranch: count(now.map((p) => code.get(p.branchId) ?? "—")).sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
      byDepartment: count(now.map((p) => p.department)).sort((a, b) => b.count - a.count),
      tenure: tenureBands(people, at),
      newHireRetention: newHireRetention(people, range.start, range.end, today),
    };

    // ─── Absence: approved leave days inside the range ───
    const leave = await tx.leaveRequest.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: "APPROVED",
        startDate: { lte: asDate(range.end) },
        endDate: { gte: asDate(range.start) },
        employee: inBranches,
      },
      select: {
        startDate: true,
        endDate: true,
        leaveType: { select: { name: true, paid: true } },
      },
    });
    const byType = new Map<string, { type: string; paid: boolean; days: number }>();
    let leaveDays = 0;
    for (const l of leave) {
      const d = overlapDays(iso(l.startDate), iso(l.endDate), range.start, range.end);
      leaveDays += d;
      const r = byType.get(l.leaveType.name) ?? {
        type: l.leaveType.name,
        paid: l.leaveType.paid,
        days: 0,
      };
      r.days += d;
      byType.set(l.leaveType.name, r);
    }
    const rangeDays = daysBetween(range.start, range.end) + 1;
    const absence = {
      days: leaveDays,
      rate: absenceRate(leaveDays, summary.averageHeadcount, rangeDays),
      byType: [...byType.values()].sort((a, b) => b.days - a.days),
    };

    // ─── Rosters: how published shifts went ───
    const rosterRaw = await shiftOutcomesInTx(tx, ctx, {
      from: range.start,
      to: range.end,
      branchIds: ids,
    });
    const rosters = {
      ...rosterRaw,
      noShowRate: pct(rosterRaw.noShow, rosterRaw.shifts - rosterRaw.onLeave),
      lateRate: pct(rosterRaw.late, rosterRaw.shifts - rosterRaw.onLeave - rosterRaw.noShow),
    };

    // ─── Recruitment ───
    let recruitment = null;
    if (canViewRecruitment(ctx)) {
      const openingIn = ids ? { branchId: { in: ids } } : {};
      const from = asDate(range.start);
      const to = new Date(asDate(range.end).getTime() + 86_400_000);
      const [approved, events, hires] = await Promise.all([
        tx.jobOpening.findMany({
          where: {
            organizationId: ctx.organizationId,
            ...openingIn,
            decidedAt: { gte: from, lt: to },
            status: { not: "REJECTED" },
          },
          select: { headcount: true, _count: { select: { applications: true } } },
        }),
        tx.applicationEvent.findMany({
          where: {
            organizationId: ctx.organizationId,
            at: { gte: from, lt: to },
            fromStage: "OFFER",
            application: { opening: openingIn },
          },
          select: { toStage: true },
        }),
        tx.jobApplication.findMany({
          where: {
            organizationId: ctx.organizationId,
            stage: "HIRED",
            opening: openingIn,
            employee: { hireDate: { gte: from, lt: to } },
          },
          select: {
            candidate: { select: { source: true } },
            employee: { select: { hireDate: true } },
            opening: { select: { decidedAt: true } },
          },
        }),
      ]);
      const accepted = events.filter((e) => e.toStage === "HIRED").length;
      const lost = events.filter(
        (e) => e.toStage === "REJECTED" || e.toStage === "WITHDRAWN",
      ).length;
      const sources = new Map<string, number>();
      for (const h of hires)
        sources.set(h.candidate.source, (sources.get(h.candidate.source) ?? 0) + 1);
      recruitment = {
        openings: approved.length,
        places: approved.reduce((a, o) => a + o.headcount, 0),
        applicationsPerOpening: approved.length
          ? Math.round(
              (approved.reduce((a, o) => a + o._count.applications, 0) / approved.length) * 10,
            ) / 10
          : null,
        hires: hires.length,
        timeToHire: daysStats(
          hires
            .filter((h) => h.opening.decidedAt && h.employee)
            .map((h) =>
              Math.max(0, daysBetween(iso(h.opening.decidedAt!), iso(h.employee!.hireDate))),
            ),
        ),
        offerAcceptance: pct(accepted, accepted + lost),
        sources: [...sources.entries()]
          .map(([source, n]) => ({ source, count: n }))
          .sort((a, b) => b.count - a.count),
      };
    }

    // ─── Pay: approved and paid runs, by month and currency ───
    let pay = null;
    if (hasPermission(ctx.grants, "payroll.view")) {
      const lines = await tx.payrollLine.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(ids ? { branchId: { in: ids } } : {}),
          run: {
            status: { in: ["APPROVED", "PAID"] },
            period: { gte: asDate(range.start), lte: asDate(range.end) },
          },
        },
        select: {
          gross: true,
          employerCost: true,
          run: { select: { period: true, currency: true } },
        },
      });
      const rows = new Map<
        string,
        { month: string; currency: string; gross: Decimal; employerCost: Decimal; people: number }
      >();
      for (const l of lines) {
        const month = iso(l.run.period).slice(0, 7);
        const k = `${month}|${l.run.currency}`;
        const r = rows.get(k) ?? {
          month,
          currency: l.run.currency,
          gross: new Decimal(0),
          employerCost: new Decimal(0),
          people: 0,
        };
        r.gross = r.gross.plus(dec(l.gross));
        r.employerCost = r.employerCost.plus(dec(l.employerCost));
        r.people++;
        rows.set(k, r);
      }
      pay = [...rows.values()]
        .sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency))
        .map((r) => ({
          ...r,
          gross: r.gross.toFixed(2),
          employerCost: r.employerCost.toFixed(2),
          perHead: r.employerCost.dividedBy(r.people).toFixed(2),
        }));
    }

    // ─── Training compliance today ───
    const canTraining =
      holdsAnyGrant(ctx.grants, "training.view") || holdsAnyGrant(ctx.grants, "training.manage");
    const training = canTraining ? await trainingComplianceSummaryInTx(tx, ctx, ids) : null;

    // ─── Performance: ratings of reviews in cycles ending in the range ───
    let performance = null;
    if (
      holdsAnyGrant(ctx.grants, "performance.view") ||
      holdsAnyGrant(ctx.grants, "performance.manage")
    ) {
      const reviews = await tx.performanceReview.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: { in: ["FINALIZED", "ACKNOWLEDGED", "MANAGER_DONE"] },
          cycle: { periodEnd: { gte: asDate(range.start), lte: asDate(range.end) } },
          employee: inBranches,
        },
        select: { finalRating: true, managerRating: true },
      });
      const d = distribution(reviews);
      const rated = Object.values(d).reduce((a, n) => a + n, 0);
      performance = { reviews: reviews.length, rated, distribution: d };
    }

    return {
      range,
      branches,
      branch: chosen,
      series,
      summary,
      people: people_,
      absence,
      rosters,
      recruitment,
      pay,
      training: training
        ? { ...training, rate: pct(training.compliant + training.expiring, training.required) }
        : null,
      performance,
    };
  });
}

/** The monthly headcount series as CSV. */
export async function exportHrSeriesCsv(ctx: TenantContext, input: AnalyticsInput = {}) {
  const r = await hrAnalytics(ctx, input);
  return toCsv(
    ["month", "headcount_start", "headcount_end", "hires", "leavers", "turnover_percent"],
    r.series.map((m) => [m.month, m.start, m.end, m.hires, m.leavers, m.turnover ?? ""]),
  );
}
