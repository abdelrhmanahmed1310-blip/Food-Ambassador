import { canSeeStockHealth, exportStockHealthCsv } from "@/modules/analytics/stock";
import { isUuid } from "@/lib/uuid";
import { reportPeriod } from "@/server/report-period";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** CSV (or Excel with ?format=xlsx) of stock ageing and turnover (ADR-106). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/reports/stock/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!canSeeStockHealth(ctx)) return new Response("Not found", { status: 404 });
  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const period = reportPeriod(sp, ctx.timeZone);
  const companyId = sp.company && isUuid(sp.company) ? sp.company : undefined;
  try {
    return exportResponse(
      request,
      await exportStockHealthCsv(ctx, period, { companyId }),
      `stock-${period.from}-${period.to}.csv`,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
