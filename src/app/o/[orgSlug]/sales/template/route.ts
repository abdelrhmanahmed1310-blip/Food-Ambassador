import { SALES_TEMPLATE } from "@/modules/sales/imports";
import { csvResponse, tenantForRoute } from "@/server/routes/tenant-route";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/o/[orgSlug]/sales/template">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  return csvResponse(SALES_TEMPLATE, "sales-template.csv");
}
