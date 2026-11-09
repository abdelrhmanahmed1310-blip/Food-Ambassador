import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as barcodeRoute from "@/app/api/v1/nutrition/foods/barcode/[code]/route";
import * as calculateRoute from "@/app/api/v1/nutrition/foods/calculate/route";
import * as compareRoute from "@/app/api/v1/nutrition/foods/compare/route";
import * as foodRoute from "@/app/api/v1/nutrition/foods/[id]/route";
import * as nutritionRoute from "@/app/api/v1/nutrition/foods/[id]/nutrition/route";
import * as refreshRoute from "@/app/api/v1/nutrition/foods/[id]/refresh/route";
import * as servingsRoute from "@/app/api/v1/nutrition/foods/[id]/servings/route";
import * as foodsRoute from "@/app/api/v1/nutrition/foods/route";
import * as searchRoute from "@/app/api/v1/nutrition/foods/search/route";
import * as categoriesRoute from "@/app/api/v1/nutrition/categories/route";
import * as healthRoute from "@/app/api/v1/nutrition/health/route";
import * as nutrientsRoute from "@/app/api/v1/nutrition/nutrients/route";
import * as analyzeRoute from "@/app/api/v1/nutrition/recipes/analyze/route";
import * as sourcesRoute from "@/app/api/v1/nutrition/sources/route";
import * as jobsRoute from "@/app/api/v1/nutrition/sync/jobs/route";
import * as statusRoute from "@/app/api/v1/nutrition/sync/status/route";
import * as usdaRoute from "@/app/api/v1/nutrition/sync/usda/route";
import { createApiClient } from "@/modules/api/clients";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { createTenant } from "../../../../test/support/factories";
import { clearNutritionHealthCache } from "./api";
import { clearUsdaSearchCache } from "./foods";
import { ProviderError, setTestProvider, type FoodProvider } from "./providers";

/** REST API v1 nutrition endpoints through their route handlers (ADR-132). */

const BASE = "http://localhost/api/v1/nutrition";
type Body = Record<string, unknown> & {
  error?: { code: string; rule?: string; details?: unknown };
};

async function send(
  handler: (req: Request, ctx: never) => Promise<Response>,
  key: string | null,
  path: string,
  opts: { method?: string; body?: unknown; raw?: string; type?: string; params?: object } = {},
) {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  const hasBody = opts.body !== undefined || opts.raw !== undefined;
  if (hasBody) headers["content-type"] = opts.type ?? "application/json";
  const req = new Request(`${BASE}${path}`, {
    method: opts.method ?? (hasBody ? "POST" : "GET"),
    headers,
    ...(hasBody ? { body: opts.raw ?? JSON.stringify(opts.body) } : {}),
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) } as never);
  return { status: res.status, body: (await res.json()) as Body };
}

const grain = {
  fdcId: 410001,
  dataType: "Foundation",
  description: "Test barley, cooked",
  foodCategory: { description: "Cereal Grains and Pasta" },
  foodNutrients: [
    { nutrient: { id: 1008, number: "208", name: "Energy", unitName: "kcal" }, amount: 120 },
    { nutrient: { id: 1003, number: "203", name: "Protein", unitName: "g" }, amount: 2.3 },
    { nutrient: { id: 1004, number: "204", name: "Fat", unitName: "g" }, amount: 0.4 },
    { nutrient: { id: 1005, number: "205", name: "Carbohydrate", unitName: "g" }, amount: 28 },
    { nutrient: { id: 1093, number: "307", name: "Sodium, Na", unitName: "mg" }, amount: 3 },
  ],
  foodPortions: [{ amount: 1, gramWeight: 157, modifier: "cup", measureUnit: { name: "cup" } }],
};

type Total = { code: string; amount: string | null; complete: boolean };
const byCode = (rows: unknown) =>
  Object.fromEntries((rows as Total[]).map((r) => [r.code, r])) as Record<string, Total>;

let failing: ProviderError | null = null;
const fake: FoodProvider = {
  id: "USDA_FDC",
  configured: () => true,
  async search() {
    if (failing) throw failing;
    return { total: 1, foods: [grain] };
  },
  async food(id) {
    if (failing) throw failing;
    if (id !== "410001") throw new ProviderError("NOT_FOUND", "Not found");
    return grain;
  },
  async foods(ids) {
    if (failing) throw failing;
    return ids.includes("410001") ? [grain] : [];
  },
  async latestPublished() {
    return null;
  },
  async ping() {
    return failing ? { ok: false, ms: 1, error: failing.code } : { ok: true, ms: 1 };
  },
};

let ctx: TenantContext;
let readKey: string;
let writeKey: string;
let otherKey: string;
let catalogKey: string;
let manualId: string;
let barleyId: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("nutrition-api", {
    baseCurrency: "SAR",
    timeZone: "Asia/Riyadh",
  }));
  const { ctx: other } = await createTenant("nutrition-api-other");
  readKey = (await createApiClient(ctx, { name: "Read", scopes: ["nutrition:read"] })).key;
  writeKey = (await createApiClient(ctx, { name: "Write", scopes: ["nutrition:write"] })).key;
  catalogKey = (await createApiClient(ctx, { name: "Catalog", scopes: ["products:read"] })).key;
  otherKey = (await createApiClient(other, { name: "Theirs", scopes: ["nutrition:write"] })).key;
  setTestProvider(fake);
});

beforeEach(() => {
  failing = null;
  clearUsdaSearchCache();
  clearNutritionHealthCache();
});

afterAll(async () => {
  setTestProvider(null);
  await getDb().$disconnect();
});

describe("REST API v1 nutrition (ADR-132)", () => {
  it("needs a key with the nutrition scopes; reading does not allow writing", async () => {
    expect((await send(searchRoute.GET, null, "/foods/search")).status).toBe(401);
    expect((await send(searchRoute.GET, catalogKey, "/foods/search")).status).toBe(403);
    expect((await send(searchRoute.GET, readKey, "/foods/search?mode=LOCAL")).status).toBe(200);
    const refused = await send(foodsRoute.POST, readKey, "/foods", { body: { name: "X" } });
    expect(refused.status).toBe(403);
    expect(
      await getDb().referenceFood.count({ where: { organizationId: ctx.organizationId } }),
    ).toBe(0);
  });

  it("rejects bodies that are not JSON, too large or invalid, without echoing them", async () => {
    const bad = await send(foodsRoute.POST, writeKey, "/foods", { raw: "{name:" });
    expect(bad).toEqual({
      status: 400,
      body: { error: { code: "INVALID_JSON", message: "The body is not valid JSON" } },
    });
    expect(
      (await send(foodsRoute.POST, writeKey, "/foods", { raw: "name=x", type: "text/plain" }))
        .status,
    ).toBe(415);
    const big = await send(foodsRoute.POST, writeKey, "/foods", {
      body: { name: "x", ingredientsText: "a".repeat(1024 * 1024) },
    });
    expect(big.status).toBe(413);
    const invalid = await send(foodsRoute.POST, writeKey, "/foods", {
      body: { name: "", values: { protein: "abc" } },
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error?.code).toBe("VALIDATION_FAILED");
    const paths = (invalid.body.error?.details as { issues: Array<{ path: string }> }).issues.map(
      (i) => i.path,
    );
    expect(paths).toContain("name");
    expect(JSON.stringify(invalid.body)).not.toContain("abc");
  });

  it("creates a manual food and reads it back; missing values stay missing", async () => {
    const created = await send(foodsRoute.POST, writeKey, "/foods", {
      body: {
        name: "House labneh",
        nameAr: "لبنة البيت",
        values: { energy_kcal: "160", protein: "6", fat: "11", alcohol: "NA" },
      },
    });
    expect(created.status).toBe(200);
    manualId = created.body.id as string;
    const got = await send(foodRoute.GET, readKey, `/foods/${manualId}?lang=ar`, {
      params: { id: manualId },
    });
    expect(got.status).toBe(200);
    const food = got.body.food as { nameAr: string; displayName: string };
    expect(food).toMatchObject({ nameAr: "لبنة البيت", displayName: "لبنة البيت" });
    const values = got.body.nutrients as Array<{ code: string; status: string; amount: unknown }>;
    expect(values.find((v) => v.code === "protein")).toMatchObject({ amount: "6" });
    expect(values.find((v) => v.code === "alcohol")?.status).toBe("NOT_APPLICABLE");
    // Carbohydrate was not given: it is missing, never 0.
    const carb = values.find((v) => v.code === "carbohydrate");
    expect(carb).toBeUndefined();
    expect(got.body.missingCore as Array<{ code: string; status: string }>).toContainEqual(
      expect.objectContaining({ code: "carbohydrate", status: "MISSING" }),
    );

    const half = await send(
      nutritionRoute.GET,
      readKey,
      `/foods/${manualId}/nutrition?quantity=50`,
      {
        params: { id: manualId },
      },
    );
    expect(half.status).toBe(200);
    const protein = (half.body.values as Array<{ code: string; amount: string }>).find(
      (v) => v.code === "protein",
    );
    expect(protein?.amount).toBe("3");
    // Millilitres need the food's own density.
    const ml = await send(
      nutritionRoute.GET,
      readKey,
      `/foods/${manualId}/nutrition?quantity=100&unit=ml`,
      {
        params: { id: manualId },
      },
    );
    expect(ml.status).toBe(422);
    expect(ml.body.error?.rule).toBe("NUTRITION_NEEDS_DENSITY");
  });

  it("maintains servings and the food, but never its source values", async () => {
    const added = await send(servingsRoute.POST, writeKey, `/foods/${manualId}/servings`, {
      body: { description: "1 tbsp", gramWeight: "15", millilitres: "15" },
      params: { id: manualId },
    });
    expect(added.status).toBe(201);
    const list = await send(servingsRoute.GET, readKey, `/foods/${manualId}/servings`, {
      params: { id: manualId },
    });
    expect(
      (list.body as unknown as Array<{ description: string }>).map((s) => s.description),
    ).toContain("1 tbsp");
    const patched = await send(foodRoute.PATCH, writeKey, `/foods/${manualId}`, {
      method: "PATCH",
      body: { verified: true, addAliases: [{ locale: "ar", name: "لبنة" }] },
      params: { id: manualId },
    });
    expect(patched.status).toBe(200);
    const row = await getDb().referenceFood.findUniqueOrThrow({ where: { id: manualId } });
    expect(row.verifiedAt).not.toBeNull();
    // Only USDA records are refreshed.
    const refresh = await send(refreshRoute.POST, writeKey, `/foods/${manualId}/refresh`, {
      method: "POST",
      params: { id: manualId },
    });
    expect(refresh.status).toBe(422);
    expect(refresh.body.error?.rule).toBe("FOOD_NOT_REFRESHABLE");
  });

  it("imports from USDA, searches hybrid, and reports USDA outages as 503", async () => {
    const imported = await send(foodsRoute.POST, writeKey, "/foods", {
      body: { fdcIds: [410001] },
    });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ created: 1, failed: [] });
    barleyId = (imported.body.foods as Array<{ foodId: string }>)[0].foodId;

    const hybrid = await send(searchRoute.GET, readKey, "/foods/search?q=barley&pageSize=5");
    const local = hybrid.body.local as { total: number; items: Array<{ id: string }> };
    expect(local.items.map((i) => i.id)).toEqual([barleyId]);
    // The imported record is not offered again from USDA.
    expect((hybrid.body.external as { items: unknown[] }).items).toHaveLength(0);

    failing = new ProviderError("UNAVAILABLE", "USDA is down");
    const stillWorks = await send(searchRoute.GET, readKey, "/foods/search?q=barley");
    expect(stillWorks.status).toBe(200);
    expect((stillWorks.body.external as { status: string }).status).toBe("UNAVAILABLE");
    const refresh = await send(refreshRoute.POST, writeKey, `/foods/${barleyId}/refresh`, {
      method: "POST",
      params: { id: barleyId },
    });
    expect(refresh).toEqual({
      status: 503,
      body: {
        error: { code: "USDA_UNAVAILABLE", message: "USDA FoodData Central is not reachable" },
      },
    });
    const health = await send(healthRoute.GET, readKey, "/health");
    expect(health.body).toMatchObject({
      status: "degraded",
      database: { ok: true },
      usda: { ok: false },
    });
    failing = null;
    const unchanged = await send(refreshRoute.POST, writeKey, `/foods/${barleyId}/refresh`, {
      method: "POST",
      params: { id: barleyId },
    });
    expect(unchanged.body.result).toBe("unchanged");
  });

  it("calculates, compares and analyses recipes from library foods", async () => {
    const cup = (
      await send(servingsRoute.GET, readKey, `/foods/${barleyId}/servings`, {
        params: { id: barleyId },
      })
    ).body as unknown as Array<{ id: string; gramWeight: string }>;
    const calc = await send(calculateRoute.POST, readKey, "/foods/calculate", {
      body: {
        items: [
          { foodId: barleyId, quantity: 1, unit: "portion", portionId: cup[0].id },
          { foodId: manualId, quantity: "30", unit: "g" },
        ],
      },
    });
    expect(calc.status).toBe(200);
    const totals = byCode(calc.body.total);
    // 157 g × 2.3/100 + 30 g × 6/100 = 3.611 + 1.8
    expect(totals.protein).toMatchObject({ amount: "5.411", complete: true });
    // The labneh has no carbohydrate value, so the total is not claimed.
    expect(totals.carbohydrate.amount).toBeNull();
    expect(totals.carbohydrate.complete).toBe(false);

    const cmp = await send(compareRoute.POST, readKey, "/foods/compare", {
      body: { foodIds: [barleyId, manualId] },
    });
    expect(cmp.status).toBe(200);
    expect((cmp.body.foods as unknown[]).length).toBe(2);

    const recipe = await send(analyzeRoute.POST, readKey, "/recipes/analyze", {
      body: {
        ingredients: [
          { foodId: barleyId, quantity: "300", unit: "g" },
          { foodId: manualId, quantity: "100", unit: "g" },
        ],
        servings: 4,
        finishedGrams: "350",
      },
    });
    expect(recipe.status).toBe(200);
    expect(recipe.body).toMatchObject({
      totalGrams: "400",
      finishedGrams: "350",
      yieldFromRawWeight: false,
    });
    const perServing = byCode(recipe.body.perServing);
    // (300 × 120 + 100 × 160) / 100 / 4 = 130 kcal
    expect(perServing.energy_kcal.amount).toBe("130");
  });

  it("lists the dictionary, categories, sources, barcode lookups and sync state", async () => {
    const nutrients = await send(nutrientsRoute.GET, readKey, "/nutrients?q=protein");
    expect((nutrients.body as unknown as Array<{ code: string }>).map((n) => n.code)).toContain(
      "protein",
    );
    const categories = await send(categoriesRoute.GET, readKey, "/categories");
    expect(
      (categories.body as unknown as Array<{ name: string; foods: number }>).find(
        (c) => c.name === "Cereal Grains and Pasta",
      )?.foods,
    ).toBe(1);
    const sources = await send(sourcesRoute.GET, readKey, "/sources");
    expect((sources.body.library as Array<{ source: string }>).map((s) => s.source).sort()).toEqual(
      ["MANUAL", "USDA_FDC"],
    );
    const badBarcode = await send(barcodeRoute.GET, readKey, "/foods/barcode/12ab", {
      params: { code: "12ab" },
    });
    expect(badBarcode.body.error).toMatchObject({
      code: "BUSINESS_RULE_VIOLATION",
      rule: "BARCODE_INVALID",
    });

    const queued = await send(usdaRoute.POST, writeKey, "/sync/usda", {
      body: { kind: "IMPORT", fdcIds: ["410001"] },
    });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ kind: "IMPORT", status: "QUEUED", total: 1 });
    const jobs = await send(jobsRoute.GET, readKey, "/sync/jobs?pageSize=1");
    expect(jobs.body).toMatchObject({ total: 1, pageSize: 1 });
    const status = await send(statusRoute.GET, readKey, "/sync/status");
    expect(status.body).toMatchObject({ usdaConfigured: true, running: 1 });
    // Queuing needs the write scope.
    expect(
      (await send(usdaRoute.POST, readKey, "/sync/usda", { body: { kind: "RELEASE_CHECK" } }))
        .status,
    ).toBe(403);
  });

  it("never shows one organization's foods to another's key", async () => {
    for (const id of [manualId, barleyId]) {
      expect((await send(foodRoute.GET, otherKey, `/foods/${id}`, { params: { id } })).status).toBe(
        404,
      );
      const patch = await send(foodRoute.PATCH, otherKey, `/foods/${id}`, {
        method: "PATCH",
        body: { archived: true, archiveReason: "x" },
        params: { id },
      });
      expect(patch.status).toBe(404);
    }
    const theirs = await send(searchRoute.GET, otherKey, "/foods/search?mode=LOCAL");
    expect((theirs.body.local as { total: number }).total).toBe(0);
  });
});
