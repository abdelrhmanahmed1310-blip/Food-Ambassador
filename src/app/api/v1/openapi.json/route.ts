import { openApiDocument } from "@/modules/api/openapi";

/** The REST API v1 description (OpenAPI 3.1), public (ADR-090). */
export function GET(request: Request) {
  return Response.json(openApiDocument(new URL(request.url).origin), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
