import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { setArabicNameIfEmptyInTx } from "@/modules/catalog/service";
import { uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { type AllergenCode } from "./allergens";
import {
  LIBRARY_SOURCES,
  parseLibraryFile,
  SOURCE_TERMS,
  type LibrarySource,
  type ParseResult,
} from "./library-parsers";
import { NUTRIENTS } from "./rules";
import { profileSchema } from "./service";

/**
 * Ingredient library (DECISIONS.md ADR-041): records copied from USDA
 * FoodData Central, Open Food Facts and Wikidata with their licence and
 * provenance. Linking one to a product copies its values as an unverified
 * DATABASE profile and its listed allergens as CONTAINS / MAY_CONTAIN —
 * never FREE_FROM, and never over a statement someone already made.
 */

export const MAX_RECORDS_PER_IMPORT = 2000;
export const LIBRARY_PAGE_SIZE = 50;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Store parsed records (one transaction). The same content hash is imported once. */
export async function importParsed(
  ctx: TenantContext,
  input: { source: LibrarySource; fileName: string; sha256: string; parsed: ParseResult },
) {
  assertPermission(ctx.grants, "nutrition.manage");
  if (input.parsed.foods.length > MAX_RECORDS_PER_IMPORT)
    throw businessRuleViolation("LIBRARY_FILE_TOO_LARGE", "Too many records in one file", {
      max: MAX_RECORDS_PER_IMPORT,
    });
  return withTenantTx(ctx.organizationId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`library:${ctx.organizationId}`}))`;
    const existing = await tx.referenceImport.findFirst({
      where: { organizationId: ctx.organizationId, sha256: input.sha256 },
    });
    if (existing)
      return { importId: existing.id, alreadyImported: true, created: 0, updated: 0, skipped: 0 };
    const terms = SOURCE_TERMS[input.source];
    // A file may list a record twice; the last one wins.
    const bySourceId = new Map(input.parsed.foods.map((f) => [f.sourceId, f]));
    const before = new Set(
      (
        await tx.referenceFood.findMany({
          where: {
            organizationId: ctx.organizationId,
            source: input.source,
            sourceId: { in: [...bySourceId.keys()] },
          },
          select: { sourceId: true },
        })
      ).map((r) => r.sourceId),
    );
    const updated = [...bySourceId.keys()].filter((id) => before.has(id)).length;
    const created = bySourceId.size - updated;
    // Import records are insert-only.
    const imp = await tx.referenceImport.create({
      data: {
        organizationId: ctx.organizationId,
        source: input.source,
        fileName: input.fileName.slice(0, 200),
        sha256: input.sha256,
        created,
        updated,
        skipped: input.parsed.problems.filter((p) => p.index >= 0).length,
        problems: input.parsed.problems.slice(0, 200),
        importedByUserId: ctx.userId,
      },
    });
    for (const f of bySourceId.values()) {
      const data = {
        dataType: f.dataType,
        name: f.name,
        nameAr: f.nameAr,
        description: f.description,
        brand: f.brand,
        basis: f.basis,
        ...Object.fromEntries(NUTRIENTS.map((n) => [n, f.values[n] ?? null])),
        allergens: f.allergens,
        traces: f.traces,
        unmappedTags: f.unmappedTags,
        notes: f.notes,
        licence: terms.licence,
        attribution: terms.attribution,
        sourceUrl: f.sourceUrl,
        importId: imp.id,
      };
      await tx.referenceFood.upsert({
        where: {
          organizationId_source_sourceId: {
            organizationId: ctx.organizationId,
            source: input.source,
            sourceId: f.sourceId,
          },
        },
        create: {
          organizationId: ctx.organizationId,
          source: input.source,
          sourceId: f.sourceId,
          ...data,
        },
        update: data,
      });
    }
    await recordAudit(tx, actorOf(ctx), {
      action: "ingredient_library.imported",
      entityType: "reference_import",
      entityId: imp.id,
      changes: {
        source: input.source,
        fileName: input.fileName,
        created,
        updated,
        skipped: imp.skipped,
      },
    });
    return { importId: imp.id, alreadyImported: false, created, updated, skipped: imp.skipped };
  });
}

const importSchema = z.object({
  source: z.enum(LIBRARY_SOURCES, { error: "invalidOption" }),
  fileName: z.string().trim().min(1).max(200),
  content: z.string().min(1, { error: "required" }),
});

export async function importLibraryFile(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "nutrition.manage");
  const parsed = importSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { source, fileName, content } = parsed.data;
  const result = parseLibraryFile(source, content);
  if (result.foods.length === 0)
    throw businessRuleViolation("LIBRARY_NOTHING_READ", "No records could be read from the file", {
      field: "file",
      reason: result.problems[0]?.reason ?? "noFoods",
    });
  return importParsed(ctx, {
    source,
    fileName,
    sha256: sha256(`${source}:${content}`),
    parsed: result,
  });
}

export async function listReferenceFoods(
  ctx: TenantContext,
  filters: { q?: string; source?: LibrarySource; page?: number } = {},
) {
  assertPermission(ctx.grants, "nutrition.view");
  const page = Math.max(1, filters.page ?? 1);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const q = filters.q?.trim();
    const where = {
      organizationId: ctx.organizationId,
      ...(filters.source ? { source: filters.source } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              { nameAr: { contains: q, mode: "insensitive" as const } },
              { brand: { contains: q, mode: "insensitive" as const } },
              { sourceId: q },
            ],
          }
        : {}),
    };
    const [total, items] = await Promise.all([
      tx.referenceFood.count({ where }),
      tx.referenceFood.findMany({
        where,
        select: {
          id: true,
          source: true,
          sourceId: true,
          dataType: true,
          name: true,
          nameAr: true,
          brand: true,
          basis: true,
          energyKcal: true,
          allergens: true,
          linkedProduct: { select: { id: true, sku: true } },
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        skip: (page - 1) * LIBRARY_PAGE_SIZE,
        take: LIBRARY_PAGE_SIZE,
      }),
    ]);
    return { total, items, page, pageCount: Math.max(1, Math.ceil(total / LIBRARY_PAGE_SIZE)) };
  });
}

export async function listLibraryImports(ctx: TenantContext) {
  assertPermission(ctx.grants, "nutrition.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.referenceImport.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  );
}

export async function getReferenceFood(ctx: TenantContext, id: string) {
  assertPermission(ctx.grants, "nutrition.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const food = await tx.referenceFood.findFirst({
      where: { organizationId: ctx.organizationId, id },
      include: {
        linkedProduct: { select: { id: true, sku: true, nameEn: true, nameAr: true } },
        import: { select: { fileName: true, createdAt: true } },
      },
    });
    if (!food) throw notFound("Library record");
    return food;
  });
}

const linkSchema = z.object({
  productId: uuidSchema,
  nutrition: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  allergens: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  arabicName: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
});

/**
 * Use a library record for a product. Values become an unverified DATABASE
 * profile (refused over a supplier or lab profile); listed allergens become
 * CONTAINS / MAY_CONTAIN where nothing is known yet. A listed allergen that
 * contradicts someone's statement is reported, not applied.
 */
export async function linkReferenceFood(
  ctx: TenantContext,
  referenceFoodId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "nutrition.manage");
  const parsed = linkSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  if (!input.nutrition && !input.allergens && !input.arabicName)
    throw businessRuleViolation("NOTHING_TO_APPLY", "Choose what to use from the record");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const food = await tx.referenceFood.findFirst({
      where: { organizationId: ctx.organizationId, id: referenceFoodId },
    });
    if (!food) throw notFound("Library record");
    const product = await tx.product.findFirst({
      where: { organizationId: ctx.organizationId, id: input.productId },
      select: { id: true },
    });
    if (!product) throw notFound("Product");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`nutrition:${ctx.organizationId}:${product.id}`}))`;
    const reference = `${food.source === "USDA_FDC" ? "USDA FDC" : food.source === "OPEN_FOOD_FACTS" ? "Open Food Facts" : "Wikidata"} ${food.sourceId}${food.dataType ? ` (${food.dataType})` : ""}`;
    const result = {
      nutrition: false,
      allergens: [] as string[],
      conflicts: [] as string[],
      arabicName: false,
    };

    if (input.nutrition) {
      const values = Object.fromEntries(
        NUTRIENTS.map((n) => [n, food[n] === null ? undefined : food[n]!.toString()]),
      );
      if (!food.basis || Object.values(values).every((v) => v === undefined))
        throw businessRuleViolation(
          "REFERENCE_HAS_NO_VALUES",
          "The record has no nutrition values",
        );
      const check = profileSchema.safeParse({
        basis: food.basis,
        source: "DATABASE",
        reference,
        ...values,
      });
      if (!check.success)
        throw businessRuleViolation(
          "REFERENCE_VALUES_IMPLAUSIBLE",
          "The record's values fail the plausibility checks; enter them by hand",
          { detail: check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") },
        );
      const current = await tx.nutritionProfile.findFirst({
        where: { organizationId: ctx.organizationId, productId: product.id, supersededAt: null },
      });
      if (current && (current.source === "SUPPLIER_SPEC" || current.source === "LAB"))
        throw businessRuleViolation(
          "REFERENCE_WOULD_REPLACE_SPEC",
          "The product has values from a specification or lab; a database record does not replace them",
        );
      if (current)
        await tx.nutritionProfile.update({
          where: { id: current.id },
          data: { supersededAt: new Date() },
        });
      await tx.nutritionProfile.create({
        data: {
          organizationId: ctx.organizationId,
          productId: product.id,
          basis: food.basis,
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

    if (input.allergens) {
      const current = await tx.allergenDeclaration.findMany({
        where: { organizationId: ctx.organizationId, productId: product.id, supersededAt: null },
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
            productId: product.id,
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

    if (input.arabicName && food.nameAr)
      result.arabicName = await setArabicNameIfEmptyInTx(tx, ctx, product.id, food.nameAr);

    await tx.referenceFood.update({
      where: { id: food.id },
      data: { linkedProductId: product.id },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: "ingredient_library.linked",
      entityType: "product",
      entityId: product.id,
      changes: { referenceFoodId: food.id, reference, ...result },
    });
    return result;
  });
}
