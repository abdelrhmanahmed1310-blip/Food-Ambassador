import { canSeeReports, exportWasteCsv } from "@/modules/analytics/service";
import { reportPeriod } from "@/server/report-period";
import { csvResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/reports/waste/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!canSeeReports(ctx).waste) return new Response("Not found", { status: 404 });
  const period = reportPeriod(Object.fromEntries(new URL(request.url).searchParams), ctx.timeZone);
  try {
    return csvResponse(await exportWasteCsv(ctx, period), `waste-${period.from}-${period.to}.csv`);
  } catch (error) {
    return errorResponse(error);
  }
}
