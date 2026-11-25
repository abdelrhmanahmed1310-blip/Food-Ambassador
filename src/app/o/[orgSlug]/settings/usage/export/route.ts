import { usageStatementCsv } from "@/modules/usage/service";
import { errorResponse, exportResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** The month's usage statement as CSV or Excel (ADR-146). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/settings/usage/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  const month = new URL(request.url).searchParams.get("month") ?? "";
  try {
    const csv = await usageStatementCsv(ctx, month);
    return exportResponse(request, csv, `usage-${ctx.organizationSlug}-${month || "current"}.csv`);
  } catch (error) {
    return errorResponse(error);
  }
}
