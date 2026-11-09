import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as foodsRoute from "@/app/api/v1/nutrition/foods/route";
import { createApiClient } from "@/modules/api/clients";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { resetEnvCache } from "@/server/env";
import { addMember, createTenant, expectAppError } from "../../../../test/support/factories";
import { findByBarcode, getFood, updateFood } from "./foods";
import { importOpenFoodFacts, lookupOpenFoodFacts, setTestOffTransport } from "./off";
import { setTestProvider, type FoodProvider } from "./providers";

/**
 * Live Open Food Facts lookup (ADR-132) with a stand-in network. Payloads
 * follow the published API v2 product shape; the values are placeholders.
 */

const CODE = "6281000000017";
const product = (fat = 50) => ({
  status: 1,
  code: CODE,
  product: {
    product_name: "Test tahini",
    product_name_ar: "طحينة تجريبية",
    brands: "Test Brand",
    product_quantity_unit: "g",
    ingredients_text: "Sesame seeds",
    nutriments: { "energy-kcal_100g": 600, fat_100g: fat, proteins_100g: 17, sodium_100g: 0.02 },
    allergens_tags: ["en:sesame-seeds"],
    traces_tags: ["en:peanuts"],
  },
});

let responses: Array<Response | Error> = [];
const seen: Array<{ url: string; ua: string | null }> = [];
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let ctx: TenantContext;
let analyst: TenantContext;

// USDA is not configured here: barcode lookups must not depend on it.
const noUsda: FoodProvider = {
  id: "USDA_FDC",
  configured: () => false,
  search: async () => ({ total: 0, foods: [] }),
  food: async () => ({}),
  foods: async () => [],
  latestPublished: async () => null,
  ping: async () => ({ ok: false, ms: 0 }),
};

beforeAll(async () => {
  ({ ctx } = await createTenant("nutrition-off"));
  analyst = (await addMember(ctx, "analyst", {}, "off-analyst")).ctx;
  setTestProvider(noUsda);
  setTestOffTransport(
    (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), ua: new Headers(init?.headers).get("user-agent") });
      const r = responses.shift();
      if (!r) throw new Error("no response queued");
      if (r instanceof Error) throw r;
      return r;
    }) as typeof fetch,
    async () => {},
  );
});

beforeEach(() => {
  responses = [];
  seen.length = 0;
});

afterAll(async () => {
  setTestOffTransport(null);
  setTestProvider(null);
  delete process.env.OPEN_FOOD_FACTS_LOOKUP;
  resetEnvCache();
  await getDb().$disconnect();
});

describe("Open Food Facts live lookup (ADR-132)", () => {
  it("previews a product without storing it, from the server with a generic client name", async () => {
    responses = [json(200, product())];
    const p = await lookupOpenFoodFacts(analyst, CODE);
    expect(p).toMatchObject({
      barcode: CODE,
      name: "Test tahini",
      nameAr: "طحينة تجريبية",
      basis: "PER_100G",
      allergens: ["SESAME"],
      traces: ["PEANUTS"],
    });
    expect(p.values).toMatchObject({ energyKcal: "600", fat: "50" });
    // Not given is not zero.
    expect(p.values.carbohydrate).toBeUndefined();
    expect(seen[0].url).toContain(`/api/v2/product/${CODE}.json`);
    expect(seen[0].ua).toBe("FoodAmbassador/1.0 (nutrition library)");
    expect(
      await getDb().referenceFood.count({ where: { organizationId: ctx.organizationId } }),
    ).toBe(0);
  });

  it("imports it as an unverified library record with values, identifiers and history", async () => {
    await expectAppError(importOpenFoodFacts(analyst, CODE), "FORBIDDEN");
    responses = [json(200, product())];
    const r = await importOpenFoodFacts(ctx, CODE);
    expect(r.result).toBe("created");
    const f = await getFood(ctx, r.foodId);
    expect(f.food).toMatchObject({ source: "OPEN_FOOD_FACTS", barcode: CODE, verified: false });
    expect(f.food.ingredientsText).toBe("Sesame seeds");
    expect(f.nutrients.find((n) => n.code === "sodium")).toMatchObject({
      amount: "20",
      unit: "mg",
    });
    expect(f.nutrients.find((n) => n.code === "carbohydrate")).toBeUndefined();
    expect(f.missingCore.map((m) => m.code)).toContain("carbohydrate");
    expect(f.identifiers.map((i) => i.kind).sort()).toEqual(["GTIN_UPC", "OFF_CODE"]);
    expect(f.versions).toHaveLength(1);
    expect(f.issues.map((i) => i.kind)).toContain("MISSING_CORE_NUTRIENTS");
    // The same record again changes nothing.
    responses = [json(200, product())];
    expect((await importOpenFoodFacts(ctx, CODE)).result).toBe("unchanged");
    // Verified, then changed at the source: back to awaiting verification, with a finding.
    await updateFood(ctx, r.foodId, { verified: true });
    responses = [json(200, product(48))];
    expect((await importOpenFoodFacts(ctx, CODE)).result).toBe("updated");
    const again = await getFood(ctx, r.foodId);
    expect(again.food.verified).toBe(false);
    expect(again.versions).toHaveLength(2);
    expect(again.issues.map((i) => i.kind)).toContain("CHANGED_AFTER_VERIFICATION");
    // Now in the library, a barcode lookup answers from there without asking anyone.
    const b = await findByBarcode(ctx, `0${CODE}`);
    expect(b.local.map((l) => l.id)).toEqual([r.foodId]);
    expect(b.openFoodFacts.status).toBe("SKIPPED");
  });

  it("reports outages and unknown barcodes without failing the lookup", async () => {
    responses = [json(200, { status: 0, status_verbose: "product not found" })];
    expect((await findByBarcode(ctx, "4000000000002")).openFoodFacts).toEqual({
      status: "NOT_FOUND",
      product: null,
    });
    // One retry after a server error, then UNAVAILABLE.
    responses = [json(503, {}), new TypeError("fetch failed")];
    expect((await findByBarcode(ctx, "4000000000019")).openFoodFacts.status).toBe("UNAVAILABLE");
    expect(seen.filter((s) => s.url.includes("4000000000019"))).toHaveLength(2);
    // Switched off: nothing is asked.
    process.env.OPEN_FOOD_FACTS_LOOKUP = "0";
    resetEnvCache();
    expect((await findByBarcode(ctx, "4000000000026")).openFoodFacts.status).toBe("NOT_CONFIGURED");
    expect(seen.some((s) => s.url.includes("4000000000026"))).toBe(false);
    delete process.env.OPEN_FOOD_FACTS_LOOKUP;
    resetEnvCache();
    await expectAppError(lookupOpenFoodFacts(ctx, "12ab"), "BUSINESS_RULE_VIOLATION");
  });

  it("imports through the REST API with nutrition:write", async () => {
    const { key } = await createApiClient(ctx, { name: "OFF", scopes: ["nutrition:write"] });
    const post = async (body: unknown) => {
      const res = await foodsRoute.POST(
        new Request("http://localhost/api/v1/nutrition/foods", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    responses = [json(404, {})];
    expect(await post({ offBarcode: "4000000000033" })).toEqual({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "Not found in Open Food Facts" } },
    });
    responses = [json(200, { ...product(), code: "4000000000040" })];
    const ok = await post({ offBarcode: "4000000000040" });
    expect(ok.status).toBe(200);
    expect(ok.body.result).toBe("created");
  });
});
