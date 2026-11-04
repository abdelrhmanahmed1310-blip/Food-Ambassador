import { exportSegmentCsv } from "@/modules/crm/segments";
import { exportResponse, errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** A segment's members as CSV (or Excel); audited (ADR-118). */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/pos/customers/segments/[segmentId]/export">,
) {
  const { orgSlug, segmentId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    return exportResponse(request, await exportSegmentCsv(ctx, segmentId), "segment.csv");
  } catch (error) {
    return errorResponse(error);
  }
}
