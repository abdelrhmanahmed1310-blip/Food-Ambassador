import { submitOrder } from "@/modules/pos/service";
import { errorToState } from "@/server/actions/handle";
import { AppError } from "@/server/errors";
import { tenantForRoute } from "@/server/routes/tenant-route";

/**
 * Orders from the cashier app (ADR-060), sent at once or later from the
 * device's queue. JSON over the session cookie: only same-origin requests
 * with a JSON body are accepted (a cross-site form cannot send either), and
 * the order id from the device makes every retry safe.
 */
export async function POST(request: Request, { params }: RouteContext<"/o/[orgSlug]/pos/sync">) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host)
    return Response.json({ ok: false, error: "Cross-origin request refused" }, { status: 403 });
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return Response.json({ ok: false, error: "JSON expected" }, { status: 415 });
  const { orgSlug } = await params;
  const ctx = await tenantForRoute(orgSlug);
  // Signed out, or signed in as someone who is not a member here: the device
  // keeps the order and waits for the right person (never a refusal).
  if (ctx instanceof Response)
    return Response.json(
      { ok: false, error: "Signed out" },
      { status: ctx.status === 401 ? 401 : 403 },
    );
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const o = await submitOrder(ctx, payload);
    return Response.json(
      {
        ok: true,
        id: o.id,
        number: o.number,
        gross: o.gross.toFixed(),
        change: o.change.toFixed(),
        shortfalls: o.shortfalls,
        duplicate: o.duplicate,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const state = await errorToState(error, {});
    const message = Object.values(state.fieldErrors ?? {})[0] ?? state.formError ?? "";
    const status =
      error instanceof AppError ? (error.code === "FORBIDDEN" ? 403 : error.httpStatus) : 500;
    const rule =
      error instanceof AppError && typeof error.details?.rule === "string"
        ? error.details.rule
        : null;
    return Response.json({ ok: false, error: message, rule }, { status });
  }
}
