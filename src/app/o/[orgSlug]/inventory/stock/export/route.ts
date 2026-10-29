import { isUuid } from "@/lib/uuid";
import { exportBalancesCsv } from "@/modules/inventory/csv";
import { STOCK_STATUSES, type StockStatus } from "@/modules/inventory/rules";
import { csvResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/inventory/stock/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  const sp = new URL(request.url).searchParams;
  const id = (k: string) => (isUuid(sp.get(k)) ? (sp.get(k) as string) : undefined);
  const status = sp.get("status");
  const expiry = sp.get("expiry");
  try {
    const csv = await exportBalancesCsv(ctx, {
      q: sp.get("q") ?? undefined,
      warehouseId: id("warehouseId"),
      productId: id("productId"),
      status:
        status && (STOCK_STATUSES as readonly string[]).includes(status)
          ? (status as StockStatus)
          : undefined,
      expiry: expiry === "expired" || expiry === "expiring" ? expiry : undefined,
    });
    return csvResponse(csv, `stock-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (error) {
    return errorResponse(error);
  }
}
