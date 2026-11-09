import { apiFoodNutrition } from "@/modules/nutrition/engine/api";
import { apiRoute } from "@/server/routes/api-route";

/** GET /api/v1/nutrition/foods/{id}/nutrition (ADR-132; see /api/v1/openapi.json). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/v1/nutrition/foods/[id]/nutrition">,
) {
  const { id } = await params;
  return apiRoute(request, (api, q) => apiFoodNutrition(api, id, q));
}
