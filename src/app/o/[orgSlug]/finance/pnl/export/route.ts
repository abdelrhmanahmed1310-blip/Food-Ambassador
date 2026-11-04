import { isUuid } from "@/lib/uuid";
import { canSeePnl, exportPnlCsv } from "@/modules/finance/pnl";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** CSV (or Excel with ?format=xlsx) of the branch P&L shown (ADR-111). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/finance/pnl/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!canSeePnl(ctx)) return new Response("Not found", { status: 404 });
  const sp = Object.fromEntries(new URL(request.url).searchParams);
  try {
    return exportResponse(
      request,
      await exportPnlCsv(
        ctx,
        { from: sp.from, to: sp.to },
        {
          companyId: sp.company && isUuid(sp.company) ? sp.company : undefined,
          branchId: sp.branch && isUuid(sp.branch) ? sp.branch : undefined,
        },
      ),
      "branch-pnl.csv",
    );
  } catch (error) {
    return errorResponse(error);
  }
}
