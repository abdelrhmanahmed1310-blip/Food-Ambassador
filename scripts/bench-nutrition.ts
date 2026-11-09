/**
 * Performance measurement of the nutrition engine (DECISIONS.md ADR-132)
 * on a SYNTHETIC dataset in a SEPARATE database. The records are generated
 * test fixtures, clearly named "Synthetic food …"; they are not nutrition
 * data and must never be loaded into a real organization.
 *
 *   createdb food_ambassador_bench
 *   DATABASE_URL=postgresql://…/food_ambassador_bench npx prisma migrate deploy
 *   DATABASE_URL=postgresql://…/food_ambassador_bench pnpm nutrition:bench [--foods 20000]
 *
 * Refuses to run unless the database name contains "bench".
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import {
  analyzeFoodRecipe,
  calculateFoods,
  getFood,
  searchFoods,
} from "@/modules/nutrition/engine/foods";
import { importRecordStream } from "@/modules/nutrition/engine/sync";
import { getDb } from "@/server/db/client";
import { contextFor, createTenant } from "../test/support/factories";

const url = process.env.DATABASE_URL ?? "";
const dbName = /\/([^/?]+)(\?|$)/.exec(url)?.[1] ?? "";
if (!dbName.includes("bench")) {
  console.error(`Refusing to run: database "${dbName}" is not a benchmark database.`);
  process.exit(1);
}
const argN = process.argv.indexOf("--foods");
const N = argN > 0 ? Number(process.argv[argN + 1]) : 20000;

// Deterministic pseudo-random numbers, so runs are comparable.
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const WORDS = [
  "grain",
  "bean",
  "leaf",
  "root",
  "seed",
  "fruit",
  "cheese",
  "yogurt",
  "fish",
  "meat",
  "oil",
  "nut",
];
const NUTRIENTS: Array<[number, string, string, string, number]> = [
  [1008, "208", "Energy", "kcal", 400],
  [1003, "203", "Protein", "g", 30],
  [1004, "204", "Total lipid (fat)", "g", 30],
  [1005, "205", "Carbohydrate, by difference", "g", 30],
  [1079, "291", "Fiber, total dietary", "g", 10],
  [2000, "269", "Total Sugars", "g", 20],
  [1093, "307", "Sodium, Na", "mg", 800],
  [1087, "301", "Calcium, Ca", "mg", 300],
  [1089, "303", "Iron, Fe", "mg", 10],
  [1162, "401", "Vitamin C, total ascorbic acid", "mg", 50],
];

function syntheticRecord(i: number) {
  const w = WORDS[i % WORDS.length];
  return {
    fdcId: 900000000 + i,
    dataType: "Synthetic (benchmark)",
    description: `Synthetic food ${String(i).padStart(6, "0")} ${w}`,
    foodCategory: { description: `Synthetic ${w}` },
    foodNutrients: NUTRIENTS.map(([id, number, name, unitName, max]) => ({
      nutrient: { id, number, name, unitName },
      amount: Math.round(rnd() * max * 10) / 10,
    })),
    foodPortions: [
      {
        amount: 1,
        gramWeight: 50 + (i % 200),
        modifier: "serving",
        measureUnit: { name: "undetermined" },
      },
    ],
  };
}

async function* records() {
  for (let i = 0; i < N; i++) yield syntheticRecord(i);
}

function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  return {
    n: s.length,
    p50: +p(0.5).toFixed(1),
    p95: +p(0.95).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
  };
}

async function time<T>(runs: number, fn: (i: number) => Promise<T>) {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn(i);
    out.push(performance.now() - t);
  }
  return stats(out);
}

async function main() {
  // --reuse measures again on the dataset a previous run imported (no new import).
  const reuse = process.argv.includes("--reuse");
  let ctx;
  let imported = { created: 0, failed: 0 };
  let importSeconds = 0;
  const existing = reuse
    ? await getDb().referenceFood.findFirst({
        where: { dataType: "Synthetic (benchmark)" },
        select: {
          organization: {
            select: { slug: true, memberships: { select: { userId: true }, take: 1 } },
          },
        },
      })
    : null;
  if (existing) {
    ctx = await contextFor(existing.organization.memberships[0].userId, existing.organization.slug);
  } else {
    ({ ctx } = await createTenant("bench"));
    const t0 = performance.now();
    imported = await importRecordStream(ctx, records(), { name: `synthetic-${N}.jsonl`, size: N });
    importSeconds = (performance.now() - t0) / 1000;
  }
  const ids = (
    await getDb().referenceFood.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true },
      take: 200,
      orderBy: { sourceId: "asc" },
    })
  ).map((f) => f.id);

  // Warm up the connection pool and plans.
  await searchFoods(ctx, { q: "grain", mode: "LOCAL" });
  const queries = [
    "grain",
    "Synthetic food 00012",
    "cheese",
    "900000123",
    "leaf",
    "yogurt seed",
    "fish",
    "nut",
  ];
  const results = {
    foods: N,
    importSeconds: existing ? null : +importSeconds.toFixed(1),
    importRecordsPerSecond: existing ? null : Math.round(N / importSeconds),
    imported: { created: imported.created, failed: imported.failed },
    localSearch: await time(100, (i) =>
      searchFoods(ctx, { q: queries[i % queries.length], mode: "LOCAL", pageSize: 25 }),
    ),
    localSearchSortedByEnergy: await time(30, (i) =>
      searchFoods(ctx, { q: queries[i % queries.length], mode: "LOCAL", sort: "energy" }),
    ),
    foodDetails: await time(100, (i) => getFood(ctx, ids[i % ids.length])),
    calculate10Items: await time(100, (i) =>
      calculateFoods(ctx, {
        items: ids
          .slice(i % 100, (i % 100) + 10)
          .map((foodId) => ({ foodId, quantity: "125", unit: "g" })),
      }),
    ),
    recipe20Ingredients: await time(50, (i) =>
      analyzeFoodRecipe(ctx, {
        ingredients: ids
          .slice(i % 100, (i % 100) + 20)
          .map((foodId) => ({ foodId, quantity: "80", unit: "g" })),
        servings: 4,
        finishedGrams: "1400",
      }),
    ),
  };
  console.log(JSON.stringify(results, null, 2));
  await getDb().$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await getDb().$disconnect();
  process.exit(1);
});
