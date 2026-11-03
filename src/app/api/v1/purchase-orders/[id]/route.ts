import { getPurchaseOrder } from "@/modules/api/v1";
import { apiRoute } from "@/server/routes/api-route";

/** GET /api/v1/purchase-orders/{id} (ADR-090). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/v1/purchase-orders/[id]">,
) {
  const { id } = await params;
  return apiRoute(request, (api) => getPurchaseOrder(api, id));
}
