import { apiGetFood, apiUpdateFood } from "@/modules/nutrition/engine/api";
import { apiBodyRoute, apiRoute } from "@/server/routes/api-route";

/** GET /api/v1/nutrition/foods/{id} (ADR-132; see /api/v1/openapi.json). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/v1/nutrition/foods/[id]">,
) {
  const { id } = await params;
  return apiRoute(request, (api, q) => apiGetFood(api, id, q));
}

/** PATCH /api/v1/nutrition/foods/{id} (ADR-132; see /api/v1/openapi.json). */
export async function PATCH(
  request: Request,
  { params }: RouteContext<"/api/v1/nutrition/foods/[id]">,
) {
  const { id } = await params;
  return apiBodyRoute(request, (api, body) => apiUpdateFood(api, id, body));
}
