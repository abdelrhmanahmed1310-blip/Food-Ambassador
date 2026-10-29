import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { requireUser } from "@/server/auth/session";
import { withSystemTx } from "@/server/db/transactions";
import { getRequestId } from "@/server/request";
import { resolveTenantContext, type TenantContext } from "./context";

/**
 * Page/action entry point: the signed-in user's context in organization
 * `slug`. Unauthenticated → sign-in; not a member (or no such org) → 404, so
 * the response never reveals whether another organization exists.
 */
export const requireTenant = cache(async (slug: string): Promise<TenantContext> => {
  const user = await requireUser(`/o/${slug}`);
  const requestId = await getRequestId();
  const ctx = await withSystemTx((tx) => resolveTenantContext(tx, user.id, slug, requestId));
  if (!ctx) notFound();
  return ctx;
});
