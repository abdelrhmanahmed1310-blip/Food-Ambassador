import { apiAddServing, apiListServings } from "@/modules/nutrition/engine/api";
import { apiBodyRoute, apiRoute } from "@/server/routes/api-route";

/** GET /api/v1/nutrition/foods/{id}/servings (ADR-132; see /api/v1/openapi.json). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/v1/nutrition/foods/[id]/servings">,
) {
  const { id } = await params;
  return apiRoute(request, (api) => apiListServings(api, id));
}

/** POST /api/v1/nutrition/foods/{id}/servings (ADR-132; see /api/v1/openapi.json). */
export async function POST(
  request: Request,
  { params }: RouteContext<"/api/v1/nutrition/foods/[id]/servings">,
) {
  const { id } = await params;
  return apiBodyRoute(request, (api, body) => apiAddServing(api, id, body), { status: 201 });
}
