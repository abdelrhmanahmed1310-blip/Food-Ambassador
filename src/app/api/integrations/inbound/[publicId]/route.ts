import { handleInboundSales } from "@/modules/integrations/service";
import { logger } from "@/server/logger";

// Signed inbound sales webhook (docs/INTEGRATIONS.md, ADR-048). Thin: reads
// the raw body (the signature covers its exact bytes) and hands over.
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
    const result = await handleInboundSales({
      publicId,
      body,
      headers: {
        timestamp: request.headers.get("x-fa-timestamp"),
        signature: request.headers.get("x-fa-signature"),
        idempotencyKey: request.headers.get("idempotency-key"),
      },
    });
    return Response.json(result.body, { status: result.status, headers: noStore });
  } catch (e) {
    logger.error("inbound webhook failed", { error: e instanceof Error ? e.message : "error" });
    return Response.json({ error: "internal" }, { status: 500, headers: noStore });
  }
}
