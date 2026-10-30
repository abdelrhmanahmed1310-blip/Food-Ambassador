/**
 * Import a large public food database file into one organization's
 * ingredient library (DECISIONS.md ADR-041), in parts of up to 2,000
 * records. Each part is atomic and idempotent, so a rerun after a failure
 * skips the parts already imported.
 *
 *   pnpm library:import --org <slug> --user <email> --source USDA_FDC <file.json>
 *
 * Sources: USDA_FDC (FoodData Central JSON download or API response),
 * OPEN_FOOD_FACTS (product JSON or the JSONL dump), WIKIDATA (entity JSON).
 * The file is read into memory; give Node more heap for big dumps
 * (NODE_OPTIONS=--max-old-space-size=8192).
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { importParsed, MAX_RECORDS_PER_IMPORT } from "@/modules/nutrition/library";
import {
  LIBRARY_SOURCES,
  parseLibraryFile,
  type LibrarySource,
} from "@/modules/nutrition/library-parsers";
import { resolveTenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withSystemTx } from "@/server/db/transactions";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("org");
  const email = arg("user")?.toLowerCase();
  const source = arg("source") as LibrarySource | undefined;
  const file = process.argv
    .slice(2)
    .filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"))
    .at(-1);
  if (
    !slug ||
    !email ||
    !source ||
    !file ||
    !(LIBRARY_SOURCES as readonly string[]).includes(source)
  ) {
    console.error(
      `Usage: pnpm library:import --org <slug> --user <email> --source ${LIBRARY_SOURCES.join("|")} <file>`,
    );
    process.exit(2);
  }
  const ctx = await withSystemTx(async (tx) => {
    const user = await tx.user.findFirst({ where: { email }, select: { id: true } });
    return user ? resolveTenantContext(tx, user.id, slug) : null;
  });
  if (!ctx) throw new Error("That user is not a member of that organization");
  const content = readFileSync(file, "utf8");
  const fileHash = createHash("sha256").update(`${source}:${content}`).digest("hex");
  const parsed = parseLibraryFile(source, content);
  console.log(`Read ${parsed.foods.length} records, ${parsed.problems.length} problems.`);
  const parts = Math.max(1, Math.ceil(parsed.foods.length / MAX_RECORDS_PER_IMPORT));
  let created = 0;
  let updated = 0;
  for (let p = 0; p < parts; p++) {
    const foods = parsed.foods.slice(p * MAX_RECORDS_PER_IMPORT, (p + 1) * MAX_RECORDS_PER_IMPORT);
    const r = await importParsed(ctx, {
      source,
      fileName: parts > 1 ? `${basename(file)} (part ${p + 1}/${parts})` : basename(file),
      sha256: createHash("sha256").update(`${fileHash}:${p}`).digest("hex"),
      parsed: { foods, problems: p === 0 ? parsed.problems : [] },
    });
    created += r.created;
    updated += r.updated;
    console.log(
      `Part ${p + 1}/${parts}: ${r.alreadyImported ? "already imported" : `${r.created} new, ${r.updated} updated`}`,
    );
  }
  console.log(`Done: ${created} new, ${updated} updated.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getDb().$disconnect());
