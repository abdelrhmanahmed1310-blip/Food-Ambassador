import "server-only";
import { assertPermission } from "@/modules/access/authorize";
import { membersWithGrantsInTx, notifyInTx } from "@/modules/notifications/service";
import { hasPermission } from "@/modules/access/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import { usageLeft } from "@/modules/usage/service";
import type { LimitKey } from "@/modules/usage/rules";
import { limitWindow } from "@/modules/usage/rules";
import { businessDate } from "@/modules/inventory/rules";
import { withSystemTx, withTenantTx } from "@/server/db/transactions";
import { crossedThreshold, type StatementLine } from "./rules";

/**
 * The organization's side of billing (DECISIONS.md ADR-147): its plan and
 * its statements, read-only; and the limit warnings sent to its settings
 * managers at 80 % and 100 % of each usage limit (ADR-146).
 */

export async function myBilling(ctx: TenantContext) {
  assertPermission(ctx.grants, "org.settings.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: {
        billingPlanSince: true,
        billingPlan: { select: { code: true, name: true, currency: true, monthlyFee: true } },
      },
    });
    const statements = await tx.billingStatement.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { month: "desc" },
      take: 24,
    });
    return {
      plan: org.billingPlan,
      since: org.billingPlanSince,
      statements: statements.map((s) => ({ ...s, lines: s.lines as unknown as StatementLine[] })),
    };
  });
}

const KEYS: LimitKey[] = ["agentActionsPerMonth", "aiTokensPerMonth", "mcpCallsPerDay"];

/**
 * For the job runner: tell each organization's settings managers once per
 * period when a usage limit passes 80 % and when it is reached.
 */
export async function warnUsageLimits() {
  const orgs = await withSystemTx((tx) =>
    tx.organization.findMany({
      where: { status: "ACTIVE", NOT: { usageLimits: { equals: {} } } },
      select: { id: true, timeZone: true },
    }),
  );
  let sent = 0;
  for (const o of orgs) {
    for (const key of KEYS) {
      const u = await usageLeft(o.id, key);
      const at = crossedThreshold(u.used, u.limit);
      if (!at) continue;
      const w = limitWindow(key, businessDate(o.timeZone));
      sent += await withTenantTx(o.id, async (tx) => {
        const users = (await membersWithGrantsInTx(tx, o.id))
          .filter((m) => hasPermission(m.grants, "org.settings.manage"))
          .map((m) => m.userId);
        await notifyInTx(tx, o.id, users, {
          kind: at === 100 ? "USAGE_LIMIT_REACHED" : "USAGE_LIMIT_NEAR",
          params: { limit: key, used: u.used, cap: u.limit ?? 0 },
          link: "/settings/usage",
          dedupeKey: `usage:${key}:${w.from}:${at}`,
        });
        return users.length ? 1 : 0;
      });
    }
  }
  return { sent };
}
