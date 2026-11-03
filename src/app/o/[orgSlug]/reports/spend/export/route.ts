import { exportSpendCsv, canSeeSpend } from "@/modules/procurement/spend";
import { isUuid } from "@/lib/uuid";
import { reportPeriod } from "@/server/report-period";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** CSV (or Excel with ?format=xlsx) of the spend report (ADR-095). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/reports/spend/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!canSeeSpend(ctx)) return new Response("Not found", { status: 404 });
  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const period = reportPeriod(sp, ctx.timeZone);
  const company = sp.company && isUuid(sp.company) ? sp.company : undefined;
  try {
    return exportResponse(
      request,
      await exportSpendCsv(ctx, period, company),
      `spend-${period.from}-${period.to}.csv`,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
