import {
  canSeeMenuEngineering,
  exportMenuEngineeringCsv,
} from "@/modules/analytics/menu-engineering";
import { isUuid } from "@/lib/uuid";
import { reportPeriod } from "@/server/report-period";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** CSV (or Excel with ?format=xlsx) of menu engineering (ADR-107). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/reports/menu-engineering/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!canSeeMenuEngineering(ctx)) return new Response("Not found", { status: 404 });
  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const period = reportPeriod(sp, ctx.timeZone);
  const companyId = sp.company && isUuid(sp.company) ? sp.company : undefined;
  const categoryId = sp.category && isUuid(sp.category) ? sp.category : undefined;
  try {
    return exportResponse(
      request,
      await exportMenuEngineeringCsv(ctx, period, { companyId, categoryId }),
      `menu-engineering-${period.from}-${period.to}.csv`,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
