import "server-only";
import { createHash } from "node:crypto";
import { Decimal } from "@/lib/decimal";
import type { Prisma } from "@/generated/prisma/client";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { getEnv } from "@/server/env";
import { businessRuleViolation } from "@/server/errors";
import { consumeRateLimit } from "@/server/rate-limit";
import { parseOpenFoodFacts, SOURCE_TERMS, type ParsedFood } from "../library-parsers";
import { NUTRIENTS, type Nutrient } from "../rules";
import { backoff, ProviderError } from "./providers";

/**
 * Live Open Food Facts lookup by barcode (DECISIONS.md ADR-132). Open Food
 * Facts is crowd-sourced (ODbL): a record is a lead, never a verified
 * specification. It is read through the same parser as the file import
 * (ADR-041), so allergens become CONTAINS / MAY_CONTAIN only, and nothing
 * missing turns into zero. No key; calls are made from the server only,
 * with a generic client name, a timeout, two attempts and a budget per
 * minute shared by all instances.
 */

type Fetch = typeof fetch;
let testFetch: Fetch | null = null;
let testSleep: ((ms: number) => Promise<void>) | null = null;
/** Tests replace the network and the clock; nothing else should. */
export function setTestOffTransport(
  f: Fetch | null,
  sleep?: ((ms: number) => Promise<void>) | null,
) {
  testFetch = f;
  testSleep = sleep ?? null;
}

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;
const FIELDS = [
  "code",
  "product_name",
  "product_name_en",
  "product_name_ar",
  "generic_name",
  "brands",
  "quantity",
  "product_quantity_unit",
  "nutriments",
  "no_nutrition_data",
  "allergens_tags",
  "traces_tags",
  "ingredients_text",
  "ingredients_text_en",
  "ingredients_text_ar",
  "last_modified_t",
].join(",");

export const offEnabled = () => getEnv().OPEN_FOOD_FACTS_LOOKUP;

/** The product JSON for a barcode, or NOT_FOUND. */
export async function fetchOffProduct(barcode: string): Promise<Record<string, unknown>> {
  const env = getEnv();
  if (!env.OPEN_FOOD_FACTS_LOOKUP)
    throw new ProviderError("NOT_CONFIGURED", "Open Food Facts lookup is switched off");
  const limit = await consumeRateLimit("open-food-facts", {
    window: 60,
    max: env.OPEN_FOOD_FACTS_REQUESTS_PER_MINUTE,
  });
  if (!limit.allowed)
    throw new ProviderError(
      "RATE_LIMITED",
      "Open Food Facts request budget used",
      limit.retryAfter,
    );
  const doFetch = testFetch ?? fetch;
  const sleep = testSleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: ProviderError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await doFetch(
        `${env.OPEN_FOOD_FACTS_BASE_URL}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${FIELDS}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "FoodAmbassador/1.0 (nutrition library)",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch (error) {
      last = new ProviderError(
        "UNAVAILABLE",
        (error as Error).name === "TimeoutError"
          ? "Open Food Facts did not answer in time"
          : "Open Food Facts could not be reached",
      );
      if (attempt < MAX_ATTEMPTS) await sleep(backoff(attempt));
      continue;
    }
    if (res.status === 404) throw new ProviderError("NOT_FOUND", "Not in Open Food Facts");
    if (res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ProviderError(
          "BAD_RESPONSE",
          "Open Food Facts returned something that is not JSON",
        );
      }
      const b = body as { status?: unknown; product?: unknown };
      if (b.status === 0 || b.status === "failure" || typeof b.product !== "object" || !b.product)
        throw new ProviderError("NOT_FOUND", "Not in Open Food Facts");
      return { code: barcode, ...(b.product as Record<string, unknown>) };
    }
    last = new ProviderError(
      res.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE",
      res.status === 429
        ? "Open Food Facts rate limit reached"
        : `Open Food Facts error ${res.status}`,
    );
    if (res.status !== 429 && res.status < 500) break;
    if (attempt < MAX_ATTEMPTS) await sleep(backoff(attempt));
  }
  throw last ?? new ProviderError("UNAVAILABLE", "Open Food Facts could not be reached");
}

const barcodeOf = (raw: string) => {
  const digits = raw.trim();
  if (!/^\d{6,14}$/.test(digits))
    throw businessRuleViolation("BARCODE_INVALID", "A barcode is 6 to 14 digits");
  return digits;
};

function parseProduct(product: Record<string, unknown>): ParsedFood {
  const parsed = parseOpenFoodFacts(JSON.stringify(product));
  const food = parsed.foods[0];
  if (!food)
    throw new ProviderError("BAD_RESPONSE", "The Open Food Facts record has no name or barcode");
  return food;
}

/** What Open Food Facts has for a barcode, without storing anything. */
export async function lookupOpenFoodFacts(ctx: TenantContext, rawBarcode: string) {
  assertPermission(ctx.grants, "nutrition.view");
  const product = await fetchOffProduct(barcodeOf(rawBarcode));
  const f = parseProduct(product);
  return {
    barcode: f.sourceId,
    name: f.name,
    nameAr: f.nameAr,
    brand: f.brand,
    basis: f.basis,
    values: f.values,
    allergens: f.allergens,
    traces: f.traces,
    notes: f.notes,
    sourceUrl: f.sourceUrl,
    licence: SOURCE_TERMS.OPEN_FOOD_FACTS.licence,
  };
}

/** Summary column → dictionary code; sodium is kept in g on the summary, mg in the dictionary. */
const CODE_OF: Record<Nutrient, { code: string; factor: string }> = {
  energyKcal: { code: "energy_kcal", factor: "1" },
  energyKj: { code: "energy_kj", factor: "1" },
  fat: { code: "fat", factor: "1" },
  saturatedFat: { code: "saturated_fat", factor: "1" },
  carbohydrate: { code: "carbohydrate", factor: "1" },
  sugars: { code: "sugars", factor: "1" },
  fibre: { code: "fibre", factor: "1" },
  protein: { code: "protein", factor: "1" },
  salt: { code: "salt", factor: "1" },
  sodium: { code: "sodium", factor: "1000" },
};

/**
 * Bring an Open Food Facts product into the library: the record (with its
 * allergen tags for linking), its per-100 values with status REPORTED, the
 * barcode as identifiers, the declared ingredients as published (not
 * translated) and the payload as a source version. A record that changed
 * since it was verified goes back to awaiting verification.
 */
export async function importOpenFoodFacts(ctx: TenantContext, rawBarcode: string) {
  assertPermission(ctx.grants, "nutrition.manage");
  const barcode = barcodeOf(rawBarcode);
  const product = await fetchOffProduct(barcode);
  const f = parseProduct(product);
  const payloadHash = createHash("sha256").update(JSON.stringify(product)).digest("hex");
  const terms = SOURCE_TERMS.OPEN_FOOD_FACTS;
  const ingredients =
    (typeof product.ingredients_text_en === "string" && product.ingredients_text_en) ||
    (typeof product.ingredients_text === "string" && product.ingredients_text) ||
    null;
  return withTenantTx(ctx.organizationId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`off:${ctx.organizationId}:${f.sourceId}`}))`;
    const before = await tx.referenceFood.findUnique({
      where: {
        organizationId_source_sourceId: {
          organizationId: ctx.organizationId,
          source: "OPEN_FOOD_FACTS",
          sourceId: f.sourceId,
        },
      },
    });
    if (before?.contentHash === payloadHash) {
      await tx.referenceFood.update({
        where: { id: before.id },
        data: { lastFetchedAt: new Date() },
      });
      return { foodId: before.id, result: "unchanged" as const };
    }
    const data = {
      dataType: "Open Food Facts",
      name: f.name,
      nameAr: f.nameAr,
      description: f.description,
      brand: f.brand,
      basis: f.basis,
      barcode: f.sourceId,
      ingredientsText: ingredients ? ingredients.slice(0, 5000) : null,
      ...Object.fromEntries(NUTRIENTS.map((n) => [n, f.values[n] ?? null])),
      allergens: f.allergens,
      traces: f.traces,
      unmappedTags: f.unmappedTags,
      notes: f.notes,
      licence: terms.licence,
      attribution: terms.attribution,
      sourceUrl: f.sourceUrl,
      lastFetchedAt: new Date(),
      contentHash: payloadHash,
      ...(before?.verifiedAt ? { verifiedAt: null, verifiedByUserId: null } : {}),
    };
    const food = before
      ? await tx.referenceFood.update({ where: { id: before.id }, data })
      : await tx.referenceFood.create({
          data: {
            organizationId: ctx.organizationId,
            source: "OPEN_FOOD_FACTS",
            sourceId: f.sourceId,
            ...data,
          },
        });
    // Versions are never updated (a trigger refuses it): look first, then create.
    const version =
      (await tx.foodSourceVersion.findUnique({
        where: {
          organizationId_foodId_payloadHash: {
            organizationId: ctx.organizationId,
            foodId: food.id,
            payloadHash,
          },
        },
        select: { id: true },
      })) ??
      (await tx.foodSourceVersion.create({
        data: {
          organizationId: ctx.organizationId,
          foodId: food.id,
          source: "OPEN_FOOD_FACTS",
          sourceId: f.sourceId,
          dataType: "Open Food Facts",
          payload: product as Prisma.InputJsonValue,
          payloadHash,
          via: "API",
        },
        select: { id: true },
      }));
    // Values: replaced from the new record; marks of "not applicable" made by a person stay.
    const dictionary = await tx.nutrient.findMany({
      where: { organizationId: null, code: { in: Object.values(CODE_OF).map((c) => c.code) } },
    });
    const kept = await tx.foodNutrientValue.findMany({
      where: { organizationId: ctx.organizationId, foodId: food.id, status: "NOT_APPLICABLE" },
      select: { nutrientId: true },
    });
    const keep = new Set(kept.map((k) => k.nutrientId));
    await tx.foodNutrientValue.deleteMany({
      where: {
        organizationId: ctx.organizationId,
        foodId: food.id,
        status: { not: "NOT_APPLICABLE" },
      },
    });
    const rows = NUTRIENTS.flatMap((n) => {
      const v = f.values[n];
      const d = dictionary.find((x) => x.code === CODE_OF[n].code);
      if (v === undefined || !d || keep.has(d.id)) return [];
      return [
        {
          organizationId: ctx.organizationId,
          foodId: food.id,
          nutrientId: d.id,
          status: "REPORTED" as const,
          originalAmount: v,
          originalUnit: n === "energyKcal" ? "kcal" : n === "energyKj" ? "kJ" : "g",
          amount: new Decimal(v).times(CODE_OF[n].factor).toFixed(),
          unit: d.unit,
          note: "Open Food Facts (crowd-sourced)",
          versionId: version.id,
        },
      ];
    });
    if (rows.length) await tx.foodNutrientValue.createMany({ data: rows });
    for (const kind of ["GTIN_UPC", "OFF_CODE"] as const)
      await tx.foodIdentifier.upsert({
        where: {
          organizationId_foodId_kind_value: {
            organizationId: ctx.organizationId,
            foodId: food.id,
            kind,
            value: f.sourceId,
          },
        },
        create: { organizationId: ctx.organizationId, foodId: food.id, kind, value: f.sourceId },
        update: {},
      });
    const findings: Prisma.FoodDataIssueCreateManyInput[] = [];
    const missing = (["energyKcal", "fat", "carbohydrate", "protein"] as const).filter(
      (n) => f.values[n] === undefined,
    );
    if (missing.length)
      findings.push({
        organizationId: ctx.organizationId,
        foodId: food.id,
        kind: "MISSING_CORE_NUTRIENTS",
        detail: `Open Food Facts gives no ${missing.join(", ")}`,
        data: { missing },
      });
    if (before?.verifiedAt)
      findings.push({
        organizationId: ctx.organizationId,
        foodId: food.id,
        kind: "CHANGED_AFTER_VERIFICATION",
        detail: "The Open Food Facts record changed after it was verified",
        data: {},
      });
    if (findings.length)
      await tx.foodDataIssue.createMany({ data: findings, skipDuplicates: true });
    await recordAudit(tx, actorOf(ctx), {
      action: "nutrition.off_imported",
      entityType: "reference_food",
      entityId: food.id,
      changes: { barcode: f.sourceId, result: before ? "updated" : "created" },
    });
    return { foodId: food.id, result: before ? ("updated" as const) : ("created" as const) };
  });
}
