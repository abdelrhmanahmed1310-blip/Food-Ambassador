import { NextResponse } from "next/server";
import { markNotificationRead } from "@/modules/notifications/service";
import { errorResponse, tenantForRoute } from "@/server/routes/tenant-route";

/** Open a notification: mark it read (only the user's own) and go to what it is about. */
export async function GET(
  request: Request,
  { params }: RouteContext<"/o/[orgSlug]/notifications/[notificationId]">,
) {
  const { orgSlug, notificationId } = await params;
  const ctx = await tenantForRoute(orgSlug);
  if (ctx instanceof Response) return ctx;
  try {
    const { link } = await markNotificationRead(ctx, notificationId);
    // Links are paths below the organization, written by the server (never user input).
    const to = link && link.startsWith("/") && !link.startsWith("//") ? link : "/notifications";
    return NextResponse.redirect(new URL(`/o/${ctx.organizationSlug}${to}`, request.url));
  } catch (error) {
    return errorResponse(error);
  }
}
