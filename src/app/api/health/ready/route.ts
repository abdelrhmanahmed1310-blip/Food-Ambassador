import { probeDatabase } from "@/server/db/probe";
import { checkReadiness } from "@/server/health";
import { logger } from "@/server/logger";

// Readiness: dependencies are reachable and the instance can take traffic.
export const dynamic = "force-dynamic";

export async function GET() {
  const report = await checkReadiness(
    { database: probeDatabase },
    { onError: (name, error) => logger.error("readiness probe failed", { probe: name, error }) },
  );
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
