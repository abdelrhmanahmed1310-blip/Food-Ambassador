import { apiSearchFoods } from "@/modules/nutrition/engine/api";
import { apiRoute } from "@/server/routes/api-route";

/** GET /api/v1/nutrition/foods/search (ADR-132; see /api/v1/openapi.json). */
export async function GET(request: Request) {
  return apiRoute(request, apiSearchFoods);
}
