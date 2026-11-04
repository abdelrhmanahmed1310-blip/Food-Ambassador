import { canSeeConsolidation, exportConsolidatedCsv } from "@/modules/finance/consolidation";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** CSV (or Excel with ?format=xlsx) of the consolidated P&L (ADR-112). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/finance/consolidated/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!canSeeConsolidation(ctx)) return new Response("Not found", { status: 404 });
  const sp = Object.fromEntries(new URL(request.url).searchParams);
  try {
    return exportResponse(
      request,
      await exportConsolidatedCsv(ctx, { from: sp.from, to: sp.to }),
      "consolidated-pnl.csv",
    );
  } catch (error) {
    return errorResponse(error);
  }
}
