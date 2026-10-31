import { getAttachmentContent } from "@/modules/attachments/service";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

// Download an attachment (ADR-051). Always as a download, never rendered by
// this origin, with the type detected at upload.
export async function GET(
  _request: Request,
  { params }: RouteContext<"/o/[orgSlug]/attachments/[attachmentId]">,
) {
  const { orgSlug, attachmentId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    const file = await getAttachmentContent(ctx, attachmentId);
    return new Response(new Uint8Array(file.data), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
