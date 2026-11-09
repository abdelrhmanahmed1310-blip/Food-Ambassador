import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { resetEnvCache } from "@/server/env";
import { addMember, createTenant, expectAppError } from "../../../../test/support/factories";
import {
  addPortion,
  analyzeFoodRecipe,
  calculateFoods,
  clearUsdaSearchCache,
  compareFoods,
  createFood,
  findByBarcode,
  foodNutrition,
  getFood,
  importUsdaFoods,
  listNutrients,
  listSources,
  refreshFood,
  searchFoods,
  updateFood,
} from "./foods";
import {
  ProviderError,
  setTestProvider,
  setTestUsdaTransport,
  UsdaFdcProvider,
  type FoodProvider,
} from "./providers";
import {
  importRecordStream,
  listSyncJobs,
  requestSync,
  retrySyncJob,
  runSyncJob,
  syncStatus,
  updateNutritionSettings,
} from "./sync";

/**
 * The nutrition engine against the database (ADR-132). USDA is a stand-in:
 * payloads follow FoodData Central's documented shapes with test values.
 */

const grain = (energy = 130) => ({
  fdcId: 300001,
  dataType: "Foundation",
  description: "Test grain, cooked",
  publicationDate: "2024-04-01",
  foodCategory: { description: "Cereal Grains and Pasta" },
  foodNutrients: [
    { nutrient: { id: 1008, number: "208", name: "Energy", unitName: "kcal" }, amount: energy },
    { nutrient: { id: 1003, number: "203", name: "Protein", unitName: "g" }, amount: 2.7 },
    {
      nutrient: { id: 1004, number: "204", name: "Total lipid (fat)", unitName: "g" },
      amount: 0.3,
    },
    {
      nutrient: { id: 1005, number: "205", name: "Carbohydrate, by difference", unitName: "g" },
      amount: 28,
    },
    { nutrient: { id: 1093, number: "307", name: "Sodium, Na", unitName: "mg" }, amount: 400 },
    {
      nutrient: { id: 1162, number: "401", name: "Vitamin C", unitName: "mg" },
      amount: 0,
      foodNutrientDerivation: { code: "Z", description: "Below limit of quantification" },
    },
    { nutrient: { id: 1999001, number: "999", name: "Test component", unitName: "mg" }, amount: 1 },
  ],
  foodPortions: [
    {
      sequenceNumber: 1,
      amount: 1,
      gramWeight: 158,
      modifier: "cup",
      measureUnit: { name: "undetermined" },
    },
  ],
});
const juice = {
  fdcId: 300002,
  dataType: "Branded",
  description: "TEST APPLE JUICE",
  brandOwner: "Test Co",
  gtinUpc: "012345678905",
  ingredients: "Water, apple juice concentrate.",
  brandedFoodCategory: "Fruit & Vegetable Juice",
  servingSize: 240,
  servingSizeUnit: "ml",
  householdServingFullText: "1 cup",
  publicationDate: "2024-05-01",
  foodNutrients: [
    { nutrient: { id: 1008, number: "208", name: "Energy", unitName: "KCAL" }, amount: 46 },
    { nutrient: { id: 2000, number: "269", name: "Total Sugars", unitName: "G" }, amount: 10 },
  ],
};

let catalog: Record<string, unknown> = {};
let failing: ProviderError | null = null;
const calls: string[] = [];
const fake: FoodProvider = {
  id: "USDA_FDC",
  configured: () => true,
  async search(q) {
    calls.push(`search:${q.query}`);
    if (failing) throw failing;
    const foods = Object.values(catalog).filter((f) =>
      JSON.stringify(f).toLowerCase().includes(q.query.toLowerCase()),
    );
    return { total: foods.length, foods };
  },
  async food(id) {
    if (failing) throw failing;
    if (!catalog[id]) throw new ProviderError("NOT_FOUND", "Not found in USDA FoodData Central");
    return catalog[id];
  },
  async foods(ids) {
    calls.push(`foods:${ids.join(",")}`);
    if (failing) throw failing;
    return ids.map((i) => catalog[i]).filter(Boolean);
  },
  async latestPublished(dt) {
    if (failing) throw failing;
    return dt === "Foundation" ? "2025-04-24" : null;
  },
  async ping() {
    return { ok: !failing, ms: 1 };
  },
};

let ctx: TenantContext;
let analyst: TenantContext;
let grainId: string;
let juiceId: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("nutrition-engine", {
    baseCurrency: "SAR",
    timeZone: "Asia/Riyadh",
  }));
  analyst = (await addMember(ctx, "analyst", {}, "engine-analyst")).ctx;
  setTestProvider(fake);
});

beforeEach(() => {
  catalog = { "300001": grain(), "300002": juice };
  failing = null;
  calls.length = 0;
  clearUsdaSearchCache();
});

afterAll(async () => {
  // Jobs this file queued are not for the job-runner tests that share the database.
  await getDb().job.deleteMany({ where: { organizationId: ctx.organizationId } });
  setTestProvider(null);
  setTestUsdaTransport(null);
  delete process.env.USDA_FDC_API_KEY;
  delete process.env.USDA_FDC_REQUESTS_PER_HOUR;
  resetEnvCache();
  await getDb().$disconnect();
});

describe("USDA provider transport (ADR-132)", () => {
  const usda = new UsdaFdcProvider();
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  const sleeps: number[] = [];
  const use = (responses: Array<Response | Error>) => {
    const seen: Array<{ url: string; key: string | null }> = [];
    setTestUsdaTransport(
      (async (url: string | URL, init?: RequestInit) => {
        seen.push({ url: String(url), key: new Headers(init?.headers).get("x-api-key") });
        const r = responses.shift()!;
        if (r instanceof Error) throw r;
        return r;
      }) as typeof fetch,
      async (ms) => void sleeps.push(ms),
    );
    return seen;
  };
  beforeEach(async () => {
    sleeps.length = 0;
    process.env.USDA_FDC_API_KEY = "test-usda-key";
    delete process.env.USDA_FDC_REQUESTS_PER_HOUR;
    resetEnvCache();
    await getDb().$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "key" = 'usda-fdc'`;
  });

  it("is off without a key", async () => {
    delete process.env.USDA_FDC_API_KEY;
    resetEnvCache();
    expect(usda.configured()).toBe(false);
    await expect(usda.food("1")).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("sends the key in a header, never in the URL, and reads the answer", async () => {
    const seen = use([json(200, { totalHits: 1, foods: [juice] })]);
    expect(await usda.search({ query: "juice", pageNumber: 1, pageSize: 5 })).toEqual({
      total: 1,
      foods: [juice],
    });
    expect(seen[0]).toEqual({
      url: "https://api.nal.usda.gov/fdc/v1/foods/search",
      key: "test-usda-key",
    });
  });

  it("waits as told after a 429 and retries", async () => {
    use([json(429, {}, { "Retry-After": "2" }), json(200, grain())]);
    expect(await usda.food("300001")).toMatchObject({ fdcId: 300001 });
    expect(sleeps).toEqual([2000]);
  });

  it("backs off on server errors and timeouts, then gives up as unavailable", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    use([json(503, {}), timeout, json(500, {})]);
    await expect(usda.food("300001")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThanOrEqual(sleeps[0]);
  });

  it("does not retry what cannot succeed", async () => {
    use([json(404, {})]);
    await expect(usda.food("1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    use([json(403, {})]);
    await expect(usda.food("1")).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(sleeps).toEqual([]);
  });

  it("keeps within the hourly budget across instances", async () => {
    process.env.USDA_FDC_REQUESTS_PER_HOUR = "2";
    resetEnvCache();
    use([json(200, []), json(200, [])]);
    await usda.foods(["1"]);
    await usda.foods(["2"]);
    await expect(usda.foods(["3"])).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("hybrid search, import and food profiles (ADR-132)", () => {
  it("finds USDA foods before import, then imports them with their source history", async () => {
    const before = await searchFoods(ctx, { q: "test" });
    expect([before.mode, before.local.total, before.external.status]).toEqual(["HYBRID", 0, "OK"]);
    expect(before.external.items.map((i) => i.fdcId).sort()).toEqual(["300001", "300002"]);
    expect((await searchFoods(ctx, { q: "test", mode: "LOCAL" })).external.status).toBe("SKIPPED");

    await expectAppError(importUsdaFoods(analyst, ["300001"]), "FORBIDDEN");
    const r = await importUsdaFoods(ctx, ["300001", "300002", "399999"]);
    expect([r.created, r.updated, r.unchanged]).toEqual([2, 0, 0]);
    expect(r.failed).toEqual([{ ref: "399999", message: "Not found in USDA FoodData Central" }]);
    grainId = r.foods[0].foodId;
    juiceId = r.foods[1].foodId;
    // The new source nutrient joined the dictionary, unmapped.
    expect((await listNutrients(ctx, { q: "Test component" }))[0]).toMatchObject({
      usdaNutrientId: 1999001,
      mapped: false,
    });
  });

  it("keeps each value as published, with calculated and missing values told apart", async () => {
    const f = await getFood(ctx, grainId);
    expect([
      f.food.source,
      f.food.dataType,
      f.food.category?.name,
      f.food.verified,
      f.food.stale,
    ]).toEqual(["USDA_FDC", "Foundation", "Cereal Grains and Pasta", false, false]);
    const by = (code: string) => f.nutrients.find((n) => n.code === code);
    expect(by("sodium")).toMatchObject({
      amount: "400",
      unit: "mg",
      originalAmount: "400",
      originalUnit: "mg",
      sourceNutrientId: 1093,
      status: "REPORTED",
    });
    expect(by("salt")).toMatchObject({ amount: "1", status: "CALCULATED", versionId: null });
    expect(by("energy_kj")).toMatchObject({ amount: "543.92", status: "CALCULATED" });
    expect(by("vitamin_c")).toMatchObject({
      amount: null,
      originalAmount: "0",
      status: "BELOW_DETECTION",
    });
    // Fibre is not published: listed as missing, not zero.
    expect(f.missingCore.map((m) => m.code)).toContain("fibre");
    expect(f.portions.map((p) => [p.description, p.gramWeight])).toEqual([["1 cup", "158"]]);
    expect(f.identifiers.map((i) => i.kind)).toEqual(["FDC_ID"]);
    expect(f.versions).toHaveLength(1);
    expect(by("sodium")?.versionId).toBe(f.versions[0].id);
    // Branded: per 100 ml, barcode, ingredients verbatim, and a finding for the missing core nutrients.
    const j = await getFood(ctx, juiceId);
    expect([j.food.basis, j.food.barcode, j.food.ingredientsText]).toEqual([
      "PER_100ML",
      "012345678905",
      "Water, apple juice concentrate.",
    ]);
    expect(j.issues.map((i) => i.kind)).toEqual(["MISSING_CORE_NUTRIENTS"]);
  });

  it("never shows an imported food twice in a hybrid search", async () => {
    const r = await searchFoods(ctx, { q: "test" });
    expect(r.local.items.map((i) => i.id).sort()).toEqual([grainId, juiceId].sort());
    expect(r.external.items).toEqual([]);
    // By FDC id and by barcode too.
    expect((await searchFoods(ctx, { q: "300001", mode: "LOCAL" })).local.items[0].id).toBe(
      grainId,
    );
    expect((await findByBarcode(ctx, "12345678905")).local.map((x) => x.id)).toEqual([juiceId]);
  });

  it("refreshes: unchanged content changes nothing; new content is a new version", async () => {
    expect((await importUsdaFoods(ctx, ["300001"])).unchanged).toBe(1);
    await updateFood(ctx, grainId, { verified: true, notApplicable: { alcohol: true } });
    await expectAppError(
      updateFood(ctx, grainId, { notApplicable: { protein: true } }),
      "BUSINESS_RULE_VIOLATION",
    );
    catalog["300001"] = grain(135);
    expect((await refreshFood(ctx, grainId)).result).toBe("updated");
    const f = await getFood(ctx, grainId);
    expect(f.versions).toHaveLength(2);
    expect(f.nutrients.find((n) => n.code === "energy_kcal")?.amount).toBe("135");
    // A person's "not applicable" survives; verification lapses with a finding.
    expect(f.nutrients.find((n) => n.code === "alcohol")?.status).toBe("NOT_APPLICABLE");
    expect([f.food.verified, f.issues.map((i) => i.kind)]).toEqual([
      false,
      ["CHANGED_AFTER_VERIFICATION"],
    ]);
    // History is kept as published.
    await expect(
      getDb().foodSourceVersion.updateMany({ where: { foodId: grainId }, data: { via: "FILE" } }),
    ).rejects.toThrow();
  });

  it("calculates servings, comparisons and recipes", async () => {
    // 30 g of grain at 135 kcal/100 g = 40.5 kcal.
    const n = await foodNutrition(ctx, grainId, { quantity: "30", unit: "g" });
    expect(n.values.find((v) => v.code === "energy_kcal")?.amount).toBe("40.5");
    // A cup is 158 g.
    expect(
      (
        await foodNutrition(ctx, grainId, {
          quantity: "1",
          unit: "portion",
          portionId: (await getFood(ctx, grainId)).portions[0].id,
        })
      ).grams,
    ).toBe("158");
    // Juice is per 100 ml; grams need a density it does not have.
    await expectAppError(
      foodNutrition(ctx, juiceId, { quantity: "100", unit: "g" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await addPortion(ctx, juiceId, {
      description: "1 glass",
      gramWeight: "260",
      millilitres: "250",
    });
    expect((await foodNutrition(ctx, juiceId, { quantity: "104", unit: "g" })).basisQuantity).toBe(
      "100",
    );
    const c = await compareFoods(ctx, { foodIds: [grainId, juiceId] });
    expect(c.rows.find((r) => r.code === "energy_kcal")?.values.map((v) => v.amount)).toEqual([
      "135",
      "46",
    ]);
    const recipe = await analyzeFoodRecipe(ctx, {
      ingredients: [
        { foodId: grainId, quantity: "200", unit: "g" },
        { foodId: juiceId, quantity: "250", unit: "ml" },
      ],
      servings: 2,
    });
    // Energy: 270 + 115 = 385 kcal; per serving 192.5. Protein: juice has none recorded → unknown.
    const kcal = recipe.total.find((t) => t.code === "energy_kcal")!;
    expect([kcal.amount, recipe.perServing?.find((t) => t.code === "energy_kcal")?.amount]).toEqual(
      ["385", "192.5"],
    );
    expect(recipe.total.find((t) => t.code === "protein")).toMatchObject({
      amount: null,
      knownAmount: "5.4",
      missingIn: ["TEST APPLE JUICE"],
    });
    expect([recipe.totalGrams, recipe.yieldFromRawWeight]).toEqual(["460", true]);
    expect(recipe.ingredients[0].source).toMatchObject({
      source: "USDA_FDC",
      sourceId: "300001",
      dataType: "Foundation",
    });
    const both = await calculateFoods(ctx, {
      items: [{ foodId: grainId, quantity: 100, unit: "g" }],
    });
    expect(both.total.find((t) => t.code === "salt")?.amount).toBe("1");
  });

  it("takes the organization's own foods, searchable in Arabic", async () => {
    await expectAppError(
      createFood(ctx, { name: "Labneh", values: { protein: "150" } }),
      "BUSINESS_RULE_VIOLATION",
    );
    const own = await createFood(ctx, {
      name: "House labneh",
      nameAr: "لبنة البيت",
      barcode: "6281234567890",
      reference: "Packaging label 2026-11",
      values: { energy_kcal: "160", protein: "6", alcohol: "NA" },
    });
    await updateFood(ctx, own.id, { addAliases: [{ name: "لبنة", locale: "ar" }] });
    expect(
      (await searchFoods(ctx, { q: "لبنة", mode: "LOCAL" })).local.items.map((i) => i.id),
    ).toEqual([own.id]);
    const f = await getFood(ctx, own.id, { lang: "ar" });
    expect([f.food.displayName, f.food.source, f.food.sodium]).toEqual([
      "لبنة البيت",
      "MANUAL",
      null,
    ]);
    expect(f.nutrients.find((n) => n.code === "alcohol")?.status).toBe("NOT_APPLICABLE");
    expect(f.nutrients.find((n) => n.code === "protein")?.displayName).toBe("البروتين");
    // kJ is calculated from the kcal entered (and marked so); salt is not, as no sodium was given.
    expect(f.nutrients.find((n) => n.code === "energy_kj")).toMatchObject({
      status: "CALCULATED",
      amount: "669.44",
    });
    expect(f.nutrients.find((n) => n.code === "salt")).toBeUndefined();
    expect(f.missingCore.map((m) => m.code)).toContain("salt");
    const salted = await createFood(ctx, {
      name: "Test brine",
      values: { sodium: "400", salt: "NA", energy_kj: "10" },
    });
    const b = await getFood(ctx, salted.id);
    // What the person entered wins over a calculation, including "not applicable".
    expect(b.nutrients.find((n) => n.code === "salt")?.status).toBe("NOT_APPLICABLE");
    expect(b.nutrients.find((n) => n.code === "energy_kj")?.status).toBe("REPORTED");
    const sodiumOnly = await getFood(
      ctx,
      (await createFood(ctx, { name: "Test stock", values: { sodium: "400" } })).id,
    );
    expect(sodiumOnly.nutrients.find((n) => n.code === "salt")).toMatchObject({
      status: "CALCULATED",
      amount: "1",
    });
    await updateFood(ctx, salted.id, { archived: true, archiveReason: "Test" });
    await updateFood(ctx, sodiumOnly.food.id, { archived: true, archiveReason: "Test" });
    const sources = await listSources(ctx);
    expect(sources.library.find((s) => s.source === "MANUAL")?.records).toBe(1);
    await updateFood(ctx, own.id, { archived: true, archiveReason: "Duplicate" });
    expect((await searchFoods(ctx, { q: "labneh", mode: "LOCAL" })).local.total).toBe(0);
  });

  it("keeps the library working when USDA is down", async () => {
    failing = new ProviderError("UNAVAILABLE", "USDA could not be reached");
    const r = await searchFoods(ctx, { q: "grain" });
    expect([r.local.items.map((i) => i.id), r.external.status]).toEqual([[grainId], "UNAVAILABLE"]);
    expect((await foodNutrition(ctx, grainId)).values.length).toBeGreaterThan(0);
    await expect(refreshFood(ctx, grainId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("keeps organizations apart", async () => {
    const { ctx: other } = await createTenant("nutrition-engine-other");
    await expectAppError(getFood(other, grainId), "NOT_FOUND");
    expect((await searchFoods(other, { q: "grain", mode: "LOCAL" })).local.total).toBe(0);
    const cashier = (await addMember(ctx, "cashier", {}, "engine-cashier")).ctx;
    await expectAppError(searchFoods(cashier, { q: "grain" }), "FORBIDDEN");
  });
});

describe("synchronization (ADR-132)", () => {
  // These tests run sync jobs themselves; the queued runner job is removed at once so a
  // job-runner test in a parallel file never picks it up.
  const unqueue = () =>
    getDb().job.deleteMany({
      where: { organizationId: ctx.organizationId, kind: "nutrition.sync" },
    });
  it("runs a queued import job and logs it", async () => {
    await expectAppError(requestSync(analyst, { kind: "IMPORT", fdcIds: ["300002"] }), "FORBIDDEN");
    const job = await requestSync(ctx, { kind: "IMPORT", fdcIds: ["300002", "300001"] });
    expect(
      await getDb().job.count({
        where: { kind: "nutrition.sync", dedupeKey: `nutrition.sync:${job.id}:0` },
      }),
    ).toBe(1);
    await unqueue();
    await runSyncJob({ syncJobId: job.id });
    const done = (await listSyncJobs(ctx)).items.find((j) => j.id === job.id)!;
    expect([done.status, done.processed, done.unchanged, done.updated, done.failed]).toEqual([
      "SUCCEEDED",
      2,
      1,
      1,
      0,
    ]);
    expect((await syncStatus(ctx)).lastSuccessAt).not.toBeNull();
  });

  it("stops on an outage, then continues from its checkpoint on retry", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => String(400000 + i));
    for (const id of ids)
      catalog[id] = { ...grain(), fdcId: Number(id), description: `Bulk grain ${id}` };
    const job = await requestSync(ctx, { kind: "IMPORT", fdcIds: ids });
    await unqueue();
    // The first batch (20) works, then USDA goes down.
    let batches = 0;
    const real = fake.foods;
    fake.foods = async (b) => {
      if (++batches > 1) throw new ProviderError("UNAVAILABLE", "USDA could not be reached");
      return real(b);
    };
    await runSyncJob({ syncJobId: job.id });
    let j = (await listSyncJobs(ctx)).items.find((x) => x.id === job.id)!;
    expect([j.status, j.created, j.failed, j.checkpoint]).toEqual(["PARTIAL", 20, 5, { next: 25 }]);
    fake.foods = real;
    // Retry continues where it stopped (nothing before the checkpoint is fetched again).
    await getDb().nutritionSyncJob.update({
      where: { id: job.id },
      data: { checkpoint: { next: 20 } },
    });
    await retrySyncJob(ctx, job.id);
    await unqueue();
    calls.length = 0;
    await runSyncJob({ syncJobId: job.id });
    j = (await listSyncJobs(ctx)).items.find((x) => x.id === job.id)!;
    expect(calls).toEqual([`foods:${ids.slice(20).join(",")}`]);
    expect(j.created).toBe(25);
  });

  it("refreshes stale records and checks for new releases", async () => {
    await updateNutritionSettings(ctx, { autoRefresh: "on", refreshDays: "30" });
    await getDb().referenceFood.updateMany({
      where: { organizationId: ctx.organizationId, source: "USDA_FDC" },
      data: { lastFetchedAt: new Date(Date.now() - 40 * 86_400_000) },
    });
    const refresh = await requestSync(ctx, { kind: "REFRESH", limit: "2" });
    await unqueue();
    await runSyncJob({ syncJobId: refresh.id });
    const r = (await listSyncJobs(ctx)).items.find((x) => x.id === refresh.id)!;
    expect([r.status, r.processed]).toEqual(["SUCCEEDED", 2]);
    const check = await requestSync(ctx, { kind: "RELEASE_CHECK" });
    await unqueue();
    await runSyncJob({ syncJobId: check.id });
    expect((await syncStatus(ctx)).settings.releases).toEqual({ Foundation: "2025-04-24" });
  });

  it("imports a bulk file stream in chunks, isolates bad records and resumes", async () => {
    const records = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({
        ...grain(),
        fdcId: 500000 + from + i,
        description: `File food ${from + i}`,
      }));
    async function* stream(items: unknown[], failAfter?: number) {
      let k = 0;
      for (const r of items) {
        if (failAfter !== undefined && k === failAfter) throw new Error("disk read error");
        k++;
        yield r;
      }
    }
    // Record 3 is too large for the database: only it fails; the others are stored.
    const items: unknown[] = records(450);
    (items[3] as { foodNutrients: unknown[] }).foodNutrients = [
      { nutrient: { id: 1003, number: "203", name: "Protein", unitName: "g" }, amount: 1e20 },
    ];
    const first = await importRecordStream(ctx, stream(items, 420), {
      name: "test-foods.json",
      size: 12345,
    });
    // Reading stops after 420 records; the 20 already read and checked are still stored.
    expect([first.status, first.created, first.failed]).toEqual(["FAILED", 419, 2]);
    // Rerun with the same file: continues after the last stored record (420 read).
    const second = await importRecordStream(ctx, stream(items), {
      name: "test-foods.json",
      size: 12345,
    });
    expect([second.resumedAfter, second.status, second.created]).toEqual([420, "PARTIAL", 449]);
    expect(
      await getDb().referenceFood.count({
        where: { organizationId: ctx.organizationId, name: { startsWith: "File food" } },
      }),
    ).toBe(449);
  });
});
