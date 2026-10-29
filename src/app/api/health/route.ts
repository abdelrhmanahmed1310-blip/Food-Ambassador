// Liveness: the process is up and serving requests. Does not touch dependencies,
// so orchestrators do not restart healthy instances during a database outage.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
