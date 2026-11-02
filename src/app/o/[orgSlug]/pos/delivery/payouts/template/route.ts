import { PAYOUT_TEMPLATE } from "@/modules/delivery/payout-rules";
import { csvResponse, tenantForRoute } from "@/server/routes/tenant-route";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/o/[orgSlug]/pos/delivery/payouts/template">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  return csvResponse(PAYOUT_TEMPLATE, "delivery-payout-template.csv");
}
