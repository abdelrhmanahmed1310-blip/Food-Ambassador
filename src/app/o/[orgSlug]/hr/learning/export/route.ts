import { isUuid } from "@/lib/uuid";
import { exportComplianceCsv } from "@/modules/learning/service";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** Training compliance per employee and required course (ADR-125). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/hr/learning/export">,
) {
  const ctx = await tenantForRoute((await params).orgSlug);
  if (ctx instanceof Response) return ctx;
  const branch = new URL(request.url).searchParams.get("branch");
  try {
    return exportResponse(
      request,
      await exportComplianceCsv(ctx, { branchId: branch && isUuid(branch) ? branch : undefined }),
      "training-compliance.csv",
    );
  } catch (error) {
    return errorResponse(error);
  }
}
