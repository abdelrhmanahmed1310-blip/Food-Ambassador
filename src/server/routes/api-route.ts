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

async function run(
  request: Request,
  handler: (api: ApiContext) => Promise<unknown>,
  status = 200,
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
    return json(status, await handler(auth.api));
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === "FORBIDDEN")
        return apiError(403, "FORBIDDEN", "This key does not have the scope for this resource");
      if (error.code === "NOT_FOUND") return apiError(404, "NOT_FOUND", "Not found");
      if (error.code === "VALIDATION_FAILED")
        return json(error.httpStatus, {
          error: { code: error.code, message: error.message, details: error.details ?? {} },
        });
      if (error.code === "BUSINESS_RULE_VIOLATION" && typeof error.details?.rule === "string")
        return json(error.httpStatus, {
          error: { code: error.code, message: error.message, rule: error.details.rule },
        });
      return apiError(error.httpStatus, error.code, error.message);
    }
    if (error instanceof ApiHttpError) return apiError(error.status, error.code, error.message);
    console.error(error instanceof Error ? error.message : error);
    return apiError(500, "INTERNAL", "Something went wrong");
  }
}

export async function apiRoute(
  request: Request,
  handler: (api: ApiContext, query: URLSearchParams) => Promise<unknown>,
): Promise<Response> {
  return run(request, (api) => handler(api, new URL(request.url).searchParams));
}

/** Bodies above this are refused before parsing. */
export const MAX_API_BODY_BYTES = 1024 * 1024;

/** An error with its own HTTP status and code, for failures that are not AppErrors (body, upstream). */
export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? ""))
    throw new ApiHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_API_BODY_BYTES)
    throw new ApiHttpError(413, "PAYLOAD_TOO_LARGE", "The body is larger than 1 MB");
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_API_BODY_BYTES)
    throw new ApiHttpError(413, "PAYLOAD_TOO_LARGE", "The body is larger than 1 MB");
  try {
    return text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new ApiHttpError(400, "INVALID_JSON", "The body is not valid JSON");
  }
}

/**
 * A route that writes (POST/PATCH; ADR-132): the same key and error rules,
 * plus a JSON body of at most 1 MB. The key is checked before the body is read.
 */
export async function apiBodyRoute(
  request: Request,
  handler: (api: ApiContext, body: unknown, query: URLSearchParams) => Promise<unknown>,
  opts: { status?: number } = {},
): Promise<Response> {
  return run(
    request,
    async (api) => handler(api, await readJson(request), new URL(request.url).searchParams),
    opts.status ?? 200,
  );
}
