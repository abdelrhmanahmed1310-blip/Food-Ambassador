import "server-only";
import { authenticateApiRequest, type ApiContext } from "@/modules/api/clients";
import { AppError } from "@/server/errors";

/**
 * REST API v1 route wrapper (ADR-090): the key, JSON errors with the same
 * codes as everywhere else, and no caching. Errors never echo input.
 */
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

export function apiError(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
) {
  return json(status, { error: { code, message } }, headers);
}

export async function apiRoute(
  request: Request,
  handler: (api: ApiContext, query: URLSearchParams) => Promise<unknown>,
): Promise<Response> {
  const auth = await authenticateApiRequest(request.headers.get("authorization"));
  if (!auth.ok)
    return auth.code === "RATE_LIMITED"
      ? apiError(429, "RATE_LIMITED", "Too many requests", {
          "Retry-After": String(auth.retryAfter),
        })
      : apiError(401, "UNAUTHORIZED", "A valid API key is required (Authorization: Bearer fa_…)", {
          "WWW-Authenticate": "Bearer",
        });
  try {
    return json(200, await handler(auth.api, new URL(request.url).searchParams));
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === "FORBIDDEN")
        return apiError(403, "FORBIDDEN", "This key does not have the scope for this resource");
      if (error.code === "NOT_FOUND") return apiError(404, "NOT_FOUND", "Not found");
      return apiError(error.httpStatus, error.code, error.message);
    }
    console.error(error instanceof Error ? error.message : error);
    return apiError(500, "INTERNAL", "Something went wrong");
  }
}
