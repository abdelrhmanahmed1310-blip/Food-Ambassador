import "server-only";
import { accessibleScope, holdsAnyGrant } from "@/modules/access/authorize";
import { businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { forbidden } from "@/server/errors";
import {
  COMPLIANCE_PERIODS,
  complianceScore,
  type ComplianceComponent,
  type ComponentCount,
} from "./compliance-rules";
import { equipmentDues } from "./equipment";

/**
 * Compliance score per branch (DECISIONS.md ADR-100), from recorded facts
 * only, over the last 7, 30 or 90 days ending today (each branch's own
 * calendar):
 * - RECORDS_IN_SPEC: food safety records in spec / records taken;
 * - CHECKLIST_ITEMS_OK: checklist answers OK / answers given;
 * - ACTIONS_ON_TIME: corrective actions due in the period done by their
 *   due date / actions due;
 * - EQUIPMENT_CALIBRATED (now, not the period): equipment with a planned
 *   calibration that is in service, passed its last calibration and is not
 *   overdue / such equipment (never calibrated counts as not calibrated).
 * Open high and critical non-conformances are shown beside the score.
 */

interface Row {
  branch_id: string;
  passed: bigint | number;
  counted: bigint | number;
}

export async function branchCompliance(ctx: TenantContext, options: { days?: number } = {}) {
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) throw forbidden();
  const days = (COMPLIANCE_PERIODS as readonly number[]).includes(options.days ?? 30)
    ? (options.days ?? 30)
    : 30;
  const scope = accessibleScope(ctx.grants, "foodsafety.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const branches = await tx.branch.findMany({
      where: {
        organizationId: ctx.organizationId,
        archivedAt: null,
        ...(scope.all ? {} : { id: { in: scope.branchIds } }),
      },
      select: { id: true, code: true, name: true, timeZone: true },
      orderBy: { code: "asc" },
    });
    const ids = branches.map((b) => b.id);
    if (ids.length === 0) return { days, branches: [] };
    const tz = ctx.timeZone;
    const org = ctx.organizationId;
    // Period bounds are evaluated per branch in SQL: [today - days + 1, today] in its time zone.
    const records = await tx.$queryRaw<Row[]>`
      SELECT r."branch_id", count(*) FILTER (WHERE r."in_spec") AS passed, count(*) AS counted
      FROM "food_safety_records" r JOIN "branches" b ON b."id" = r."branch_id"
      WHERE r."organization_id" = ${org}::uuid AND r."branch_id" = ANY(${ids}::uuid[])
        AND (r."recorded_at" AT TIME ZONE coalesce(b."time_zone", ${tz}))::date
            > (now() AT TIME ZONE coalesce(b."time_zone", ${tz}))::date - ${days}::int
      GROUP BY r."branch_id"`;
    const answers = await tx.$queryRaw<Row[]>`
      SELECT r."branch_id", count(*) FILTER (WHERE a."ok") AS passed, count(*) AS counted
      FROM "checklist_answers" a
      JOIN "checklist_runs" r ON r."id" = a."run_id"
      JOIN "branches" b ON b."id" = r."branch_id"
      WHERE a."organization_id" = ${org}::uuid AND r."branch_id" = ANY(${ids}::uuid[])
        AND (r."completed_at" AT TIME ZONE coalesce(b."time_zone", ${tz}))::date
            > (now() AT TIME ZONE coalesce(b."time_zone", ${tz}))::date - ${days}::int
      GROUP BY r."branch_id"`;
    const actions = await tx.$queryRaw<Row[]>`
      SELECT n."branch_id",
        count(*) FILTER (WHERE a."done_at" IS NOT NULL
          AND (a."done_at" AT TIME ZONE coalesce(b."time_zone", ${tz}))::date <= a."due_on") AS passed,
        count(*) AS counted
      FROM "corrective_actions" a
      JOIN "non_conformances" n ON n."id" = a."non_conformance_id"
      JOIN "branches" b ON b."id" = n."branch_id"
      WHERE a."organization_id" = ${org}::uuid AND n."branch_id" = ANY(${ids}::uuid[])
        AND a."due_on" IS NOT NULL
        AND a."due_on" > (now() AT TIME ZONE coalesce(b."time_zone", ${tz}))::date - ${days}::int
        AND a."due_on" <= (now() AT TIME ZONE coalesce(b."time_zone", ${tz}))::date
      GROUP BY n."branch_id"`;
    const equipment = await tx.equipment.findMany({
      where: {
        organizationId: ctx.organizationId,
        branchId: { in: ids },
        status: { not: "RETIRED" },
      },
      select: {
        branchId: true,
        status: true,
        createdAt: true,
        calibrationIntervalDays: true,
        maintenanceIntervalDays: true,
        calibrations: {
          orderBy: [{ performedOn: "desc" }, { recordedAt: "desc" }],
          take: 1,
          select: { result: true, nextDueOn: true },
        },
      },
    });
    const openNcs = await tx.nonConformance.groupBy({
      by: ["branchId"],
      where: {
        organizationId: ctx.organizationId,
        branchId: { in: ids },
        status: { not: "CLOSED" },
        severity: { in: ["HIGH", "CRITICAL"] },
      },
      _count: { _all: true },
    });
    const today = businessDate(tz);
    const count = (rows: Row[], branchId: string, key: ComplianceComponent): ComponentCount => {
      const r = rows.find((x) => x.branch_id === branchId);
      return { key, passed: Number(r?.passed ?? 0), counted: Number(r?.counted ?? 0) };
    };
    return {
      days,
      branches: branches.map((b) => {
        const branchToday = b.timeZone ? businessDate(b.timeZone) : today;
        const states = equipment
          .filter((e) => e.branchId === b.id)
          .map((e) => ({
            status: e.status,
            passedLast: e.calibrations[0]?.result === "PASS",
            state: equipmentDues(e, e.calibrations[0], undefined, branchToday).calibrationState,
          }));
        // Planned: a calibration is due at some point, or a failed one took it out of service.
        const planned = states.filter((e) => e.state !== "NOT_PLANNED" || e.status !== "ACTIVE");
        const calibrated = planned.filter(
          (e) => e.status === "ACTIVE" && e.passedLast && e.state !== "OVERDUE",
        );
        const score = complianceScore([
          count(records, b.id, "RECORDS_IN_SPEC"),
          count(answers, b.id, "CHECKLIST_ITEMS_OK"),
          count(actions, b.id, "ACTIONS_ON_TIME"),
          { key: "EQUIPMENT_CALIBRATED", passed: calibrated.length, counted: planned.length },
        ]);
        return {
          branch: { id: b.id, code: b.code, name: b.name },
          ...score,
          openSeriousNcs: openNcs.find((n) => n.branchId === b.id)?._count._all ?? 0,
        };
      }),
    };
  });
}
