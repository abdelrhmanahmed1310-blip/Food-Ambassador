/**
 * ZATCA reporting worker (DECISIONS.md ADR-064): reports due simplified
 * invoices and credit notes of all organizations (ZATCA expects them within
 * 24 hours), then exits. Run it from a scheduler every few minutes, or
 * with --watch to loop.
 *
 *   pnpm zatca:report           # one pass
 *   pnpm zatca:report --watch   # every 60 s until stopped
 *
 * Prints counts only — never documents or secrets.
 */
import "dotenv/config";
import { reportDueDocuments } from "@/modules/zatca/service";
import { getDb } from "@/server/db/client";

async function pass() {
  const results = await reportDueDocuments({ limit: 200 });
  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(
    `${new Date().toISOString()} reported=${count("REPORTED")} warnings=${count("REPORTED_WITH_WARNINGS")} rejected=${count("REJECTED")} retrying=${count("PENDING")}`,
  );
}

async function main() {
  if (!process.argv.includes("--watch")) return pass();
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    await pass();
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

main()
  .then(() => getDb().$disconnect())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await getDb().$disconnect();
    process.exit(1);
  });
