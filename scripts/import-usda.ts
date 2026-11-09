/**
 * Import a USDA FoodData Central bulk download into one organization's
 * nutrition library (DECISIONS.md ADR-132), streaming: the file is read
 * record by record, never whole, so the multi-gigabyte Branded Foods file
 * fits in normal memory. Chunks of 200 records are written atomically; a
 * rerun with the same file continues after the last finished chunk.
 *
 *   pnpm nutrition:import-usda --org <slug> --user <email> <file.json>
 *
 * Files: the JSON downloads at https://fdc.nal.usda.gov/download-datasets
 * (Foundation, SR Legacy, Survey/FNDDS, Branded, Experimental), unzipped;
 * a bare JSON array or JSON Lines also work.
 */
import "dotenv/config";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { jsonRecords } from "@/modules/nutrition/engine/json-stream";
import { importRecordStream } from "@/modules/nutrition/engine/sync";
import { resolveTenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withSystemTx } from "@/server/db/transactions";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function* text(file: string) {
  for await (const chunk of createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 }))
    yield chunk as string;
}

async function main() {
  const slug = arg("org");
  const email = arg("user")?.toLowerCase();
  const file = process.argv
    .slice(2)
    .filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"))
    .at(-1);
  if (!slug || !email || !file) {
    console.error("Usage: pnpm nutrition:import-usda --org <slug> --user <email> <file.json>");
    process.exit(2);
  }
  const ctx = await withSystemTx(async (tx) => {
    const user = await tx.user.findFirst({ where: { email }, select: { id: true } });
    return user ? resolveTenantContext(tx, user.id, slug) : null;
  });
  if (!ctx) throw new Error("That user is not a member of that organization");
  const started = Date.now();
  const r = await importRecordStream(ctx, jsonRecords(text(file)), {
    name: basename(file),
    size: statSync(file).size,
  });
  console.log(
    `${r.status}: ${r.processed} records (${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged, ${r.failed} failed)` +
      `${r.resumedAfter ? `, resumed after ${r.resumedAfter}` : ""} in ${Math.round((Date.now() - started) / 1000)} s; job ${r.jobId}`,
  );
  await getDb().$disconnect();
  if (r.status === "FAILED") process.exit(1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await getDb().$disconnect();
  process.exit(1);
});
