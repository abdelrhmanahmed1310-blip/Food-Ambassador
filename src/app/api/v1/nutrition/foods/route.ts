import { apiCreateFoods } from "@/modules/nutrition/engine/api";
import { apiBodyRoute } from "@/server/routes/api-route";

/** POST /api/v1/nutrition/foods (ADR-132; see /api/v1/openapi.json). */
export async function POST(request: Request) {
  return apiBodyRoute(request, (api, body) => apiCreateFoods(api, body));
}
