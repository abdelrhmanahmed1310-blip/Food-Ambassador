import { exportProductsCsv } from "@/modules/catalog/service";
import { csvResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/o/[orgSlug]/catalog/products/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    return csvResponse(await exportProductsCsv(ctx), "products.csv");
  } catch (error) {
    return errorResponse(error);
  }
}
