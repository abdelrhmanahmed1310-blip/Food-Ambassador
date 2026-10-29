import { isUuid } from "@/lib/uuid";
import { exportValuationsCsv } from "@/modules/inventory/csv";
import { canViewValuation } from "@/modules/inventory/valuation-queries";
import { csvResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/inventory/valuation/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!canViewValuation(ctx)) return new Response("Not found", { status: 404 });
  const sp = new URL(request.url).searchParams;
  const warehouseId = sp.get("warehouseId");
  try {
    const csv = await exportValuationsCsv(ctx, {
      q: sp.get("q") ?? undefined,
      warehouseId: isUuid(warehouseId) ? (warehouseId as string) : undefined,
      costMissing: sp.get("costMissing") === "1",
    });
    return csvResponse(csv, `stock-value-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (error) {
    return errorResponse(error);
  }
}
