import { exportHrSeriesCsv } from "@/modules/hr-analytics/service";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** The monthly headcount and turnover series (ADR-130). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/hr/analytics/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  const q = new URL(request.url).searchParams;
  try {
    return exportResponse(
      request,
      await exportHrSeriesCsv(ctx, {
        from: q.get("from") ?? undefined,
        to: q.get("to") ?? undefined,
        branchId: q.get("branch") ?? undefined,
      }),
      "hr-headcount.csv",
    );
  } catch (error) {
    return errorResponse(error);
  }
}
