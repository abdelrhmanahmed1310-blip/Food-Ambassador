import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { REQUEST_PATH_HEADER } from "@/lib/request-path";
import { pathEnabled } from "@/modules/features/access";
import { cache } from "react";
import { requireUser } from "@/server/auth/session";
import { withSystemTx } from "@/server/db/transactions";
import { getRequestId } from "@/server/request";
import { resolveTenantContext, type TenantContext } from "./context";

/**
 * Page/action entry point: the signed-in user's context in organization
 * `slug`. Unauthenticated → sign-in; not a member (or no such org) → 404, so
 * the response never reveals whether another organization exists. A page of a
 * module or function the organization switched off → 404 as well (ADR-137).
 */
export const requireTenant = cache(async (slug: string): Promise<TenantContext> => {
  const user = await requireUser(`/o/${slug}`);
  const requestId = await getRequestId();
  const ctx = await withSystemTx((tx) => resolveTenantContext(tx, user.id, slug, requestId));
  if (!ctx) notFound();
  // A page (or an action posted from it) of a module or function switched off (ADR-137).
  const path = (await headers()).get(REQUEST_PATH_HEADER);
  if (path && !pathEnabled(ctx, slug, path)) notFound();
  return ctx;
});
