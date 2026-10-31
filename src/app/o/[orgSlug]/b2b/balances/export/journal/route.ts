import { hasPermission } from "@/modules/access/authorize";
import { exportReceivablesJournalCsv } from "@/modules/b2b/accounting";
import { csvResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/b2b/balances/export/journal">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!hasPermission(ctx.grants, "b2b.view")) return new Response("Not found", { status: 404 });
  const sp = new URL(request.url).searchParams;
  const period = { from: sp.get("from") ?? "", to: sp.get("to") ?? "" };
  try {
    return csvResponse(
      await exportReceivablesJournalCsv(ctx, period),
      `receivables-journal-${period.from}-${period.to}.csv`,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
