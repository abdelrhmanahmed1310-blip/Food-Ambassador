import "server-only";
import { accessibleScope, holdsAnyGrant } from "@/modules/access/authorize";
import { branchCompliance } from "@/modules/foodsafety/compliance";
import { listEquipment } from "@/modules/foodsafety/equipment";
import { addDays, businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import type { NewProposal } from "./replenishment";
import type { Finding, FoodSafetySettings } from "./rules";

/**
 * The food safety agent (DECISIONS.md ADR-142): per branch it may see, it
 * reports corrective actions past their due date, open high and critical
 * non-conformances, equipment overdue for calibration or maintenance, stock
 * past or near its expiry date and a 30-day compliance score (ADR-100) below
 * the set level. For expired stock still available and for equipment in
 * service past its calibration date it proposes raising a non-conformance;
 * the approver raises it with their own access. It changes nothing itself.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);

export function canRunFoodSafety(ctx: TenantContext) {
  return holdsAnyGrant(ctx.grants, "foodsafety.view");
}

export async function runFoodSafety(
  ctx: TenantContext,
  settings: FoodSafetySettings,
  count: () => void,
) {
  const org = ctx.organizationId;
  const scope = accessibleScope(ctx.grants, "foodsafety.view");
  const branches = await withTenantTx(org, (tx) =>
    tx.branch.findMany({
      where: {
        organizationId: org,
        archivedAt: null,
        ...(settings.branchIds.length ? { id: { in: settings.branchIds } } : {}),
        ...(scope.all ? {} : { id: { in: scope.branchIds } }),
      },
      select: { id: true, code: true, timeZone: true },
      orderBy: { code: "asc" },
    }),
  );
  count();
  const ids = branches.map((b) => b.id);
  const findings: Finding[] = [];
  const proposals: NewProposal[] = [];
  if (ids.length === 0)
    return { summary: { branches: 0, findings: 0, proposals: 0 }, findings, proposals };
  const today = (b: (typeof branches)[number]) => businessDate(b.timeZone ?? ctx.timeZone);

  const data = await withTenantTx(org, async (tx) => ({
    actions: await tx.correctiveAction.findMany({
      where: {
        organizationId: org,
        status: "OPEN",
        dueOn: { not: null },
        nonConformance: { branchId: { in: ids }, status: { not: "CLOSED" } },
      },
      select: {
        dueOn: true,
        nonConformance: { select: { id: true, number: true, branchId: true } },
      },
    }),
    ncs: await tx.nonConformance.findMany({
      where: {
        organizationId: org,
        branchId: { in: ids },
        status: { not: "CLOSED" },
        severity: { in: ["HIGH", "CRITICAL"] },
      },
      select: { id: true, number: true, branchId: true, severity: true, raisedAt: true },
    }),
    stock: await tx.stockBalance.findMany({
      where: {
        organizationId: org,
        onHandQuantity: { gt: 0 },
        stockStatus: "AVAILABLE",
        warehouse: { branchId: { in: ids }, archivedAt: null },
        lot: {
          expiresOn: {
            not: null,
            lte: new Date(
              `${addDays(businessDate(ctx.timeZone), settings.expiringWithinDays + 1)}T00:00:00Z`,
            ),
          },
        },
      },
      select: {
        onHandQuantity: true,
        warehouse: { select: { code: true, branchId: true } },
        product: { select: { sku: true, baseUom: { select: { code: true } } } },
        lot: { select: { id: true, lotCode: true, expiresOn: true } },
      },
      take: 500,
    }),
  }));
  count();
  const equipment = (await listEquipment(ctx)).filter((e) => ids.includes(e.branchId));
  count();
  const compliance = await branchCompliance(ctx, { days: 30 });
  count();

  for (const b of branches) {
    const t = today(b);
    // Corrective actions past due, per non-conformance.
    const late = new Map<string, { number: string; count: number; id: string }>();
    for (const a of data.actions)
      if (a.nonConformance.branchId === b.id && a.dueOn && day(a.dueOn) < t) {
        const k = a.nonConformance.id;
        const e = late.get(k) ?? { number: a.nonConformance.number, count: 0, id: k };
        e.count += 1;
        late.set(k, e);
      }
    for (const nc of late.values())
      findings.push({
        severity: "WARNING",
        code: "ACTIONS_OVERDUE",
        params: { branch: b.code, nc: nc.number, count: nc.count },
        link: `food-safety/non-conformances/${nc.id}`,
        branchId: b.id,
      });
    for (const nc of data.ncs.filter((n) => n.branchId === b.id))
      findings.push({
        severity: nc.severity === "CRITICAL" ? "CRITICAL" : "WARNING",
        code: "NC_OPEN",
        params: { branch: b.code, nc: nc.number, severity: nc.severity, since: day(nc.raisedAt) },
        link: `food-safety/non-conformances/${nc.id}`,
        branchId: b.id,
      });
    for (const e of equipment.filter((x) => x.branchId === b.id)) {
      if (e.calibrationState === "OVERDUE") {
        findings.push({
          severity: e.status === "ACTIVE" ? "WARNING" : "INFO",
          code: "CALIBRATION_OVERDUE",
          params: { branch: b.code, equipment: e.code },
          link: `food-safety/equipment/${e.id}`,
          branchId: b.id,
        });
        if (e.status === "ACTIVE")
          proposals.push({
            kind: "RAISE_NC",
            title: `${b.code} · ${e.code}`,
            detail: {
              branch: b.code,
              severity: "MEDIUM",
              reason: "CALIBRATION_OVERDUE",
              equipment: e.code,
              equipmentName: e.name,
            },
            branchId: b.id,
            entityType: "equipment",
            entityId: e.id,
          });
      }
      if (e.maintenanceState === "OVERDUE")
        findings.push({
          severity: "INFO",
          code: "MAINTENANCE_OVERDUE",
          params: { branch: b.code, equipment: e.code },
          link: `food-safety/equipment/${e.id}`,
          branchId: b.id,
        });
    }
    // Stock past or near its expiry date, available to use.
    const soon = addDays(t, settings.expiringWithinDays);
    const byLot = new Map<
      string,
      { sku: string; lot: string; expires: string; warehouses: Set<string>; quantity: string[] }
    >();
    for (const s of data.stock) {
      if (s.warehouse.branchId !== b.id || !s.lot?.expiresOn) continue;
      const expires = day(s.lot.expiresOn);
      if (expires > soon) continue;
      const e = byLot.get(s.lot.id) ?? {
        sku: s.product.sku,
        lot: s.lot.lotCode,
        expires,
        warehouses: new Set<string>(),
        quantity: [],
      };
      e.warehouses.add(s.warehouse.code);
      e.quantity.push(`${s.onHandQuantity.toString()} ${s.product.baseUom.code}`);
      byLot.set(s.lot.id, e);
    }
    for (const [lotId, l] of byLot) {
      const expired = l.expires < t;
      findings.push({
        severity: expired ? "CRITICAL" : "INFO",
        code: expired ? "EXPIRED_STOCK" : "EXPIRING_STOCK",
        params: {
          branch: b.code,
          sku: l.sku,
          lot: l.lot,
          date: l.expires,
          warehouses: [...l.warehouses].join(", "),
        },
        link: "inventory",
        branchId: b.id,
      });
      if (expired)
        proposals.push({
          kind: "RAISE_NC",
          title: `${b.code} · ${l.sku} · ${l.lot}`,
          detail: {
            branch: b.code,
            severity: "HIGH",
            reason: "EXPIRED_STOCK",
            sku: l.sku,
            lot: l.lot,
            expiredOn: l.expires,
            warehouses: [...l.warehouses].join(", "),
            quantity: l.quantity.join(" + "),
          },
          branchId: b.id,
          entityType: "inventory_lot",
          entityId: lotId,
        });
    }
    const score = compliance.branches.find((x) => x.branch.id === b.id)?.overall ?? null;
    if (score !== null && score < settings.complianceBelowPercent)
      findings.push({
        severity: "WARNING",
        code: "LOW_COMPLIANCE",
        params: { branch: b.code, score, threshold: settings.complianceBelowPercent },
        link: "food-safety/compliance",
        branchId: b.id,
      });
  }
  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return {
    summary: { branches: branches.length, findings: findings.length, proposals: proposals.length },
    findings,
    proposals,
  };
}
