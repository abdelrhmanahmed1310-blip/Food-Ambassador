import { canSeeSales, exportSalesCsv } from "@/modules/analytics/sales";
import { isUuid } from "@/lib/uuid";
import { reportPeriod } from "@/server/report-period";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** CSV (or Excel with ?format=xlsx) of the sales report (ADR-105). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/reports/sales/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!canSeeSales(ctx)) return new Response("Not found", { status: 404 });
  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const period = reportPeriod(sp, ctx.timeZone);
  const companyId = sp.company && isUuid(sp.company) ? sp.company : undefined;
  try {
    return exportResponse(
      request,
      await exportSalesCsv(ctx, period, { companyId }),
      `sales-${period.from}-${period.to}.csv`,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
