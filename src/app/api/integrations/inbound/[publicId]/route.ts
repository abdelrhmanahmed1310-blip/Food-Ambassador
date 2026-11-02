import { handleDeliveryInbound } from "@/modules/delivery/service";
import { handleAttendanceInbound } from "@/modules/hr/attendance";
import { handleInboundSales, inboundKind } from "@/modules/integrations/service";
import { logger } from "@/server/logger";

// Signed inbound webhooks (docs/INTEGRATIONS.md, ADR-048): sales, and
// delivery platform orders (docs/DELIVERY.md, ADR-069) and attendance devices (ADR-080). Thin: reads the raw
// body (the signature covers its exact bytes) and hands over by connector kind.
export const dynamic = "force-dynamic";

const MAX_BYTES = 900_000;
const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request, context: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await context.params;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES)
    return Response.json({ error: "bodyTooLarge" }, { status: 413, headers: noStore });
  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_BYTES)
    return Response.json({ error: "bodyTooLarge" }, { status: 413, headers: noStore });
  try {
    const input = {
      publicId,
      body,
      headers: {
        timestamp: request.headers.get("x-fa-timestamp"),
        signature: request.headers.get("x-fa-signature"),
        idempotencyKey: request.headers.get("idempotency-key"),
      },
    };
    const kind = await inboundKind(publicId);
    const result =
      kind === "DELIVERY_ORDERS"
        ? await handleDeliveryInbound(input)
        : kind === "ATTENDANCE_DEVICE"
          ? await handleAttendanceInbound(input)
          : await handleInboundSales(input);
    return Response.json(result.body, { status: result.status, headers: noStore });
  } catch (e) {
    logger.error("inbound webhook failed", { error: e instanceof Error ? e.message : "error" });
    return Response.json({ error: "internal" }, { status: 500, headers: noStore });
  }
}
