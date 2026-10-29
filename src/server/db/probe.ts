import "server-only";
import { getDb } from "./client";

/** Readiness probe: a trivial round-trip proving the pool can reach PostgreSQL. */
export async function probeDatabase(): Promise<void> {
  await getDb().$queryRaw`SELECT 1`;
}
