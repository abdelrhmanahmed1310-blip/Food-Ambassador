import "server-only";
import { z } from "zod";
import { Prisma, type FoodIssueKind } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withSystemTx, withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { SOURCE_TERMS } from "../library-parsers";
import { NUTRIENTS } from "../rules";
import {
  analyzeRecipe,
  basisQuantity,
  CalcError,
  scale,
  type QuantityUnit,
  type ValueIn,
} from "./calculate";
import {
  normalizeFdcFood,
  standardize,
  type DictionaryEntry,
  type NormalizedFood,
  type SourceNutrient,
} from "./normalize";
import { ProviderError, usdaProvider } from "./providers";

/**
 * The food library behind the nutrition engine (DECISIONS.md ADR-132):
 * hybrid search over the organization's library and USDA FoodData Central,
 * import and refresh with source history, food profiles and calculations.
 * USDA records are kept as published; a product's own verified
 * specification (ADR-040) is never overwritten by them.
 */

export const SEARCH_MODES = ["LOCAL", "USDA", "HYBRID"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
export const QUANTITY_UNITS = ["g", "kg", "mg", "oz", "lb", "ml", "l", "portion"] as const;

const MAX_PAGE_SIZE = 100;
const view = (ctx: TenantContext) => assertPermission(ctx.grants, "nutrition.view");
const manage = (ctx: TenantContext) => assertPermission(ctx.grants, "nutrition.manage");

/** Source priority for a product's nutrition, highest first (shown on the Sources page). */
export const SOURCE_PRIORITY = [
  { key: "PROFILE_LAB", origin: "PRODUCT", label: "Laboratory analysis (product)" },
  {
    key: "PROFILE_SUPPLIER_SPEC",
    origin: "PRODUCT",
    label: "Manufacturer specification (product)",
  },
  {
    key: "PROFILE_MANUAL",
    origin: "PRODUCT",
    label: "Verified packaging label / manual entry (product)",
  },
  { key: "LIBRARY_MANUAL", origin: "LIBRARY", label: "Organization's own library entry" },
  { key: "USDA_BRANDED", origin: "LIBRARY", label: "USDA Branded Foods" },
  { key: "USDA_FOUNDATION", origin: "LIBRARY", label: "USDA Foundation Foods" },
  { key: "USDA_SR_LEGACY", origin: "LIBRARY", label: "USDA SR Legacy" },
  { key: "USDA_FNDDS", origin: "LIBRARY", label: "USDA FNDDS (Survey)" },
  { key: "USDA_EXPERIMENTAL", origin: "LIBRARY", label: "USDA Experimental Foods" },
  { key: "OPEN_FOOD_FACTS", origin: "LIBRARY", label: "Open Food Facts" },
] as const;

// ─── Dictionary ───

export async function dictionaryInTx(tx: Tx): Promise<DictionaryEntry[]> {
  return tx.nutrient.findMany({
    select: { id: true, code: true, usdaNutrientId: true, usdaNumber: true, unit: true },
  });
}

const DICTIONARY_UNITS = new Set(["g", "mg", "µg", "kcal", "kJ", "IU"]);

/** Nutrients a source sends that the dictionary does not know yet: added as shared, unmapped entries. */
export async function learnNutrients(unknown: readonly SourceNutrient[]) {
  const fresh = unknown.filter(
    (n, i, all) =>
      n.usdaNutrientId !== null &&
      DICTIONARY_UNITS.has(n.unit) &&
      all.findIndex((x) => x.usdaNutrientId === n.usdaNutrientId) === i,
  );
  if (!fresh.length) return 0;
  return withSystemTx(async (tx) => {
    let added = 0;
    for (const n of fresh) {
      added += await tx.$executeRaw`
        INSERT INTO "nutrients" ("id", "usda_nutrient_id", "usda_number", "name", "unit")
        VALUES (gen_random_uuid(), ${n.usdaNutrientId}, ${n.number}, ${n.name.slice(0, 200)}, ${n.unit})
        ON CONFLICT DO NOTHING`;
    }
    return added;
  });
}

// ─── Applying a USDA record ───

export type ApplyResult = { foodId: string; result: "created" | "updated" | "unchanged" };

const SUMMARY_KEYS = NUTRIENTS;

/**
 * Store one normalized USDA food in the caller's transaction: the source
 * payload as a version (once per content), the food's fields and summary
 * values, every nutrient value against the dictionary, the source's
 * portions and identifiers, and the data-quality findings. A record whose
 * content did not change is only marked fetched. Values a person set as not
 * applicable, and portions a person added, are kept.
 */
export async function applyNormalizedInTx(
  tx: Tx,
  ctx: TenantContext,
  food: NormalizedFood,
  raw: unknown,
  opts: {
    via: "API" | "BULK_FILE" | "FILE";
    syncJobId?: string | null;
    dictionary: DictionaryEntry[];
  },
): Promise<ApplyResult> {
  const org = ctx.organizationId;
  const now = new Date();
  const existing = await tx.referenceFood.findUnique({
    where: {
      organizationId_source_sourceId: {
        organizationId: org,
        source: "USDA_FDC",
        sourceId: food.sourceId,
      },
    },
    select: { id: true, contentHash: true, verifiedAt: true },
  });
  if (existing && existing.contentHash === food.payloadHash) {
    await tx.referenceFood.update({ where: { id: existing.id }, data: { lastFetchedAt: now } });
    return { foodId: existing.id, result: "unchanged" };
  }
  const category = food.category
    ? await tx.foodCategory.upsert({
        where: { organizationId_name: { organizationId: org, name: food.category } },
        create: { organizationId: org, name: food.category },
        update: {},
        select: { id: true },
      })
    : null;
  const terms = SOURCE_TERMS.USDA_FDC;
  const summary = Object.fromEntries(SUMMARY_KEYS.map((n) => [n, food.summary.values[n] ?? null]));
  const fields = {
    dataType: food.dataType,
    name: food.name,
    description: food.category,
    brand: food.brand,
    basis: food.basis,
    ...summary,
    notes: food.summary.notes,
    licence: terms.licence,
    attribution: terms.attribution,
    sourceUrl: food.sourceUrl,
    barcode: food.barcode,
    categoryId: category?.id ?? null,
    ingredientsText: food.ingredientsText,
    publicationDate: food.publicationDate ? new Date(`${food.publicationDate}T00:00:00Z`) : null,
    lastFetchedAt: now,
    contentHash: food.payloadHash,
  };
  const row = existing
    ? await tx.referenceFood.update({
        where: { id: existing.id },
        // Values a person verified changed at the source: verification lapses until checked again.
        data: {
          ...fields,
          ...(existing.verifiedAt ? { verifiedAt: null, verifiedByUserId: null } : {}),
        },
        select: { id: true },
      })
    : await tx.referenceFood.create({
        data: { organizationId: org, source: "USDA_FDC", sourceId: food.sourceId, ...fields },
        select: { id: true },
      });
  const version =
    (await tx.foodSourceVersion.findUnique({
      where: {
        organizationId_foodId_payloadHash: {
          organizationId: org,
          foodId: row.id,
          payloadHash: food.payloadHash,
        },
      },
      select: { id: true },
    })) ??
    (await tx.foodSourceVersion.create({
      data: {
        organizationId: org,
        foodId: row.id,
        source: "USDA_FDC",
        sourceId: food.sourceId,
        dataType: food.dataType,
        publicationDate: fields.publicationDate,
        payload: raw as Prisma.InputJsonValue,
        payloadHash: food.payloadHash,
        via: opts.via,
        syncJobId: opts.syncJobId ?? null,
      },
      select: { id: true },
    }));
  const { values, issues: unitIssues } = standardize(food, opts.dictionary);
  // Source values are replaced as a whole; a person's "not applicable" stays.
  const kept = await tx.foodNutrientValue.findMany({
    where: { organizationId: org, foodId: row.id, status: "NOT_APPLICABLE" },
    select: { nutrientId: true },
  });
  const keep = new Set(kept.map((k) => k.nutrientId));
  await tx.foodNutrientValue.deleteMany({
    where: { organizationId: org, foodId: row.id, status: { not: "NOT_APPLICABLE" } },
  });
  const newValues = values.filter((v) => !keep.has(v.nutrientId));
  if (newValues.length)
    await tx.foodNutrientValue.createMany({
      data: newValues.map((v) => ({
        organizationId: org,
        foodId: row.id,
        nutrientId: v.nutrientId,
        status: v.status,
        sourceNutrientId: v.sourceNutrientId,
        sourceNumber: v.sourceNumber,
        originalAmount: v.originalAmount,
        originalUnit: v.originalUnit,
        amount: v.amount,
        unit: v.unit,
        derivationCode: v.derivationCode,
        derivationDescription: v.derivationDescription,
        dataPoints: v.dataPoints,
        note: v.note,
        versionId: v.status === "CALCULATED" ? null : version.id,
      })),
    });
  await tx.foodPortion.deleteMany({
    where: { organizationId: org, foodId: row.id, manual: false },
  });
  if (food.portions.length)
    await tx.foodPortion.createMany({
      data: food.portions.map((p) => ({
        organizationId: org,
        foodId: row.id,
        sequence: p.sequence,
        amount: p.amount,
        measure: p.measure,
        description: p.description,
        gramWeight: p.gramWeight,
        millilitres: p.millilitres,
      })),
    });
  await tx.foodIdentifier.createMany({
    data: food.identifiers.map((i) => ({
      organizationId: org,
      foodId: row.id,
      kind: i.kind,
      value: i.value,
    })),
    skipDuplicates: true,
  });
  const findings: Array<{
    kind: FoodIssueKind;
    detail: string;
    data: Prisma.InputJsonValue;
  }> = [...food.issues, ...unitIssues].map((i) => ({
    kind: i.kind,
    detail: i.detail.slice(0, 500),
    data: (i.data ?? {}) as Prisma.InputJsonValue,
  }));
  if (existing?.verifiedAt)
    findings.push({
      kind: "CHANGED_AFTER_VERIFICATION",
      detail: "The source published new values after a person verified this record",
      data: {} as Prisma.InputJsonValue,
    });
  if (food.barcode) {
    const twins = await tx.referenceFood.count({
      where: { organizationId: org, barcode: food.barcode, archivedAt: null, id: { not: row.id } },
    });
    if (twins)
      findings.push({
        kind: "DUPLICATE_BARCODE",
        detail: `${twins} other record(s) share barcode ${food.barcode}`,
        data: { barcode: food.barcode } as Prisma.InputJsonValue,
      });
  }
  if (findings.length)
    // One open finding per kind and food (partial unique index): repeats are skipped.
    await tx.foodDataIssue.createMany({
      data: findings.map((f) => ({ organizationId: org, foodId: row.id, ...f })),
      skipDuplicates: true,
    });
  return { foodId: row.id, result: existing ? "updated" : "created" };
}

/** Normalize, learn unknown nutrients, then store one payload in its own transaction. */
export async function applyFdcPayload(
  ctx: TenantContext,
  raw: unknown,
  opts: { via: "API" | "BULK_FILE" | "FILE"; syncJobId?: string | null },
): Promise<ApplyResult> {
  const food = normalizeFdcFood(raw);
  if (!food)
    throw businessRuleViolation("FOOD_UNREADABLE", "The record has no FDC id or description");
  await learnNutrients(standardize(food, []).unknown);
  return withTenantTx(ctx.organizationId, async (tx) => {
    // One writer per food: two imports of the same record never interleave.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`food:${ctx.organizationId}:${food.sourceId}`}))`;
    const dictionary = await dictionaryInTx(tx);
    return applyNormalizedInTx(tx, ctx, food, raw, { ...opts, dictionary });
  });
}

// ─── Search ───

const searchSchema = z.object({
  q: z.string().trim().max(200).catch(""),
  mode: z.enum(SEARCH_MODES).catch("HYBRID"),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).catch(25),
  source: z.enum(["USDA_FDC", "OPEN_FOOD_FACTS", "WIKIDATA", "MANUAL"]).optional().catch(undefined),
  dataType: z.string().max(60).optional().catch(undefined),
  categoryId: uuidSchema.optional().catch(undefined),
  verified: z.enum(["true", "false"]).optional().catch(undefined),
  sort: z.enum(["relevance", "name", "updated", "energy"]).catch("relevance"),
});

export interface LocalHit {
  origin: "LOCAL";
  id: string;
  source: string;
  sourceId: string;
  dataType: string | null;
  name: string;
  nameAr: string | null;
  brand: string | null;
  barcode: string | null;
  category: string | null;
  categoryAr: string | null;
  energyKcal: string | null;
  verified: boolean;
  stale: boolean;
}
export interface ExternalHit {
  origin: "USDA";
  fdcId: string;
  dataType: string | null;
  name: string;
  brand: string | null;
  barcode: string | null;
  category: string | null;
  publicationDate: string | null;
  energyKcal: string | null;
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

// Short-lived cache of USDA search answers (per query and page) to spare the hourly budget.
const searchCache = new Map<string, { at: number; value: { total: number; foods: unknown[] } }>();
const CACHE_MS = 10 * 60_000;
async function cachedUsdaSearch(
  query: string,
  page: number,
  pageSize: number,
  dataTypes?: string[],
) {
  const key = JSON.stringify([query.toLowerCase(), page, pageSize, dataTypes ?? []]);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await usdaProvider().search({ query, pageNumber: page, pageSize, dataTypes });
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(key, { at: Date.now(), value });
  return value;
}
export const clearUsdaSearchCache = () => searchCache.clear();

async function refreshDaysInTx(tx: Tx, org: string) {
  return (
    (await tx.nutritionSettings.findUnique({ where: { organizationId: org } }))?.refreshDays ?? 90
  );
}

/**
 * Search foods. LOCAL reads the organization's library (names, Arabic names,
 * brands and aliases by similarity; FDC ids and barcodes exactly). USDA asks
 * FoodData Central. HYBRID (default) gives the library's matches first, then
 * USDA's — leaving out any already in the library, so nothing appears twice.
 * When USDA cannot be asked, the library's results still come back, with why.
 */
export async function searchFoods(ctx: TenantContext, raw: Record<string, unknown>) {
  view(ctx);
  const p = searchSchema.parse(raw);
  const org = ctx.organizationId;
  const local =
    p.mode === "USDA"
      ? { total: 0, items: [] as LocalHit[] }
      : await withTenantTx(org, async (tx) => {
          const refreshDays = await refreshDaysInTx(tx, org);
          const q = p.q;
          const where = Prisma.sql`f."organization_id" = ${org}::uuid AND f."archived_at" IS NULL
            ${
              q
                ? Prisma.sql`AND (f."name" ILIKE ${like(q)} OR f."name_ar" ILIKE ${like(q)} OR f."brand" ILIKE ${like(q)}
              OR f."name" % ${q} OR f."barcode" = ${q} OR f."source_id" = ${q}
              OR EXISTS (SELECT 1 FROM "food_aliases" a WHERE a."food_id" = f."id" AND a."name" ILIKE ${like(q)})
              OR EXISTS (SELECT 1 FROM "food_identifiers" i WHERE i."food_id" = f."id" AND i."value" = ${q}))`
                : Prisma.empty
            }
            ${p.source ? Prisma.sql`AND f."source" = ${p.source}::"ReferenceSource"` : Prisma.empty}
            ${p.dataType ? Prisma.sql`AND f."data_type" = ${p.dataType}` : Prisma.empty}
            ${p.categoryId ? Prisma.sql`AND f."category_id" = ${p.categoryId}::uuid` : Prisma.empty}
            ${p.verified === "true" ? Prisma.sql`AND f."verified_at" IS NOT NULL` : p.verified === "false" ? Prisma.sql`AND f."verified_at" IS NULL` : Prisma.empty}`;
          const order =
            p.sort === "name"
              ? Prisma.sql`f."name" ASC`
              : p.sort === "updated"
                ? Prisma.sql`f."updated_at" DESC`
                : p.sort === "energy"
                  ? Prisma.sql`f."energy_kcal" DESC NULLS LAST, f."name" ASC`
                  : q
                    ? Prisma.sql`(f."barcode" = ${q} OR f."source_id" = ${q}) DESC,
                        GREATEST(similarity(f."name", ${q}), similarity(COALESCE(f."name_ar", ''), ${q})) DESC, f."name" ASC`
                    : Prisma.sql`f."name" ASC`;
          const [count] = await tx.$queryRaw<
            Array<{ n: bigint }>
          >`SELECT count(*) AS n FROM "reference_foods" f WHERE ${where}`;
          const rows = await tx.$queryRaw<
            Array<{
              id: string;
              source: string;
              source_id: string;
              data_type: string | null;
              name: string;
              name_ar: string | null;
              brand: string | null;
              barcode: string | null;
              category: string | null;
              category_ar: string | null;
              energy_kcal: Prisma.Decimal | null;
              verified_at: Date | null;
              last_fetched_at: Date | null;
            }>
          >`SELECT f."id", f."source"::text AS source, f."source_id", f."data_type", f."name", f."name_ar", f."brand",
              f."barcode", c."name" AS category, c."name_ar" AS category_ar, f."energy_kcal", f."verified_at", f."last_fetched_at"
            FROM "reference_foods" f LEFT JOIN "food_categories" c ON c."id" = f."category_id"
            WHERE ${where} ORDER BY ${order}
            LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`;
          const staleBefore = Date.now() - refreshDays * 86_400_000;
          return {
            total: Number(count.n),
            items: rows.map((r): LocalHit => ({
              origin: "LOCAL",
              id: r.id,
              source: r.source,
              sourceId: r.source_id,
              dataType: r.data_type,
              name: r.name,
              nameAr: r.name_ar,
              brand: r.brand,
              barcode: r.barcode,
              category: r.category,
              categoryAr: r.category_ar,
              energyKcal: r.energy_kcal?.toString() ?? null,
              verified: r.verified_at !== null,
              stale:
                r.source === "USDA_FDC" &&
                (!r.last_fetched_at || r.last_fetched_at.getTime() < staleBefore),
            })),
          };
        });
  let external: {
    status: "OK" | "NOT_CONFIGURED" | "UNAVAILABLE" | "RATE_LIMITED" | "SKIPPED";
    total: number;
    items: ExternalHit[];
    message?: string;
  } = { status: "SKIPPED", total: 0, items: [] };
  if (p.mode !== "LOCAL" && p.q) {
    if (!usdaProvider().configured()) external = { status: "NOT_CONFIGURED", total: 0, items: [] };
    else
      try {
        const r = await cachedUsdaSearch(
          p.q,
          p.page,
          p.pageSize,
          p.dataType ? [p.dataType] : undefined,
        );
        const normalized = r.foods.map(normalizeFdcFood).filter((f): f is NormalizedFood => !!f);
        const imported = new Set(
          (
            await withTenantTx(org, (tx) =>
              tx.referenceFood.findMany({
                where: {
                  organizationId: org,
                  source: "USDA_FDC",
                  sourceId: { in: normalized.map((f) => f.sourceId) },
                },
                select: { sourceId: true },
              }),
            )
          ).map((f) => f.sourceId),
        );
        external = {
          status: "OK",
          total: r.total,
          items: normalized
            .filter((f) => p.mode === "USDA" || !imported.has(f.sourceId))
            .map((f) => ({
              origin: "USDA",
              fdcId: f.sourceId,
              dataType: f.dataType,
              name: f.name,
              brand: f.brand,
              barcode: f.barcode,
              category: f.category,
              publicationDate: f.publicationDate,
              energyKcal: f.summary.values.energyKcal ?? null,
            })),
        };
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : "UNAVAILABLE";
        external = {
          status:
            code === "NOT_CONFIGURED"
              ? "NOT_CONFIGURED"
              : code === "RATE_LIMITED"
                ? "RATE_LIMITED"
                : "UNAVAILABLE",
          total: 0,
          items: [],
          message: (error as Error).message,
        };
      }
  }
  return {
    mode: p.mode,
    query: p.q,
    page: p.page,
    pageSize: p.pageSize,
    local: { total: local.total, items: local.items },
    external,
  };
}

// ─── Import and refresh ───

const fdcIds = z
  .array(
    z
      .string()
      .regex(/^\d{1,10}$/, { error: "invalid" })
      .or(z.number().int().positive().transform(String)),
  )
  .min(1)
  .max(100);

/**
 * Bring USDA records into the library (by FDC id), 20 per request. Each
 * record is stored in its own transaction; one that fails leaves the others
 * and the library as they were.
 */
export async function importUsdaFoods(
  ctx: TenantContext,
  rawIds: unknown,
  opts: { syncJobId?: string | null } = {},
) {
  manage(ctx);
  const parsed = fdcIds.safeParse(rawIds);
  if (!parsed.success) throw validationFailed(parsed.error);
  const ids = [...new Set(parsed.data)];
  const out = {
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: [] as Array<{ ref: string; message: string }>,
    foods: [] as ApplyResult[],
  };
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    let payloads: unknown[];
    try {
      payloads = await usdaProvider().foods(batch);
    } catch (error) {
      for (const id of batch) out.failed.push({ ref: id, message: (error as Error).message });
      if (
        error instanceof ProviderError &&
        (error.code === "NOT_CONFIGURED" || error.code === "RATE_LIMITED")
      )
        break;
      continue;
    }
    const got = new Set<string>();
    for (const raw of payloads) {
      const id = String((raw as { fdcId?: unknown })?.fdcId ?? "");
      try {
        const r = await applyFdcPayload(ctx, raw, { via: "API", syncJobId: opts.syncJobId });
        got.add(id);
        out[r.result]++;
        out.foods.push(r);
      } catch (error) {
        out.failed.push({ ref: id || "?", message: (error as Error).message });
      }
    }
    for (const id of batch)
      if (!got.has(id) && !out.failed.some((f) => f.ref === id))
        out.failed.push({ ref: id, message: "Not found in USDA FoodData Central" });
  }
  await withTenantTx(ctx.organizationId, (tx) =>
    recordAudit(tx, actorOf(ctx), {
      action: "nutrition.foods_imported",
      entityType: "organization",
      entityId: ctx.organizationId,
      changes: {
        requested: ids.length,
        created: out.created,
        updated: out.updated,
        unchanged: out.unchanged,
        failed: out.failed.length,
      },
    }),
  );
  return out;
}

/** Fetch one USDA record again now. */
export async function refreshFood(ctx: TenantContext, foodId: string) {
  manage(ctx);
  const food = await loadFood(ctx, foodId);
  if (food.source !== "USDA_FDC")
    throw businessRuleViolation(
      "FOOD_NOT_REFRESHABLE",
      "Only USDA records are refreshed from their source",
    );
  const raw = await usdaProvider().food(food.sourceId);
  const r = await applyFdcPayload(ctx, raw, { via: "API" });
  await withTenantTx(ctx.organizationId, (tx) =>
    recordAudit(tx, actorOf(ctx), {
      action: "nutrition.food_refreshed",
      entityType: "reference_food",
      entityId: food.id,
      changes: { result: r.result },
    }),
  );
  return r;
}

// ─── Reading a food ───

async function loadFood(ctx: TenantContext, foodId: string) {
  const id = uuidSchema.safeParse(foodId);
  if (!id.success) throw notFound("Food");
  const f = await withTenantTx(ctx.organizationId, (tx) =>
    tx.referenceFood.findFirst({ where: { organizationId: ctx.organizationId, id: id.data } }),
  );
  if (!f) throw notFound("Food");
  return f;
}

/** Every dictionary nutrient this organization sees, in display order. */
export async function listNutrients(ctx: TenantContext, raw: Record<string, unknown> = {}) {
  view(ctx);
  const q = z
    .string()
    .trim()
    .max(80)
    .catch("")
    .parse(raw.q ?? "");
  const group = z.string().max(20).optional().catch(undefined).parse(raw.group);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.nutrient.findMany({
      where: {
        ...(group ? { group: group as never } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { nameAr: { contains: q } },
                { code: { contains: q.toLowerCase() } },
                { usdaNumber: q },
                ...(/^\d{1,6}$/.test(q) ? [{ usdaNutrientId: Number(q) }] : []),
              ],
            }
          : {}),
      },
      orderBy: [{ rank: "asc" }, { name: "asc" }],
      include: { _count: { select: { values: true } } },
    });
    return rows.map(({ _count, ...n }) => ({
      ...n,
      custom: n.organizationId !== null,
      mapped: n.code !== null,
      valueCount: _count.values,
    }));
  });
}

export async function getFood(ctx: TenantContext, foodId: string, opts: { lang?: string } = {}) {
  view(ctx);
  const food = await loadFood(ctx, foodId);
  const ar = opts.lang === "ar";
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [
      category,
      values,
      portions,
      identifiers,
      aliases,
      versions,
      issues,
      dictionary,
      linked,
      refreshDays,
    ] = await Promise.all([
      food.categoryId ? tx.foodCategory.findUnique({ where: { id: food.categoryId } }) : null,
      tx.foodNutrientValue.findMany({
        where: { organizationId: ctx.organizationId, foodId: food.id },
        include: { nutrient: true },
      }),
      tx.foodPortion.findMany({
        where: { organizationId: ctx.organizationId, foodId: food.id },
        orderBy: { sequence: "asc" },
      }),
      tx.foodIdentifier.findMany({
        where: { organizationId: ctx.organizationId, foodId: food.id },
        orderBy: { kind: "asc" },
      }),
      tx.foodAlias.findMany({
        where: { organizationId: ctx.organizationId, foodId: food.id },
        orderBy: { name: "asc" },
      }),
      tx.foodSourceVersion.findMany({
        where: { organizationId: ctx.organizationId, foodId: food.id },
        orderBy: { fetchedAt: "desc" },
        select: {
          id: true,
          fetchedAt: true,
          payloadHash: true,
          via: true,
          dataType: true,
          publicationDate: true,
          syncJobId: true,
        },
      }),
      tx.foodDataIssue.findMany({
        where: { organizationId: ctx.organizationId, foodId: food.id },
        orderBy: { createdAt: "desc" },
      }),
      tx.nutrient.findMany({ where: { isCore: true }, orderBy: { rank: "asc" } }),
      food.linkedProductId
        ? tx.product.findUnique({
            where: { id: food.linkedProductId },
            select: { id: true, sku: true, nameEn: true, nameAr: true },
          })
        : null,
      refreshDaysInTx(tx, ctx.organizationId),
    ]);
    const rows = values
      .map((v) => ({
        nutrientId: v.nutrientId,
        code: v.nutrient.code,
        name: v.nutrient.name,
        nameAr: v.nutrient.nameAr,
        displayName: ar && v.nutrient.nameAr ? v.nutrient.nameAr : v.nutrient.name,
        group: v.nutrient.group,
        rank: v.nutrient.rank,
        isCore: v.nutrient.isCore,
        status: v.status as string,
        amount: v.amount?.toString() ?? null,
        unit: v.unit,
        originalAmount: v.originalAmount?.toString() ?? null,
        originalUnit: v.originalUnit,
        sourceNutrientId: v.sourceNutrientId,
        sourceNumber: v.sourceNumber,
        derivationCode: v.derivationCode,
        derivationDescription: v.derivationDescription,
        dataPoints: v.dataPoints,
        note: v.note,
        versionId: v.versionId,
      }))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    // Label nutrients the source does not give are listed as missing — never as zero.
    const present = new Set(rows.map((r) => r.nutrientId));
    const missing = dictionary
      .filter((d) => !present.has(d.id))
      .map((d) => ({
        code: d.code,
        name: d.name,
        nameAr: d.nameAr,
        displayName: ar && d.nameAr ? d.nameAr : d.name,
        unit: d.unit,
        status: "MISSING" as const,
      }));
    const stale =
      food.source === "USDA_FDC" &&
      (!food.lastFetchedAt || food.lastFetchedAt.getTime() < Date.now() - refreshDays * 86_400_000);
    return {
      food: {
        ...food,
        displayName: ar && food.nameAr ? food.nameAr : food.name,
        category: category
          ? { id: category.id, name: category.name, nameAr: category.nameAr }
          : null,
        verified: food.verifiedAt !== null,
        stale,
      },
      nutrients: rows,
      missingCore: missing,
      portions: portions.map((p) => ({
        ...p,
        amount: p.amount?.toString() ?? null,
        gramWeight: p.gramWeight?.toString() ?? null,
        millilitres: p.millilitres?.toString() ?? null,
        displayDescription: ar && p.descriptionAr ? p.descriptionAr : p.description,
      })),
      identifiers,
      aliases,
      versions,
      issues,
      linkedProduct: linked,
    };
  });
}

/** Load what calculations need: values per 100 by code and portions. */
async function calcInputInTx(tx: Tx, ctx: TenantContext, foodIds: string[]) {
  const foods = await tx.referenceFood.findMany({
    where: { organizationId: ctx.organizationId, id: { in: foodIds } },
    select: {
      id: true,
      name: true,
      nameAr: true,
      basis: true,
      source: true,
      sourceId: true,
      dataType: true,
    },
  });
  const [values, portions] = await Promise.all([
    tx.foodNutrientValue.findMany({
      where: { organizationId: ctx.organizationId, foodId: { in: foodIds } },
      include: { nutrient: { select: { code: true, id: true } } },
    }),
    tx.foodPortion.findMany({
      where: { organizationId: ctx.organizationId, foodId: { in: foodIds } },
    }),
  ]);
  return new Map(
    foods.map((f) => [
      f.id,
      {
        food: f,
        values: values
          .filter((v) => v.foodId === f.id)
          .map((v): ValueIn => ({
            code: v.nutrient.code ?? `usda:${v.sourceNutrientId ?? v.nutrient.id}`,
            unit: v.unit,
            amount: v.amount?.toString() ?? null,
            status: v.status,
          })),
        calc: {
          basis: (f.basis ?? "PER_100G") as "PER_100G" | "PER_100ML",
          portions: portions
            .filter((p) => p.foodId === f.id)
            .map((p) => ({
              id: p.id,
              gramWeight: p.gramWeight?.toString() ?? null,
              millilitres: p.millilitres?.toString() ?? null,
            })),
        },
      },
    ]),
  );
}

const itemSchema = z.object({
  foodId: uuidSchema,
  quantity: z.union([z.string(), z.number()]).transform(String),
  unit: z.enum(QUANTITY_UNITS).catch("g"),
  portionId: uuidSchema.optional(),
});

function calcError(error: unknown): never {
  if (error instanceof CalcError)
    throw businessRuleViolation(`NUTRITION_${error.code}`, error.message);
  throw error;
}

/** Nutrition of an amount of one food (default 100 g/ml of its basis). */
export async function foodNutrition(
  ctx: TenantContext,
  foodId: string,
  raw: Record<string, unknown> = {},
) {
  view(ctx);
  const food = await loadFood(ctx, foodId);
  const input = itemSchema.safeParse({
    foodId: food.id,
    quantity: raw.quantity ?? "100",
    unit: raw.unit ?? (food.basis === "PER_100ML" ? "ml" : "g"),
    portionId: raw.portionId,
  });
  if (!input.success) throw validationFailed(input.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const data = (await calcInputInTx(tx, ctx, [food.id])).get(food.id)!;
    let q;
    try {
      q = basisQuantity(
        data.calc,
        input.data.quantity,
        input.data.unit as QuantityUnit,
        input.data.portionId,
      );
    } catch (e) {
      calcError(e);
    }
    return {
      foodId: food.id,
      basis: data.calc.basis,
      quantity: input.data.quantity,
      unit: input.data.unit,
      basisQuantity: q.basis.toDecimalPlaces(4).toFixed(),
      grams: q.grams?.toDecimalPlaces(4).toFixed() ?? null,
      values: scale(data.values, q.basis),
    };
  });
}

const calcSchema = z.object({ items: z.array(itemSchema).min(1).max(100) });

/** Several foods at their quantities, each and in total. */
export async function calculateFoods(ctx: TenantContext, raw: unknown) {
  view(ctx);
  const parsed = calcSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const data = await calcInputInTx(
      tx,
      ctx,
      parsed.data.items.map((i) => i.foodId),
    );
    const ingredients = parsed.data.items.map((it, k) => {
      const d = data.get(it.foodId);
      if (!d) throw notFound("Food");
      let q;
      try {
        q = basisQuantity(d.calc, it.quantity, it.unit as QuantityUnit, it.portionId);
      } catch (e) {
        calcError(e);
      }
      return {
        ref: `${k}`,
        label: d.food.name,
        values: d.values,
        basisQty: q.basis,
        grams: q.grams,
      };
    });
    const codes = codesOf(ingredients);
    return {
      items: ingredients.map((i, k) => ({
        foodId: parsed.data.items[k].foodId,
        name: i.label,
        grams: i.grams?.toDecimalPlaces(4).toFixed() ?? null,
        values: scale(i.values, i.basisQty),
      })),
      total: analyzeRecipe({ ingredients, codes }).total,
    };
  });
}

function codesOf(ingredients: ReadonlyArray<{ values: readonly ValueIn[] }>) {
  const map = new Map<string, string>();
  for (const i of ingredients)
    for (const v of i.values) if (!map.has(v.code)) map.set(v.code, v.unit);
  return [...map.entries()].map(([code, unit]) => ({ code, unit }));
}

const compareSchema = z.object({
  foodIds: z.array(uuidSchema).min(2).max(10),
  quantity: z.union([z.string(), z.number()]).transform(String).optional(),
  unit: z.enum(QUANTITY_UNITS).optional(),
});

/** Foods side by side for the same quantity (default 100 of each basis). */
export async function compareFoods(ctx: TenantContext, raw: unknown) {
  view(ctx);
  const parsed = compareSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const results: Awaited<ReturnType<typeof foodNutrition>>[] = [];
  for (const id of parsed.data.foodIds)
    results.push(
      await foodNutrition(
        ctx,
        id,
        parsed.data.quantity ? { quantity: parsed.data.quantity, unit: parsed.data.unit } : {},
      ),
    );
  const codes = [...new Set(results.flatMap((r) => r.values.map((v) => v.code)))];
  return {
    foods: results.map((r) => ({
      foodId: r.foodId,
      basis: r.basis,
      quantity: r.quantity,
      unit: r.unit,
    })),
    rows: codes.map((code) => ({
      code,
      unit: results.flatMap((r) => r.values).find((v) => v.code === code)?.unit ?? null,
      values: results.map((r) => {
        const v = r.values.find((x) => x.code === code);
        return v ? { amount: v.amount, status: v.status } : { amount: null, status: "MISSING" };
      }),
    })),
  };
}

const recipeSchema = z.object({
  ingredients: z.array(itemSchema).min(1).max(200),
  servings: z.coerce.number().int().min(1).max(10000).optional(),
  finishedGrams: z
    .union([z.string(), z.number()])
    .transform(String)
    .refine((v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0, { error: "invalid" })
    .optional(),
});

/** A recipe given as library foods and quantities: totals, per serving and per 100 g finished. */
export async function analyzeFoodRecipe(ctx: TenantContext, raw: unknown) {
  view(ctx);
  const parsed = recipeSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const data = await calcInputInTx(
      tx,
      ctx,
      parsed.data.ingredients.map((i) => i.foodId),
    );
    const ingredients = parsed.data.ingredients.map((it, k) => {
      const d = data.get(it.foodId);
      if (!d) throw notFound("Food");
      let q;
      try {
        q = basisQuantity(d.calc, it.quantity, it.unit as QuantityUnit, it.portionId);
      } catch (e) {
        calcError(e);
      }
      return {
        ref: `${k}`,
        label: d.food.name,
        values: d.values,
        basisQty: q.basis,
        grams: q.grams,
        source: {
          foodId: d.food.id,
          source: d.food.source,
          sourceId: d.food.sourceId,
          dataType: d.food.dataType,
        },
      };
    });
    const result = analyzeRecipe({
      ingredients,
      codes: codesOf(ingredients),
      servings: parsed.data.servings ?? null,
      finishedGrams: parsed.data.finishedGrams ?? null,
    });
    return {
      ...result,
      ingredients: ingredients.map((i) => ({
        name: i.label,
        grams: i.grams?.toDecimalPlaces(4).toFixed() ?? null,
        source: i.source,
      })),
    };
  });
}

// ─── Barcode ───

/** A food by GTIN/UPC: the library first (leading zeros ignored), then USDA Branded. */
export async function findByBarcode(ctx: TenantContext, code: string) {
  view(ctx);
  const digits = code.trim();
  if (!/^\d{6,14}$/.test(digits))
    throw businessRuleViolation("BARCODE_INVALID", "A barcode is 6 to 14 digits");
  const bare = digits.replace(/^0+/, "");
  const local = await withTenantTx(
    ctx.organizationId,
    (tx) =>
      tx.$queryRaw<Array<{ id: string; name: string; brand: string | null; source: string }>>`
      SELECT f."id", f."name", f."brand", f."source"::text AS source FROM "reference_foods" f
      WHERE f."organization_id" = ${ctx.organizationId}::uuid AND f."archived_at" IS NULL
        AND (ltrim(f."barcode", '0') = ${bare}
          OR EXISTS (SELECT 1 FROM "food_identifiers" i WHERE i."food_id" = f."id"
            AND i."kind" IN ('GTIN_UPC', 'OFF_CODE') AND ltrim(i."value", '0') = ${bare}))
      ORDER BY f."verified_at" DESC NULLS LAST, f."name" LIMIT 10`,
  );
  if (local.length)
    return { barcode: digits, local, external: { status: "SKIPPED" as const, items: [] } };
  const r = await searchFoods(ctx, { q: digits, mode: "USDA", dataType: "Branded", pageSize: 5 });
  return {
    barcode: digits,
    local: [],
    external: {
      ...r.external,
      items: r.external.items.filter((i) => i.barcode?.replace(/^0+/, "") === bare),
    },
  };
}

// ─── Entering and editing foods ───

const valueEntry = z.union([
  z.literal("NA"),
  z
    .union([z.string(), z.number()])
    .transform(String)
    .refine((v) => /^\d+(\.\d+)?$/.test(v), { error: "invalid" }),
]);

const createSchema = z.object({
  name: z.string().trim().min(1).max(300),
  nameAr: z.string().trim().max(300).optional(),
  brand: z.string().trim().max(200).optional(),
  barcode: z
    .string()
    .trim()
    .regex(/^\d{6,14}$/, { error: "invalid" })
    .optional(),
  categoryId: uuidSchema.optional(),
  basis: z.enum(["PER_100G", "PER_100ML"]).default("PER_100G"),
  ingredientsText: z.string().trim().max(5000).optional(),
  reference: z.string().trim().max(300).optional(),
  /** By dictionary code: an amount per 100 in the nutrient's unit, or "NA" for not applicable. */
  values: z.record(z.string().max(60), valueEntry).default({}),
});

/** The ten summary columns from values by code (sodium kept in g there, ADR-041). */
function summaryFrom(values: Map<string, Decimal>) {
  const g = (c: string) => values.get(c)?.toFixed() ?? null;
  return {
    energyKcal: g("energy_kcal"),
    energyKj: g("energy_kj"),
    fat: g("fat"),
    saturatedFat: g("saturated_fat"),
    carbohydrate: g("carbohydrate"),
    sugars: g("sugars"),
    fibre: g("fibre"),
    protein: g("protein"),
    salt: g("salt"),
    sodium: values.has("sodium") ? values.get("sodium")!.dividedBy(1000).toFixed() : null,
  };
}

/** An organization's own food (source MANUAL), e.g. from a verified packaging label. */
export async function createFood(ctx: TenantContext, raw: unknown) {
  manage(ctx);
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const dictionary = await tx.nutrient.findMany({
      where: { code: { in: Object.keys(v.values) } },
    });
    const unknownCodes = Object.keys(v.values).filter((c) => !dictionary.some((d) => d.code === c));
    if (unknownCodes.length)
      throw businessRuleViolation("NUTRIENT_UNKNOWN", "Unknown nutrient codes", {
        codes: unknownCodes.join(","),
      });
    if (
      v.categoryId &&
      !(await tx.foodCategory.findFirst({
        where: { organizationId: ctx.organizationId, id: v.categoryId },
      }))
    )
      throw notFound("Category");
    const numbers = new Map(
      Object.entries(v.values)
        .filter(([, x]) => x !== "NA")
        .map(([c, x]) => [c, new Decimal(x)]),
    );
    for (const [c, x] of numbers)
      if (dictionary.find((d) => d.code === c)?.unit === "g" && x.gt(100))
        throw businessRuleViolation("NUTRIENT_IMPLAUSIBLE", "A value per 100 cannot exceed 100 g", {
          code: c,
        });
    const sourceId = `M-${crypto.randomUUID().slice(0, 13)}`;
    const food = await tx.referenceFood.create({
      data: {
        organizationId: ctx.organizationId,
        source: "MANUAL",
        sourceId,
        dataType: "Manual",
        name: v.name,
        nameAr: v.nameAr || null,
        brand: v.brand || null,
        barcode: v.barcode || null,
        categoryId: v.categoryId ?? null,
        basis: v.basis,
        ingredientsText: v.ingredientsText || null,
        ...summaryFrom(numbers),
        notes: v.reference ? [`reference: ${v.reference}`] : [],
        licence: "The organization's own data",
        attribution: ctx.organizationName,
        sourceUrl: "",
      },
    });
    if (Object.keys(v.values).length)
      await tx.foodNutrientValue.createMany({
        data: Object.entries(v.values).map(([code, x]) => {
          const d = dictionary.find((n) => n.code === code)!;
          return {
            organizationId: ctx.organizationId,
            foodId: food.id,
            nutrientId: d.id,
            status: x === "NA" ? ("NOT_APPLICABLE" as const) : ("REPORTED" as const),
            originalAmount: x === "NA" ? null : x,
            originalUnit: x === "NA" ? null : d.unit,
            amount: x === "NA" ? null : x,
            unit: d.unit,
            note: "entered by hand",
          };
        }),
      });
    if (v.barcode)
      await tx.foodIdentifier.create({
        data: {
          organizationId: ctx.organizationId,
          foodId: food.id,
          kind: "GTIN_UPC",
          value: v.barcode,
        },
      });
    await recordAudit(tx, actorOf(ctx), {
      action: "nutrition.food_created",
      entityType: "reference_food",
      entityId: food.id,
      changes: { name: v.name, values: Object.keys(v.values).length },
    });
    return food;
  });
}

const patchSchema = z
  .object({
    nameAr: z.string().trim().max(300).nullable().optional(),
    categoryId: uuidSchema.nullable().optional(),
    addAliases: z
      .array(z.object({ name: z.string().trim().min(1).max(300), locale: z.enum(["en", "ar"]) }))
      .max(20)
      .optional(),
    removeAliasIds: z.array(uuidSchema).max(20).optional(),
    verified: z.boolean().optional(),
    archived: z.boolean().optional(),
    archiveReason: z.string().trim().max(300).optional(),
    /** By code: "NA" marks a nutrient not applicable; null clears that mark. */
    notApplicable: z.record(z.string().max(60), z.boolean()).optional(),
  })
  .refine((p) => !p.archived || p.archiveReason, { error: "required", path: ["archiveReason"] });

/**
 * Edit what a person may change about a food: its Arabic name, category,
 * aliases, verification and archiving, and nutrients marked not
 * applicable. Values published by a source are never edited here — a
 * product's own figures go on its nutrition profile (ADR-040).
 */
export async function updateFood(ctx: TenantContext, foodId: string, raw: unknown) {
  manage(ctx);
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  const food = await loadFood(ctx, foodId);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const data: Prisma.ReferenceFoodUncheckedUpdateInput = {};
    if (v.nameAr !== undefined) data.nameAr = v.nameAr || null;
    if (v.categoryId !== undefined) {
      if (
        v.categoryId &&
        !(await tx.foodCategory.findFirst({
          where: { organizationId: ctx.organizationId, id: v.categoryId },
        }))
      )
        throw notFound("Category");
      data.categoryId = v.categoryId;
    }
    if (v.verified !== undefined) {
      if (v.verified && food.verifiedAt) throw conflict("Already verified");
      data.verifiedAt = v.verified ? new Date() : null;
      data.verifiedByUserId = v.verified ? ctx.userId : null;
    }
    if (v.archived !== undefined) {
      data.archivedAt = v.archived ? new Date() : null;
      data.archiveReason = v.archived ? v.archiveReason : null;
    }
    if (Object.keys(data).length) await tx.referenceFood.update({ where: { id: food.id }, data });
    if (v.addAliases?.length)
      await tx.foodAlias.createMany({
        data: v.addAliases.map((a) => ({
          organizationId: ctx.organizationId,
          foodId: food.id,
          ...a,
        })),
        skipDuplicates: true,
      });
    if (v.removeAliasIds?.length)
      await tx.foodAlias.deleteMany({
        where: {
          organizationId: ctx.organizationId,
          foodId: food.id,
          id: { in: v.removeAliasIds },
        },
      });
    if (v.notApplicable) {
      const dict = await tx.nutrient.findMany({
        where: { code: { in: Object.keys(v.notApplicable) } },
      });
      for (const [code, on] of Object.entries(v.notApplicable)) {
        const d = dict.find((x) => x.code === code);
        if (!d)
          throw businessRuleViolation("NUTRIENT_UNKNOWN", "Unknown nutrient code", { codes: code });
        const current = await tx.foodNutrientValue.findUnique({
          where: {
            organizationId_foodId_nutrientId: {
              organizationId: ctx.organizationId,
              foodId: food.id,
              nutrientId: d.id,
            },
          },
        });
        if (on) {
          if (current && current.status !== "NOT_APPLICABLE")
            throw businessRuleViolation(
              "NUTRIENT_HAS_VALUE",
              "The source gives a value for this nutrient",
              { codes: code },
            );
          if (!current)
            await tx.foodNutrientValue.create({
              data: {
                organizationId: ctx.organizationId,
                foodId: food.id,
                nutrientId: d.id,
                status: "NOT_APPLICABLE",
                unit: d.unit,
                note: "marked by a person",
              },
            });
        } else if (current?.status === "NOT_APPLICABLE")
          await tx.foodNutrientValue.delete({ where: { id: current.id } });
      }
    }
    await recordAudit(tx, actorOf(ctx), {
      action: "nutrition.food_updated",
      entityType: "reference_food",
      entityId: food.id,
      changes: {
        ...(v.nameAr !== undefined ? { nameAr: v.nameAr } : {}),
        ...(v.verified !== undefined ? { verified: v.verified } : {}),
        ...(v.archived !== undefined
          ? { archived: v.archived, reason: v.archiveReason ?? null }
          : {}),
        aliases: (v.addAliases?.length ?? 0) - (v.removeAliasIds?.length ?? 0),
      },
    });
    return { id: food.id };
  });
}

const portionSchema = z
  .object({
    description: z.string().trim().min(1).max(300),
    descriptionAr: z.string().trim().max(300).optional(),
    gramWeight: z.union([z.string(), z.number()]).transform(String).optional(),
    millilitres: z.union([z.string(), z.number()]).transform(String).optional(),
  })
  .refine((p) => p.gramWeight || p.millilitres, { error: "required", path: ["gramWeight"] })
  .refine(
    (p) =>
      [p.gramWeight, p.millilitres].every((x) => !x || (/^\d+(\.\d+)?$/.test(x) && Number(x) > 0)),
    {
      error: "invalid",
      path: ["gramWeight"],
    },
  );

export async function listPortions(ctx: TenantContext, foodId: string) {
  view(ctx);
  const food = await loadFood(ctx, foodId);
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.foodPortion.findMany({
      where: { organizationId: ctx.organizationId, foodId: food.id },
      orderBy: { sequence: "asc" },
    }),
  );
}

/** A serving a person adds (kept when the source record is refreshed). */
export async function addPortion(ctx: TenantContext, foodId: string, raw: unknown) {
  manage(ctx);
  const parsed = portionSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const food = await loadFood(ctx, foodId);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const last = await tx.foodPortion.aggregate({
      where: { organizationId: ctx.organizationId, foodId: food.id },
      _max: { sequence: true },
    });
    return tx.foodPortion.create({
      data: {
        organizationId: ctx.organizationId,
        foodId: food.id,
        sequence: (last._max.sequence ?? 0) + 1,
        description: parsed.data.description,
        descriptionAr: parsed.data.descriptionAr || null,
        gramWeight: parsed.data.gramWeight ?? null,
        millilitres: parsed.data.millilitres ?? null,
        manual: true,
        createdByUserId: ctx.userId,
      },
    });
  });
}

// ─── Reference lists ───

export async function listCategories(ctx: TenantContext) {
  view(ctx);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.foodCategory.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { name: "asc" },
      include: { _count: { select: { foods: { where: { archivedAt: null } } } } },
    });
    return rows.map(({ _count, ...c }) => ({ ...c, foods: _count.foods }));
  });
}

export async function setCategoryArabic(ctx: TenantContext, categoryId: string, raw: unknown) {
  manage(ctx);
  const parsed = z.object({ nameAr: z.string().trim().max(200) }).safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const id = uuidSchema.safeParse(categoryId);
  if (!id.success) throw notFound("Category");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.foodCategory.findFirst({
      where: { organizationId: ctx.organizationId, id: id.data },
    });
    if (!c) throw notFound("Category");
    return tx.foodCategory.update({
      where: { id: c.id },
      data: { nameAr: parsed.data.nameAr || null },
    });
  });
}

/** Sources with their record counts and priority. */
export async function listSources(ctx: TenantContext) {
  view(ctx);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [library, profiles] = await Promise.all([
      tx.$queryRaw<
        Array<{ source: string; data_type: string | null; n: bigint; verified: bigint }>
      >`
        SELECT "source"::text AS source, "data_type", count(*) AS n, count("verified_at") AS verified
        FROM "reference_foods" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "archived_at" IS NULL
        GROUP BY 1, 2 ORDER BY 1, 2`,
      tx.$queryRaw<Array<{ source: string; n: bigint; verified: bigint }>>`
        SELECT "source"::text AS source, count(*) AS n, count("verified_at") AS verified
        FROM "nutrition_profiles" WHERE "organization_id" = ${ctx.organizationId}::uuid AND "superseded_at" IS NULL
        GROUP BY 1 ORDER BY 1`,
    ]);
    return {
      priority: SOURCE_PRIORITY,
      library: library.map((r) => ({
        source: r.source,
        dataType: r.data_type,
        records: Number(r.n),
        verified: Number(r.verified),
      })),
      productProfiles: profiles.map((r) => ({
        source: r.source,
        profiles: Number(r.n),
        verified: Number(r.verified),
      })),
    };
  });
}

// ─── Custom nutrients ───

const customSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,59}$/, { error: "invalidCode" }),
  name: z.string().trim().min(1).max(200),
  nameAr: z.string().trim().max(200).optional(),
  unit: z.enum(["g", "mg", "µg", "kcal", "kJ", "IU"]),
  group: z
    .enum([
      "ENERGY",
      "PROXIMATES",
      "CARBOHYDRATES",
      "LIPIDS",
      "MINERALS",
      "VITAMINS",
      "AMINO_ACIDS",
      "OTHER",
    ])
    .default("OTHER"),
});

/** A nutrient the organization tracks that the shared dictionary does not have. */
export async function createCustomNutrient(ctx: TenantContext, raw: unknown) {
  manage(ctx);
  const parsed = customSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const clash = await tx.nutrient.findFirst({ where: { code: parsed.data.code } });
    if (clash) throw conflict("A nutrient with this code exists", { field: "code" });
    const n = await tx.nutrient.create({
      data: {
        organizationId: ctx.organizationId,
        ...parsed.data,
        nameAr: parsed.data.nameAr || null,
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "nutrition.nutrient_created",
      entityType: "nutrient",
      entityId: n.id,
      changes: { code: n.code, unit: n.unit },
    });
    return n;
  });
}
