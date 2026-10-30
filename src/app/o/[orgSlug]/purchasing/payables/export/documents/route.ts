import { hasPermission } from "@/modules/access/authorize";
import { exportPayablesDocumentsCsv } from "@/modules/invoices/accounting";
import { csvResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/purchasing/payables/export/documents">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  if (!hasPermission(ctx.grants, "invoices.view"))
    return new Response("Not found", { status: 404 });
  const sp = new URL(request.url).searchParams;
  const period = { from: sp.get("from") ?? "", to: sp.get("to") ?? "" };
  try {
    const csv = await exportPayablesDocumentsCsv(ctx, period);
    return csvResponse(csv, `payables-documents-${period.from}-${period.to}.csv`);
  } catch (error) {
    return errorResponse(error);
  }
}
