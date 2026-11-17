import "server-only";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation } from "@/server/errors";
import {
  cleanEntries,
  dependencyProblems,
  isFeatureOn,
  isSwitchableModule,
  moduleEntry,
  MODULES,
} from "./registry";

/**
 * Settings → Modules (DECISIONS.md ADR-137): switch whole modules or single
 * functions off for the organization. Needs org.settings.manage.
 */

/** Every module with its functions and whether each is on. */
export async function getFeatureSettings(ctx: TenantContext) {
  assertPermission(ctx.grants, "org.settings.manage");
  const org = await withTenantTx(ctx.organizationId, (tx) =>
    tx.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: { disabledFeatures: true },
    }),
  );
  const disabled = new Set(org.disabledFeatures);
  return MODULES.map((m) => ({
    key: m.key,
    switchable: isSwitchableModule(m),
    on: !disabled.has(moduleEntry(m.key)),
    requires: m.requires ?? [],
    features: m.features.map((f) => ({
      key: f.key,
      core: f.core === true,
      on: !disabled.has(f.key) || f.core === true,
      effective: isFeatureOn(f.key, disabled),
      requires: f.requires ?? [],
    })),
  }));
}

/**
 * Save the switches from a form: `module:<key>` and `feature:<key>` fields are
 * present when on. Core functions are always on. Refused, with the pairs, when
 * a function that stays on needs one that would be off.
 */
export async function saveFeatureSettings(ctx: TenantContext, form: Record<string, unknown>) {
  assertPermission(ctx.grants, "org.settings.manage");
  const on = (name: string) => form[name] === "on" || form[name] === "true";
  const entries: string[] = [];
  for (const m of MODULES) {
    if (isSwitchableModule(m) && !on(`module:${m.key}`)) entries.push(moduleEntry(m.key));
    for (const f of m.features) if (!f.core && !on(`feature:${f.key}`)) entries.push(f.key);
  }
  const disabled = cleanEntries(entries);
  const problems = dependencyProblems(new Set(disabled));
  if (problems.length > 0)
    throw businessRuleViolation(
      "FEATURE_REQUIRED",
      "A function that stays on needs one that would be switched off",
      { pairs: problems.map(([f, r]) => `${f}>${r}`).join(",") },
    );
  return withTenantTx(ctx.organizationId, async (tx) => {
    const before = await tx.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: { disabledFeatures: true },
    });
    const was = new Set(before.disabledFeatures);
    const now = new Set(disabled);
    const switchedOff = disabled.filter((e) => !was.has(e));
    const switchedOn = before.disabledFeatures.filter((e) => !now.has(e));
    if (switchedOff.length === 0 && switchedOn.length === 0) return { switchedOff, switchedOn };
    await tx.organization.update({
      where: { id: ctx.organizationId },
      data: { disabledFeatures: disabled },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "organization.features_changed",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: { switchedOff, switchedOn },
    });
    return { switchedOff, switchedOn };
  });
}

/**
 * For callers without a member's context (REST API keys, public ordering
 * pages, the time clock): whether a function is on for an organization.
 */
export async function organizationFeatureOn(organizationId: string, key: string) {
  const org = await withSystemTx((tx) =>
    tx.organization.findUnique({
      where: { id: organizationId },
      select: { disabledFeatures: true },
    }),
  );
  return org ? isFeatureOn(key, new Set(org.disabledFeatures)) : false;
}
