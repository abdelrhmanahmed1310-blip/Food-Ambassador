import { apiBarcode } from "@/modules/nutrition/engine/api";
import { apiRoute } from "@/server/routes/api-route";

/** GET /api/v1/nutrition/foods/barcode/{code} (ADR-132; see /api/v1/openapi.json). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/v1/nutrition/foods/barcode/[code]">,
) {
  const { code } = await params;
  return apiRoute(request, (api) => apiBarcode(api, code));
}
