import "server-only";
import { headers } from "next/headers";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { getCurrentUser } from "@/server/auth/session";
import { withSystemTx } from "@/server/db/transactions";
import { AppError } from "@/server/errors";

/**
 * Route-handler equivalent of requireTenant(): returns a context or an HTTP
 * response (401 when signed out, 404 when not a member — never revealing
 * whether the organization exists).
 */
export async function tenantForRoute(slug: string): Promise<TenantContext | Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const ctx = await withSystemTx((tx) => resolveTenantContext(tx, user.id, slug, requestId));
  return ctx ?? new Response("Not found", { status: 404 });
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Map permission/visibility errors to HTTP statuses for route handlers. */
export function errorResponse(error: unknown): Response {
  if (error instanceof AppError)
    return new Response(error.code, {
      status: error.code === "FORBIDDEN" ? 403 : error.httpStatus,
    });
  throw error;
}
