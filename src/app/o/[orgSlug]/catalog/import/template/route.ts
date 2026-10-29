import { OPENING_TEMPLATE, PRODUCT_TEMPLATE } from "@/modules/inventory/csv";
import { csvResponse, tenantForRoute } from "@/server/routes/tenant-route";

export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/catalog/import/template">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  const kind = new URL(request.url).searchParams.get("kind");
  return kind === "opening"
    ? csvResponse(OPENING_TEMPLATE, "opening-balances-template.csv")
    : csvResponse(PRODUCT_TEMPLATE, "products-template.csv");
}
