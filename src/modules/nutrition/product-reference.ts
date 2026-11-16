import "server-only";
import { z } from "zod";
import { parseCsvRecords } from "@/lib/csv";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { setArabicNameIfEmptyInTx } from "@/modules/catalog/service";
import { uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { Prisma } from "@/generated/prisma/client";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { type AllergenCode } from "./allergens";
import { importUsdaFoods } from "./engine/foods";
import { importOpenFoodFacts, offEnabled } from "./engine/off";
import { usdaProvider } from "./engine/providers";
import {
  matchTerms,
  parseReference,
  referenceKey,
  type ReferenceSourceCode,
} from "./reference-match";
import { NUTRIENTS } from "./rules";
import { profileSchema } from "./service";

/**
 * Products and their generic library food (DECISIONS.md ADR-136). A product
 * points at one library food (many products may share it); that food's full
 * nutrient set feeds recipe panels, and its label values can be copied to the
 * product's profile. A supplier specification or lab profile always wins:
 * a database record never replaces it.
 */

type Food = NonNullable<Awaited<ReturnType<Tx["referenceFood"]["findFirst"]>>>;

export interface ApplyOptions {
  /** Make the record the product's nutrition reference. */
  reference: boolean;
  /** Copy its label values as an unverified DATABASE profile (implies reference). */
  nutrition: boolean;
  /** Copy listed allergens as CONTAINS / MAY_CONTAIN where nothing is known. */
  allergens: boolean;
  /** Fill in a missing Arabic name. */
  arabicName: boolean;
}

export interface ApplyResult {
  reference: boolean;
  nutrition: boolean;
  /** Why the label values were not copied (bulk links only; a single link reports an error). */
  nutritionSkipped: null | "NO_VALUES" | "IMPLAUSIBLE" | "SPEC_KEPT";
  allergens: string[];
  conflicts: string[];
  arabicName: boolean;
}

const referenceLabel = (food: Food) =>
  `${
    food.source === "USDA_FDC"
      ? "USDA FDC"
      : food.source === "OPEN_FOOD_FACTS"
        ? "Open Food Facts"
        : food.source === "MANUAL"
          ? "Library entry"
          : "Wikidata"
  } ${food.sourceId}${food.dataType ? ` (${food.dataType})` : ""}`;

/**
 * A DATABASE profile copied from another library record no longer matches the
 * product's reference: it is superseded, so a label never shows one food's
 * values under another's name. Profiles entered by people are kept.
 */
async function dropStaleCopyInTx(
  tx: Tx,
  ctx: TenantContext,
  productId: string,
  keepFoodId: string | null,
) {
  const current = await tx.nutritionProfile.findFirst({
    where: { organizationId: ctx.organizationId, productId, supersededAt: null },
  });
  if (
    current &&
    current.source === "DATABASE" &&
    current.referenceFoodId &&
    current.referenceFoodId !== keepFoodId
  )
    await tx.nutritionProfile.update({
      where: { id: current.id },
      data: { supersededAt: new Date() },
    });
}

/**
 * Apply a library record to a product, in the caller's transaction. Strict
 * (one product, a person choosing): a problem with the values is an error.
 * Lenient (uploads and bulk confirmation): the link is made and the reason the
 * values were not copied is reported.
 */
export async function applyReferenceInTx(
  tx: Tx,
  ctx: TenantContext,
  food: Food,
  productId: string,
  opts: ApplyOptions,
  mode: "strict" | "lenient",
): Promise<ApplyResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`nutrition:${ctx.organizationId}:${productId}`}))`;
  const reference = referenceLabel(food);
  const linking = opts.reference || opts.nutrition;
  const result: ApplyResult = {
    reference: false,
    nutrition: false,
    nutritionSkipped: null,
    allergens: [],
    conflicts: [],
    arabicName: false,
  };
  if (linking && food.archivedAt)
    throw businessRuleViolation("REFERENCE_ARCHIVED", "The library record is archived");

  if (opts.nutrition) {
    const values = Object.fromEntries(
      NUTRIENTS.map((n) => [n, food[n] === null ? undefined : food[n]!.toString()]),
    );
    const current = await tx.nutritionProfile.findFirst({
      where: { organizationId: ctx.organizationId, productId, supersededAt: null },
    });
    const check =
      food.basis && !Object.values(values).every((v) => v === undefined)
        ? profileSchema.safeParse({ basis: food.basis, source: "DATABASE", reference, ...values })
        : null;
    let skip: ApplyResult["nutritionSkipped"] = null;
    if (!check) skip = "NO_VALUES";
    else if (!check.success) skip = "IMPLAUSIBLE";
    else if (current && (current.source === "SUPPLIER_SPEC" || current.source === "LAB"))
      skip = "SPEC_KEPT";
    if (skip && mode === "strict") {
      if (skip === "NO_VALUES")
        throw businessRuleViolation(
          "REFERENCE_HAS_NO_VALUES",
          "The record has no nutrition values",
        );
      if (skip === "IMPLAUSIBLE")
        throw businessRuleViolation(
          "REFERENCE_VALUES_IMPLAUSIBLE",
          "The record's values fail the plausibility checks; enter them by hand",
          {
            detail: check!.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
          },
        );
      throw businessRuleViolation(
        "REFERENCE_WOULD_REPLACE_SPEC",
        "The product has values from a specification or lab; a database record does not replace them",
      );
    }
    if (skip) result.nutritionSkipped = skip;
    else {
      if (current)
        await tx.nutritionProfile.update({
          where: { id: current.id },
          data: { supersededAt: new Date() },
        });
      await tx.nutritionProfile.create({
        data: {
          organizationId: ctx.organizationId,
          productId,
          basis: food.basis!,
          source: "DATABASE",
          reference,
          note: food.notes.length > 0 ? food.notes.join("; ").slice(0, 500) : null,
          referenceFoodId: food.id,
          createdByUserId: ctx.userId,
          ...Object.fromEntries(NUTRIENTS.map((n) => [n, food[n]])),
        },
      });
      result.nutrition = true;
    }
  }

  if (opts.allergens) {
    const current = await tx.allergenDeclaration.findMany({
      where: { organizationId: ctx.organizationId, productId, supersededAt: null },
    });
    const listed: Array<[AllergenCode, "CONTAINS" | "MAY_CONTAIN"]> = [
      ...food.allergens.map((c) => [c as AllergenCode, "CONTAINS"] as [AllergenCode, "CONTAINS"]),
      ...food.traces.map(
        (c) => [c as AllergenCode, "MAY_CONTAIN"] as [AllergenCode, "MAY_CONTAIN"],
      ),
    ];
    for (const [allergen, status] of listed) {
      const before = current.find((d) => d.allergen === allergen);
      if (before && before.status !== "UNKNOWN") {
        // A database never overrides a statement; a contradiction is for a person to resolve.
        if (
          before.status === "FREE_FROM" ||
          (before.status === "MAY_CONTAIN" && status === "CONTAINS")
        )
          result.conflicts.push(allergen);
        continue;
      }
      if (before)
        await tx.allergenDeclaration.update({
          where: { id: before.id },
          data: { supersededAt: new Date() },
        });
      await tx.allergenDeclaration.create({
        data: {
          organizationId: ctx.organizationId,
          productId,
          allergen,
          status,
          source: "DATABASE",
          reference,
          declaredByUserId: ctx.userId,
        },
      });
      result.allergens.push(allergen);
    }
  }

  if (opts.arabicName && food.nameAr)
    result.arabicName = await setArabicNameIfEmptyInTx(tx, ctx, productId, food.nameAr);

  if (linking) {
    await dropStaleCopyInTx(tx, ctx, productId, food.id);
    await tx.product.update({
      where: { id: productId },
      data: { referenceFoodId: food.id, updatedByUserId: ctx.userId },
    });
    result.reference = true;
  }
  await recordAudit(tx, actorOf(ctx), {
    action: "ingredient_library.linked",
    entityType: "product",
    entityId: productId,
    changes: { referenceFoodId: food.id, label: reference, ...result },
  });
  return result;
}

/** Remove a product's library reference; values copied from it are superseded. */
export async function unlinkProductReference(ctx: TenantContext, productId: string) {
  assertPermission(ctx.grants, "nutrition.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const product = await tx.product.findFirst({
      where: { organizationId: ctx.organizationId, id: productId },
      select: { id: true, referenceFoodId: true },
    });
    if (!product) throw notFound("Product");
    if (!product.referenceFoodId) return;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`nutrition:${ctx.organizationId}:${product.id}`}))`;
    await dropStaleCopyInTx(tx, ctx, product.id, null);
    await tx.product.update({
      where: { id: product.id },
      data: { referenceFoodId: null, updatedByUserId: ctx.userId },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "ingredient_library.unlinked",
      entityType: "product",
      entityId: product.id,
      changes: { referenceFoodId: product.referenceFoodId },
    });
  });
}

// ─── Reading ───

type Candidate = {
  id: string;
  source: string;
  sourceId: string;
  dataType: string | null;
  name: string;
  nameAr: string | null;
  energyKcal: string | null;
  nutrients: number;
  verified: boolean;
  /** EXACT: the product's barcode; else name similarity 0–1. */
  match: "BARCODE" | "NAME";
  score: number;
};

/**
 * Library foods that may be the product, best first: an exact barcode match,
 * then by how well the product's food words appear in the food's name,
 * Arabic name or aliases. Suggestions only; a person confirms.
 */
async function candidatesInTx(
  tx: Tx,
  ctx: TenantContext,
  product: { nameEn: string; nameAr: string | null; barcodes: string[] },
  limit = 3,
): Promise<Candidate[]> {
  const en = matchTerms(product.nameEn);
  const ar = product.nameAr ? matchTerms(product.nameAr) : "";
  if (!en && !ar && product.barcodes.length === 0) return [];
  await tx.$executeRaw`SET LOCAL pg_trgm.word_similarity_threshold = 0.5`;
  const barcodes = product.barcodes.length ? product.barcodes : ["-"];
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      source: string;
      source_id: string;
      data_type: string | null;
      name: string;
      name_ar: string | null;
      energy_kcal: Prisma.Decimal | null;
      verified: boolean;
      barcode_hit: boolean;
      score: number;
      nutrients: bigint;
    }>
  >`SELECT f."id", f."source"::text AS source, f."source_id", f."data_type", f."name", f."name_ar",
      f."energy_kcal", f."verified_at" IS NOT NULL AS verified,
      COALESCE(f."barcode" = ANY(${barcodes}::text[]), false) AS barcode_hit,
      GREATEST(
        ${en ? Prisma.sql`word_similarity(${en}, f."name")` : Prisma.sql`0`},
        ${ar ? Prisma.sql`word_similarity(${ar}, COALESCE(f."name_ar", ''))` : Prisma.sql`0`},
        COALESCE((SELECT max(word_similarity(${en || ar}, a."name")) FROM "food_aliases" a
          WHERE a."organization_id" = f."organization_id" AND a."food_id" = f."id"), 0)
      )::float8 AS score,
      (SELECT count(*) FROM "food_nutrient_values" v
        WHERE v."organization_id" = f."organization_id" AND v."food_id" = f."id") AS nutrients
    FROM "reference_foods" f
    WHERE f."organization_id" = ${ctx.organizationId}::uuid AND f."archived_at" IS NULL AND (
      f."barcode" = ANY(${barcodes}::text[])
      ${en ? Prisma.sql`OR ${en} <% f."name"` : Prisma.empty}
      ${ar ? Prisma.sql`OR ${ar} <% f."name_ar"` : Prisma.empty}
      ${
        en || ar
          ? Prisma.sql`OR EXISTS (SELECT 1 FROM "food_aliases" a WHERE a."organization_id" = f."organization_id"
              AND a."food_id" = f."id" AND ${en || ar} <% a."name")`
          : Prisma.empty
      })
    ORDER BY barcode_hit DESC, score DESC, verified DESC, nutrients DESC, f."name" ASC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    sourceId: r.source_id,
    dataType: r.data_type,
    name: r.name,
    nameAr: r.name_ar,
    energyKcal: r.energy_kcal?.toString() ?? null,
    nutrients: Number(r.nutrients),
    verified: r.verified,
    match: r.barcode_hit ? "BARCODE" : "NAME",
    score: r.barcode_hit ? 1 : Math.round(r.score * 100) / 100,
  }));
}

/**
 * A product's library reference with its core label values per 100 g/ml and
 * how many nutrients the full profile holds; with suggestions when unlinked.
 */
export async function productReference(ctx: TenantContext, productId: string) {
  assertPermission(ctx.grants, "nutrition.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const product = await tx.product.findFirst({
      where: { organizationId: ctx.organizationId, id: productId },
      select: {
        id: true,
        nameEn: true,
        nameAr: true,
        referenceFoodId: true,
        barcodes: { select: { barcode: true } },
      },
    });
    if (!product) throw notFound("Product");
    if (!product.referenceFoodId)
      return {
        food: null,
        core: [],
        suggestions: await candidatesInTx(tx, ctx, {
          nameEn: product.nameEn,
          nameAr: product.nameAr,
          barcodes: product.barcodes.map((b) => b.barcode),
        }),
      };
    const food = await tx.referenceFood.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, id: product.referenceFoodId },
      select: {
        id: true,
        source: true,
        sourceId: true,
        dataType: true,
        name: true,
        nameAr: true,
        basis: true,
        verifiedAt: true,
        archivedAt: true,
        _count: { select: { nutrientValues: true } },
      },
    });
    const core = await tx.foodNutrientValue.findMany({
      where: { organizationId: ctx.organizationId, foodId: food.id, nutrient: { isCore: true } },
      select: {
        amount: true,
        unit: true,
        status: true,
        nutrient: { select: { code: true, name: true, nameAr: true, rank: true } },
      },
    });
    core.sort((a, b) => a.nutrient.rank - b.nutrient.rank);
    return {
      food: {
        id: food.id,
        source: food.source,
        sourceId: food.sourceId,
        dataType: food.dataType,
        name: food.name,
        nameAr: food.nameAr,
        basis: food.basis,
        verified: food.verifiedAt !== null,
        archived: food.archivedAt !== null,
        nutrients: food._count.nutrientValues,
      },
      core: core.map((v) => ({
        code: v.nutrient.code,
        name: v.nutrient.name,
        nameAr: v.nutrient.nameAr,
        amount: v.amount?.toString() ?? null,
        unit: v.unit,
        status: v.status,
      })),
      suggestions: [] as Candidate[],
    };
  });
}

export const MATCH_PAGE_SIZE = 20;
const FOOD_TYPES = ["RAW_MATERIAL", "SEMI_FINISHED", "FINISHED_GOOD"] as const;

const matchFilterSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
  type: z.enum(["RAW_MATERIAL", "SEMI_FINISHED", "FINISHED_GOOD", "ALL"]).catch("ALL"),
  q: z.string().trim().max(100).optional().catch(undefined),
});

/** Coverage: active food products with and without a library reference. */
export async function referenceCoverage(ctx: TenantContext) {
  assertPermission(ctx.grants, "nutrition.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const where = {
      organizationId: ctx.organizationId,
      archivedAt: null,
      type: { in: [...FOOD_TYPES] },
    };
    const [linked, unlinked] = await Promise.all([
      tx.product.count({ where: { ...where, referenceFoodId: { not: null } } }),
      tx.product.count({ where: { ...where, referenceFoodId: null } }),
    ]);
    return { linked, unlinked };
  });
}

/**
 * Active food products without a library reference (packaging and
 * consumables left out), each with up to three suggested library foods.
 */
export async function unmatchedProducts(ctx: TenantContext, raw: Record<string, unknown> = {}) {
  assertPermission(ctx.grants, "nutrition.view");
  const f = matchFilterSchema.parse(raw);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const where: Prisma.ProductWhereInput = {
      organizationId: ctx.organizationId,
      archivedAt: null,
      referenceFoodId: null,
      type: f.type === "ALL" ? { in: [...FOOD_TYPES] } : f.type,
      ...(f.q
        ? {
            OR: [
              { sku: { contains: f.q, mode: "insensitive" } },
              { nameEn: { contains: f.q, mode: "insensitive" } },
              { nameAr: { contains: f.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const total = await tx.product.count({ where });
    const products = await tx.product.findMany({
      where,
      select: {
        id: true,
        sku: true,
        nameEn: true,
        nameAr: true,
        type: true,
        barcodes: { select: { barcode: true } },
      },
      orderBy: { sku: "asc" },
      skip: (f.page - 1) * MATCH_PAGE_SIZE,
      take: MATCH_PAGE_SIZE,
    });
    const items = [];
    for (const p of products)
      items.push({
        product: { id: p.id, sku: p.sku, nameEn: p.nameEn, nameAr: p.nameAr, type: p.type },
        candidates: await candidatesInTx(tx, ctx, {
          nameEn: p.nameEn,
          nameAr: p.nameAr,
          barcodes: p.barcodes.map((b) => b.barcode),
        }),
      });
    return {
      filter: f,
      total,
      page: f.page,
      pageCount: Math.max(1, Math.ceil(total / MATCH_PAGE_SIZE)),
      items,
    };
  });
}

const BULK_OPTIONS: ApplyOptions = {
  reference: true,
  nutrition: true,
  allergens: true,
  arabicName: true,
};

const confirmSchema = z
  .array(z.object({ productId: uuidSchema, foodId: uuidSchema }))
  .min(1)
  .max(100);

export interface BulkLinkResult {
  linked: number;
  /** Label values copied to the product's profile. */
  valuesCopied: number;
  /** Products whose specification or lab values were kept. */
  specKept: number;
  allergenConflicts: number;
}

function tally(results: ApplyResult[]): BulkLinkResult {
  return {
    linked: results.filter((r) => r.reference).length,
    valuesCopied: results.filter((r) => r.nutrition).length,
    specKept: results.filter((r) => r.nutritionSkipped === "SPEC_KEPT").length,
    allergenConflicts: results.filter((r) => r.conflicts.length > 0).length,
  };
}

/** Confirm suggested (or chosen) links, all in one transaction. */
export async function confirmReferenceLinks(ctx: TenantContext, raw: unknown) {
  assertPermission(ctx.grants, "nutrition.manage");
  const parsed = confirmSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const pairs = [...new Map(parsed.data.map((p) => [p.productId, p])).values()];
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [foods, products] = await Promise.all([
      tx.referenceFood.findMany({
        where: { organizationId: ctx.organizationId, id: { in: pairs.map((p) => p.foodId) } },
      }),
      tx.product.findMany({
        where: { organizationId: ctx.organizationId, id: { in: pairs.map((p) => p.productId) } },
        select: { id: true },
      }),
    ]);
    const foodOf = new Map(foods.map((f) => [f.id, f]));
    const known = new Set(products.map((p) => p.id));
    const results: ApplyResult[] = [];
    for (const p of pairs) {
      const food = foodOf.get(p.foodId);
      if (!food) throw notFound("Library record");
      if (!known.has(p.productId)) throw notFound("Product");
      results.push(await applyReferenceInTx(tx, ctx, food, p.productId, BULK_OPTIONS, "lenient"));
    }
    return tally(results);
  });
}

// ─── Uploads ───

export interface RefRowError {
  row: number;
  column: string;
  message: string;
}

/** Most records fetched from USDA or Open Food Facts for one upload. */
export const MAX_FETCH_PER_UPLOAD = 200;

/**
 * Find the library food for each reference; a USDA or Open Food Facts record
 * not in the library yet is fetched first (when its lookup is set up). Runs
 * before the upload's transaction: fetched records stay in the library even
 * if the upload is refused — they are copies of public data, not changes.
 */
export async function resolveReferences(
  ctx: TenantContext,
  refs: Array<{ source: ReferenceSourceCode; sourceId: string }>,
): Promise<Map<string, string>> {
  const unique = [...new Map(refs.map((r) => [referenceKey(r), r])).values()];
  const find = () =>
    withTenantTx(ctx.organizationId, (tx) =>
      tx.referenceFood.findMany({
        where: {
          organizationId: ctx.organizationId,
          archivedAt: null,
          OR: unique.map((r) => ({ source: r.source, sourceId: r.sourceId })),
        },
        select: { id: true, source: true, sourceId: true },
      }),
    );
  if (unique.length === 0) return new Map();
  let found = await find();
  const have = new Set(found.map((f) => referenceKey(f)));
  const missing = unique.filter((r) => !have.has(referenceKey(r))).slice(0, MAX_FETCH_PER_UPLOAD);
  const usda = missing.filter((r) => r.source === "USDA_FDC").map((r) => r.sourceId);
  const off = missing.filter((r) => r.source === "OPEN_FOOD_FACTS").map((r) => r.sourceId);
  let fetched = false;
  if (usda.length && hasPermission(ctx.grants, "nutrition.manage") && usdaProvider().configured()) {
    for (let i = 0; i < usda.length; i += 100) await importUsdaFoods(ctx, usda.slice(i, i + 100));
    fetched = true;
  }
  if (off.length && hasPermission(ctx.grants, "nutrition.manage") && offEnabled()) {
    for (const code of off.slice(0, 20))
      try {
        await importOpenFoodFacts(ctx, code);
      } catch {
        // Not found or unavailable: reported as not in the library.
      }
    fetched = true;
  }
  if (fetched) found = await find();
  return new Map(found.map((f) => [referenceKey(f), f.id]));
}

/** Read the reference columns of upload rows; problems become row errors. */
export function readReferenceColumns(records: Array<Record<string, string>>) {
  const errors: RefRowError[] = [];
  const refs = records.map((r, i) => {
    const p = parseReference(r.reference_source, r.reference_id);
    if (!p.ok) {
      errors.push({ row: i + 1, column: p.column, message: p.problem });
      return null;
    }
    return p.ref;
  });
  return { refs, errors };
}

/** Apply each row's reference to the product created or named on that row (lenient). */
export async function applyUploadedReferencesInTx(
  tx: Tx,
  ctx: TenantContext,
  links: Array<{ productId: string; foodId: string }>,
): Promise<BulkLinkResult> {
  if (links.length === 0) return tally([]);
  const foods = await tx.referenceFood.findMany({
    where: { organizationId: ctx.organizationId, id: { in: links.map((l) => l.foodId) } },
  });
  const foodOf = new Map(foods.map((f) => [f.id, f]));
  const results: ApplyResult[] = [];
  for (const l of links)
    results.push(
      await applyReferenceInTx(
        tx,
        ctx,
        foodOf.get(l.foodId)!,
        l.productId,
        BULK_OPTIONS,
        "lenient",
      ),
    );
  return tally(results);
}

const MAX_LINK_ROWS = 2000;

/**
 * Link existing products in bulk from a CSV (sku, reference_source,
 * reference_id). All or nothing: every row must name a product and a record
 * found in (or fetched into) the library.
 */
export async function importReferenceLinks(ctx: TenantContext, text: string) {
  assertPermission(ctx.grants, "nutrition.manage");
  let parsed: ReturnType<typeof parseCsvRecords>;
  try {
    parsed = parseCsvRecords(text);
  } catch {
    return fail([{ row: 0, column: "", message: "csvMalformed" }]);
  }
  const { headers, records } = parsed;
  if (records.length === 0 || records.length > MAX_LINK_ROWS)
    return fail([
      { row: 0, column: "", message: records.length === 0 ? "csvEmpty" : "csvTooManyRows" },
    ]);
  const missing = ["sku", "reference_source", "reference_id"].filter((c) => !headers.includes(c));
  if (missing.length)
    return fail(missing.map((column) => ({ row: 0, column, message: "csvMissingColumn" })));
  const { refs, errors } = readReferenceColumns(records);
  records.forEach((r, i) => {
    if (refs[i] === null && !errors.some((e) => e.row === i + 1))
      errors.push({ row: i + 1, column: "reference_id", message: "referenceIncomplete" });
  });
  if (errors.length) return fail(errors);
  const foodIds = await resolveReferences(
    ctx,
    refs.filter((r) => r !== null),
  );
  return withTenantTx(ctx.organizationId, async (tx) => {
    const skus = records.map((r) => r.sku.trim());
    const products = await tx.product.findMany({
      where: { organizationId: ctx.organizationId, sku: { in: skus, mode: "insensitive" } },
      select: { id: true, sku: true },
    });
    const productOf = new Map(products.map((p) => [p.sku.toUpperCase(), p.id]));
    const links: Array<{ productId: string; foodId: string }> = [];
    const seen = new Set<string>();
    records.forEach((r, i) => {
      const row = i + 1;
      const productId = productOf.get(r.sku.trim().toUpperCase());
      if (!productId) errors.push({ row, column: "sku", message: "unknownSku" });
      else if (seen.has(productId))
        errors.push({ row, column: "sku", message: "skuDuplicateInFile" });
      const foodId = foodIds.get(referenceKey(refs[i]!));
      if (!foodId) errors.push({ row, column: "reference_id", message: "referenceNotFound" });
      if (productId) seen.add(productId);
      if (productId && foodId) links.push({ productId, foodId });
    });
    if (errors.length) return fail(errors);
    const r = await applyUploadedReferencesInTx(tx, ctx, links);
    return { ok: true as const, imported: links.length, errors: [] as RefRowError[], ...r };
  });
}

function fail(errors: RefRowError[]) {
  return {
    ok: false as const,
    imported: 0,
    errors,
    linked: 0,
    valuesCopied: 0,
    specKept: 0,
    allergenConflicts: 0,
  };
}

const useSchema = z.union([
  z.object({ foodId: uuidSchema }),
  z.object({ fdcId: z.string().regex(/^\d{1,10}$/) }),
]);

/**
 * From the product's page: make a library food (or a USDA record, fetched
 * into the library first) the product's reference, copying its label values,
 * allergens and Arabic name where that is allowed (lenient; the result says
 * what was kept).
 */
export async function chooseProductReference(
  ctx: TenantContext,
  productId: string,
  raw: unknown,
): Promise<ApplyResult> {
  assertPermission(ctx.grants, "nutrition.manage");
  const parsed = useSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  let foodId: string;
  if ("fdcId" in parsed.data) {
    const r = await importUsdaFoods(ctx, [parsed.data.fdcId]);
    if (!r.foods[0])
      throw businessRuleViolation("REFERENCE_NOT_FETCHED", "The USDA record could not be fetched", {
        detail: r.failed[0]?.message ?? "",
      });
    foodId = r.foods[0].foodId;
  } else foodId = parsed.data.foodId;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [food, product] = await Promise.all([
      tx.referenceFood.findFirst({ where: { organizationId: ctx.organizationId, id: foodId } }),
      tx.product.findFirst({
        where: { organizationId: ctx.organizationId, id: productId },
        select: { id: true },
      }),
    ]);
    if (!food) throw notFound("Library record");
    if (!product) throw notFound("Product");
    return applyReferenceInTx(tx, ctx, food, product.id, BULK_OPTIONS, "lenient");
  });
}
