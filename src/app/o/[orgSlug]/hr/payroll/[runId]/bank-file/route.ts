import { exportBankFileCsv } from "@/modules/payroll/service";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** Bank transfers of an approved run (ADR-123): IBAN and net per employee. */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/hr/payroll/[runId]/bank-file">,
) {
  const { orgSlug, runId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    return exportResponse(request, await exportBankFileCsv(ctx, runId), "bank-transfers.csv");
  } catch (error) {
    return errorResponse(error);
  }
}
