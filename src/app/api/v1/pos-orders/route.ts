import { listPosOrders } from "@/modules/api/v1";
import { apiRoute } from "@/server/routes/api-route";

/** GET /api/v1/pos-orders (ADR-090; see /api/v1/openapi.json). */
export async function GET(request: Request) {
  return apiRoute(request, listPosOrders);
}
