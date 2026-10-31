/**
 * Attachment retention (docs/OPERATIONS.md, ADR-051): deletes the content of
 * files whose 3-year retention has ended, for all organizations, keeping the
 * record (name, size, hash, dates). Run daily from the scheduler.
 *
 *   pnpm attachments:purge
 *
 * Prints counts only.
 */
import "dotenv/config";
import { purgeExpiredAttachments } from "@/modules/attachments/service";
import { getDb } from "@/server/db/client";

async function main() {
  let total = 0;
  for (;;) {
    const { purged } = await purgeExpiredAttachments({ limit: 500 });
    total += purged;
    if (purged < 500) break;
  }
  console.log(`${new Date().toISOString()} purged=${total}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => getDb().$disconnect());
