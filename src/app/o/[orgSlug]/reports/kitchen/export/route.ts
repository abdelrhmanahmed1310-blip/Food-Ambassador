import {
  canSeeKitchenPerformance,
  exportKitchenCsv,
} from "@/modules/analytics/kitchen-performance";
import { isUuid } from "@/lib/uuid";
import { reportPeriod } from "@/server/report-period";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** CSV (or Excel with ?format=xlsx) of kitchen performance (ADR-108). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/reports/kitchen/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!canSeeKitchenPerformance(ctx)) return new Response("Not found", { status: 404 });
  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const period = reportPeriod(sp, ctx.timeZone);
  const branchId = sp.branch && isUuid(sp.branch) ? sp.branch : undefined;
  try {
    return exportResponse(
      request,
      await exportKitchenCsv(ctx, period, { branchId }),
      `kitchen-${period.from}-${period.to}.csv`,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
