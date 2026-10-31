import { canSeeReports, exportBranchComparisonCsv } from "@/modules/analytics/service";
import { reportPeriod } from "@/server/report-period";
import { csvResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/reports/food-cost/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!canSeeReports(ctx).foodCost) return new Response("Not found", { status: 404 });
  const period = reportPeriod(Object.fromEntries(new URL(request.url).searchParams), ctx.timeZone);
  try {
    return csvResponse(
      await exportBranchComparisonCsv(ctx, period),
      `food-cost-${period.from}-${period.to}.csv`,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
