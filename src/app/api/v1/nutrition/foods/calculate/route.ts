import { apiCalculate } from "@/modules/nutrition/engine/api";
import { apiBodyRoute } from "@/server/routes/api-route";

/** POST /api/v1/nutrition/foods/calculate (ADR-132; see /api/v1/openapi.json). */
export async function POST(request: Request) {
  return apiBodyRoute(request, (api, body) => apiCalculate(api, body));
}
