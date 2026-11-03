/**
 * Background job worker (DECISIONS.md ADR-087): adds the recurring jobs that
 * are due, runs due jobs, then exits. Run it from a scheduler every minute,
 * or with --watch to loop. Several workers may run at once.
 *
 *   pnpm jobs:run           # one pass
 *   pnpm jobs:run --watch   # every 15 s until stopped
 *
 * Prints counts only — never payloads or secrets.
 */
import "dotenv/config";
import { runDueJobs, scheduleRecurringJobs } from "@/modules/jobs/service";
import { getDb } from "@/server/db/client";

async function pass() {
  const scheduled = await scheduleRecurringJobs();
  const ran = await runDueJobs({ limit: 100 });
  const count = (s: string) => ran.filter((r) => r.status === s).length;
  console.log(
    `${new Date().toISOString()} scheduled=${scheduled} done=${count("DONE")} retrying=${count("QUEUED")} failed=${count("FAILED")}`,
  );
}

async function main() {
  if (!process.argv.includes("--watch")) return pass();
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    await pass();
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

main()
  .then(() => getDb().$disconnect())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await getDb().$disconnect();
    process.exit(1);
  });
