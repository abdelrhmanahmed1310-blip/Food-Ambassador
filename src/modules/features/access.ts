import type { TenantContext } from "@/modules/tenancy/context";
import { featureForPath, isFeatureOn } from "./registry";

/**
 * Module and function switches for a tenant context (ADR-137). The switches
 * shape what an organization uses; they never grant anything — permissions
 * are checked as before.
 */

const disabledOf = (ctx: Pick<TenantContext, "disabledFeatures">) =>
  new Set(ctx.disabledFeatures ?? []);

/** Whether a function is on for this organization. */
export const featureOn = (ctx: Pick<TenantContext, "disabledFeatures">, key: string) =>
  isFeatureOn(key, disabledOf(ctx));

/**
 * Whether a path is usable: a page under /o/{slug}/ whose function is off is
 * not. Paths outside the organization, and pages no function claims, are.
 */
export function pathEnabled(
  ctx: Pick<TenantContext, "disabledFeatures">,
  slug: string,
  path: string,
): boolean {
  const base = `/o/${slug}`;
  if (path !== base && !path.startsWith(`${base}/`)) return true;
  const key = featureForPath(path.slice(base.length));
  return key === null || featureOn(ctx, key);
}
