import { apiRefreshFood } from "@/modules/nutrition/engine/api";
import { apiRoute } from "@/server/routes/api-route";

/** POST /api/v1/nutrition/foods/{id}/refresh (ADR-132; see /api/v1/openapi.json). */
export async function POST(
  request: Request,
  { params }: RouteContext<"/api/v1/nutrition/foods/[id]/refresh">,
) {
  const { id } = await params;
  return apiRoute(request, (api) => apiRefreshFood(api, id));
}
