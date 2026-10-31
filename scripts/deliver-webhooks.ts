/**
 * Outbound webhook worker (docs/INTEGRATIONS.md, ADR-048): sends due
 * deliveries from the outbox for all organizations, then exits. Run it from
 * a scheduler every minute, or with --watch to loop.
 *
 *   pnpm integrations:deliver           # one pass
 *   pnpm integrations:deliver --watch   # every 30 s until stopped
 *
 * Prints counts only — never payloads or secrets.
 */
import "dotenv/config";
import { deliverDueWebhooks } from "@/modules/integrations/service";
import { getDb } from "@/server/db/client";

async function pass() {
  const results = await deliverDueWebhooks({ limit: 100 });
  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(
    `${new Date().toISOString()} sent=${count("DELIVERED")} retrying=${count("PENDING")} failed=${count("FAILED")}`,
  );
}

async function main() {
  if (!process.argv.includes("--watch")) return pass();
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    await pass();
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

main()
  .then(() => getDb().$disconnect())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await getDb().$disconnect();
    process.exit(1);
  });
