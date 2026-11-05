import { isUuid } from "@/lib/uuid";
import { exportForecastCsv } from "@/modules/forecasting/demand";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** CSV (or Excel with ?format=xlsx) of a warehouse's demand forecast (ADR-120). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/purchasing/forecast/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  const warehouseId = new URL(request.url).searchParams.get("warehouseId");
  if (!warehouseId || !isUuid(warehouseId)) return new Response("Not found", { status: 404 });
  try {
    return exportResponse(
      request,
      await exportForecastCsv(ctx, warehouseId),
      "demand-forecast.csv",
    );
  } catch (error) {
    return errorResponse(error);
  }
}
