import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Decimal, toDecimal } from "@/lib/decimal";
import { assertPermission, hasPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { loadUnits, toUnitDef } from "@/modules/catalog/service";
import type { UnitDef } from "@/modules/catalog/units";
import { loadRecipeStructureInTx } from "@/modules/recipes/costs";
import { explodeRecipe } from "@/modules/recipes/explode";
import { optionalText } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";
import { ALLERGEN_CODES, type AllergenCode } from "./allergens";
import {
  LABEL_NUTRIENTS,
  NUTRIENTS,
  reachedProducts,
  rollupAllergens,
  rollupNutrition,
  roundForLabel,
  type DeclarationInput,
  type Nutrient,
  type ProfileInput,
} from "./rules";

/**
 * Nutrition profiles, allergen declarations, recipe roll-up and labels
 * (DECISIONS.md ADR-040). Statements are append-only; "free from" and
 * profiles count as verified only after a second person confirms them.
 */

export const SOURCES = ["SUPPLIER_SPEC", "LAB", "DATABASE", "MANUAL"] as const;
export const STATEMENTS = ["CONTAINS", "MAY_CONTAIN", "FREE_FROM", "UNKNOWN"] as const;

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const nutrientValue = z
  .string()
  .optional()
  .transform(blank)
  .refine((v) => v === undefined || /^\d{1,8}(\.\d{1,4})?$/.test(v), { error: "invalidDecimal" });

export const profileSchema = z
  .object({
    basis: z.enum(["PER_100G", "PER_100ML"], { error: "invalidOption" }),
    source: z.enum(SOURCES, { error: "invalidOption" }),
    reference: optionalText(200),
    note: optionalText(500),
    ...Object.fromEntries(NUTRIENTS.map((n) => [n, nutrientValue])),
  })
  .superRefine((p, ctx) => {
    const v = (n: Nutrient) => {
      const raw = (p as Record<string, string | undefined>)[n];
      return raw === undefined || !/^\d{1,8}(\.\d{1,4})?$/.test(raw) ? null : new Decimal(raw);
    };
    if (NUTRIENTS.every((n) => v(n) === null))
      ctx.addIssue({ code: "custom", path: ["energyKcal"], message: "atLeastOneValue" });
    const fat = v("fat");
    const sat = v("saturatedFat");
    if (fat && sat && sat.gt(fat))
      ctx.addIssue({ code: "custom", path: ["saturatedFat"], message: "exceedsFat" });
    const carb = v("carbohydrate");
    const sugars = v("sugars");
    if (carb && sugars && sugars.gt(carb))
      ctx.addIssue({ code: "custom", path: ["sugars"], message: "exceedsCarbohydrate" });
    if (p.basis === "PER_100G") {
      for (const n of ["fat", "carbohydrate", "fibre", "protein", "salt"] as const)
        if (v(n)?.gt(100)) ctx.addIssue({ code: "custom", path: [n], message: "over100g" });
      if (v("sodium")?.gt(40))
        ctx.addIssue({ code: "custom", path: ["sodium"], message: "over100g" });
      if (v("energyKcal")?.gt(1000))
        ctx.addIssue({ code: "custom", path: ["energyKcal"], message: "implausibleEnergy" });
      if (v("energyKj")?.gt(4200))
        ctx.addIssue({ code: "custom", path: ["energyKj"], message: "implausibleEnergy" });
    }
    if ((p.source === "SUPPLIER_SPEC" || p.source === "LAB") && !p.reference)
      ctx.addIssue({ code: "custom", path: ["reference"], message: "required" });
  });

const declarationsSchema = z.object({
  source: z.enum(SOURCES, { error: "invalidOption" }),
  reference: optionalText(200),
  note: optionalText(500),
  statements: z.record(
    z.string(),
    z
      .string()
      .optional()
      .transform(blank)
      .refine((v) => v === undefined || (STATEMENTS as readonly string[]).includes(v), {
        error: "invalidOption",
      }),
  ),
});

async function audit(
  tx: Tx,
  ctx: TenantContext,
  entityType: string,
  entityId: string,
  action: string,
  changes: Record<string, unknown>,
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `${entityType}.${action}`,
    entityType,
    entityId,
    changes,
  });
}

async function requireProduct(tx: Tx, ctx: TenantContext, productId: string) {
  const p = await tx.product.findFirst({
    where: { organizationId: ctx.organizationId, id: productId },
    select: { id: true, sku: true, nameEn: true, nameAr: true },
  });
  if (!p) throw notFound("Product");
  // Serialize statements about one product.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`nutrition:${ctx.organizationId}:${productId}`}))`;
  return p;
}

// ─── Products ───

export async function getProductNutrition(ctx: TenantContext, productId: string) {
  assertPermission(ctx.grants, "nutrition.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const product = await tx.product.findFirst({
      where: { organizationId: ctx.organizationId, id: productId },
      select: {
        id: true,
        sku: true,
        nameEn: true,
        nameAr: true,
        baseUom: { select: { code: true, dimension: true } },
      },
    });
    if (!product) throw notFound("Product");
    const [profiles, declarations] = await Promise.all([
      tx.nutritionProfile.findMany({
        where: { organizationId: ctx.organizationId, productId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      tx.allergenDeclaration.findMany({
        where: { organizationId: ctx.organizationId, productId },
        orderBy: { declaredAt: "desc" },
        take: 200,
      }),
    ]);
    const userIds = [
      ...profiles.flatMap((p) => [p.createdByUserId, p.verifiedByUserId]),
      ...declarations.flatMap((d) => [d.declaredByUserId, d.verifiedByUserId]),
    ].filter((v): v is string => !!v);
    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, name: true },
    });
    const name = (id: string | null) =>
      id ? (users.find((u) => u.id === id)?.name ?? null) : null;
    const current = new Map(
      declarations.filter((d) => !d.supersededAt).map((d) => [d.allergen as AllergenCode, d]),
    );
    const profile = profiles.find((p) => !p.supersededAt) ?? null;
    return {
      product,
      profile,
      profileHistory: profiles.filter((p) => p.supersededAt),
      allergens: ALLERGEN_CODES.map((code) => ({ code, current: current.get(code) ?? null })),
      declarationHistory: declarations.filter((d) => d.supersededAt),
      name,
      can: {
        verifyProfile: !!profile && !profile.verifiedAt && profile.createdByUserId !== ctx.userId,
        verifyAllergens: [...current.values()].some(
          (d) => !d.verifiedAt && d.declaredByUserId !== ctx.userId && d.status !== "UNKNOWN",
        ),
      },
    };
  });
}

export async function recordNutritionProfile(
  ctx: TenantContext,
  productId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "nutrition.manage");
  const parsed = profileSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data as z.infer<typeof profileSchema> & Record<Nutrient, string | undefined>;
  return withTenantTx(ctx.organizationId, async (tx) => {
    await requireProduct(tx, ctx, productId);
    await tx.nutritionProfile.updateMany({
      where: { organizationId: ctx.organizationId, productId, supersededAt: null },
      data: { supersededAt: new Date() },
    });
    const values = Object.fromEntries(NUTRIENTS.map((n) => [n, input[n] ?? null]));
    const p = await tx.nutritionProfile.create({
      data: {
        organizationId: ctx.organizationId,
        productId,
        basis: input.basis,
        source: input.source,
        reference: input.reference,
        note: input.note,
        createdByUserId: ctx.userId,
        ...values,
      },
      select: { id: true },
    });
    await audit(tx, ctx, "nutrition_profile", p.id, "recorded", {
      productId,
      basis: input.basis,
      source: input.source,
      ...values,
    });
    return p;
  });
}

/** Confirm the current profile — by someone other than who entered it. */
export async function verifyNutritionProfile(ctx: TenantContext, productId: string) {
  assertPermission(ctx.grants, "nutrition.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    await requireProduct(tx, ctx, productId);
    const p = await tx.nutritionProfile.findFirst({
      where: { organizationId: ctx.organizationId, productId, supersededAt: null },
    });
    if (!p) throw businessRuleViolation("NO_NUTRITION_PROFILE", "No nutrition values recorded");
    if (p.verifiedAt) throw businessRuleViolation("ALREADY_VERIFIED", "Already verified");
    if (p.createdByUserId === ctx.userId)
      throw businessRuleViolation(
        "NUTRITION_SELF_VERIFY",
        "Someone other than who entered it must verify",
      );
    await tx.nutritionProfile.update({
      where: { id: p.id },
      data: { verifiedAt: new Date(), verifiedByUserId: ctx.userId },
    });
    await audit(tx, ctx, "nutrition_profile", p.id, "verified", { productId });
  });
}

/**
 * Record statements for any allergens given (others stay as they are).
 * Statements that match the current one are skipped.
 */
export async function declareAllergens(ctx: TenantContext, productId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "nutrition.manage");
  const parsed = declarationsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  const wanted = Object.entries(input.statements)
    .filter((e): e is [AllergenCode, (typeof STATEMENTS)[number]] => !!e[1])
    .filter(([code]) => (ALLERGEN_CODES as readonly string[]).includes(code));
  if (wanted.length === 0)
    throw businessRuleViolation("NOTHING_DECLARED", "Choose a statement for at least one allergen");
  if (wanted.some(([, s]) => s === "FREE_FROM")) {
    if (!input.reference)
      throw businessRuleViolation(
        "FREE_FROM_NEEDS_REFERENCE",
        "A free-from statement needs the specification or report it comes from",
        { field: "reference" },
      );
    if (input.source === "DATABASE")
      throw businessRuleViolation(
        "FREE_FROM_NOT_FROM_DATABASE",
        "A food database cannot show that an allergen is absent",
        { field: "source" },
      );
  }
  return withTenantTx(ctx.organizationId, async (tx) => {
    await requireProduct(tx, ctx, productId);
    const current = await tx.allergenDeclaration.findMany({
      where: { organizationId: ctx.organizationId, productId, supersededAt: null },
    });
    const changed: Array<{ allergen: string; status: string }> = [];
    for (const [allergen, status] of wanted) {
      const before = current.find((d) => d.allergen === allergen);
      if (before?.status === status && before.reference === (input.reference ?? null)) continue;
      if (!before && status === "UNKNOWN") continue;
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
          source: input.source,
          reference: input.reference,
          note: input.note,
          declaredByUserId: ctx.userId,
        },
      });
      changed.push({ allergen, status });
    }
    if (changed.length > 0)
      await audit(tx, ctx, "product", productId, "allergens_declared", {
        source: input.source,
        reference: input.reference ?? null,
        statements: changed,
      });
    return { changed: changed.length };
  });
}

/** Confirm every current statement about a product that someone else made. */
export async function verifyAllergenDeclarations(ctx: TenantContext, productId: string) {
  assertPermission(ctx.grants, "nutrition.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    await requireProduct(tx, ctx, productId);
    const open = await tx.allergenDeclaration.findMany({
      where: {
        organizationId: ctx.organizationId,
        productId,
        supersededAt: null,
        verifiedAt: null,
        status: { not: "UNKNOWN" },
        declaredByUserId: { not: ctx.userId },
      },
    });
    if (open.length === 0)
      throw businessRuleViolation(
        "NOTHING_TO_VERIFY",
        "No statements by someone else are waiting for verification",
      );
    await tx.allergenDeclaration.updateMany({
      where: { id: { in: open.map((d) => d.id) } },
      data: { verifiedAt: new Date(), verifiedByUserId: ctx.userId },
    });
    await audit(tx, ctx, "product", productId, "allergens_verified", {
      allergens: open.map((d) => d.allergen),
    });
    return { verified: open.length };
  });
}

// ─── Recipes ───

type Units = Map<string, UnitDef>;

async function currentStatements(tx: Tx, ctx: TenantContext, productIds: string[]) {
  const [profiles, declarations] = await Promise.all([
    tx.nutritionProfile.findMany({
      where: {
        organizationId: ctx.organizationId,
        productId: { in: productIds },
        supersededAt: null,
      },
    }),
    tx.allergenDeclaration.findMany({
      where: {
        organizationId: ctx.organizationId,
        productId: { in: productIds },
        supersededAt: null,
      },
    }),
  ]);
  const profileInputs = new Map<string, ProfileInput>(
    profiles.map((p) => [
      p.productId,
      {
        id: p.id,
        basis: p.basis,
        verified: !!p.verifiedAt,
        values: Object.fromEntries(
          NUTRIENTS.map((n) => [n, p[n] === null ? null : dec(p[n] as Decimal)]),
        ),
      },
    ]),
  );
  const declarationInputs = new Map<string, Map<AllergenCode, DeclarationInput>>();
  for (const d of declarations) {
    const m = declarationInputs.get(d.productId) ?? new Map<AllergenCode, DeclarationInput>();
    m.set(d.allergen as AllergenCode, { status: d.status, verified: !!d.verifiedAt });
    declarationInputs.set(d.productId, m);
  }
  const hashParts = [
    ...profiles.map((p) => `p:${p.id}:${p.verifiedAt ? 1 : 0}`),
    ...declarations.map((d) => `d:${d.id}:${d.verifiedAt ? 1 : 0}`),
  ].sort();
  return { profileInputs, declarationInputs, hashParts };
}

/** Nutrition and allergens of a recipe version, calculated from its ingredients. */
async function calculateInTx(tx: Tx, ctx: TenantContext, versionId: string, units: Units) {
  const structure = (await loadRecipeStructureInTx(tx, ctx, [versionId])).get(versionId);
  if (!structure) throw notFound("Recipe version");
  const { root, world } = structure;
  const exploded = explodeRecipe(root, world, root.yieldQuantity, false, { net: true });
  const reached = reachedProducts(root, world);
  const incomplete = reached.incomplete || exploded.problems.length > 0;
  const statements = await currentStatements(tx, ctx, reached.productIds);
  const nutrition = rollupNutrition({
    usage: exploded.usage,
    products: world.products,
    profiles: statements.profileInputs,
    units,
    incomplete,
  });
  const allergens = rollupAllergens({
    productIds: reached.productIds,
    declarations: statements.declarationInputs,
    incomplete,
  });
  // Per portion, and per 100 g/ml of the finished recipe when it yields a mass or volume.
  const yieldUnit = root.yieldUom;
  const finished =
    (yieldUnit.dimension === "MASS" || yieldUnit.dimension === "VOLUME") &&
    yieldUnit.factorToBase !== null
      ? root.yieldQuantity.times(toDecimal(yieldUnit.factorToBase))
      : null;
  const scale = (by: Decimal | null) =>
    Object.fromEntries(
      NUTRIENTS.map((n) => [
        n,
        by && nutrition.totals[n] ? (nutrition.totals[n] as Decimal).dividedBy(by) : null,
      ]),
    ) as Record<Nutrient, Decimal | null>;
  const perPortion = root.portions ? scale(root.portions) : null;
  const per100 = finished ? scale(finished.dividedBy(100)) : null;
  const versions = [root.id, ...[...world.activeVersions.values()].map((v) => v.id)].sort();
  const inputsHash = createHash("sha256")
    .update([...versions, ...statements.hashParts].join("|"))
    .digest("hex");
  return {
    root,
    world,
    exploded,
    incomplete,
    nutrition,
    allergens,
    perPortion,
    per100,
    per100Basis: yieldUnit.dimension === "VOLUME" ? ("PER_100ML" as const) : ("PER_100G" as const),
    productIds: reached.productIds,
    inputsHash,
  };
}

type Calculation = Awaited<ReturnType<typeof calculateInTx>>;

/** What stops a label from being generated; empty = ready. */
function labelBlockers(c: Calculation) {
  const blockers: Array<{ kind: string; detail?: string }> = [];
  if (c.incomplete) blockers.push({ kind: "INCOMPLETE_RECIPE" });
  for (const n of LABEL_NUTRIENTS)
    if (c.nutrition.totals[n] === null) blockers.push({ kind: "NUTRIENT_UNKNOWN", detail: n });
  for (const code of ALLERGEN_CODES)
    if (c.allergens[code].status === "UNKNOWN")
      blockers.push({ kind: "ALLERGEN_UNKNOWN", detail: code });
  if (c.nutrition.unverified.length > 0) blockers.push({ kind: "UNVERIFIED_PROFILES" });
  if (!c.perPortion && !c.per100) blockers.push({ kind: "NO_PORTIONS_OR_WEIGHT" });
  if (c.productIds.some((id) => !c.nutrition.grams.has(id) && c.exploded.usage.has(id)))
    blockers.push({ kind: "NO_WEIGHT_FOR_INGREDIENT_LIST" });
  return blockers;
}

async function unitMap(tx: Tx, ctx: TenantContext): Promise<Units> {
  return new Map((await loadUnits(tx, ctx, true)).map((u) => [u.id, toUnitDef(u)]));
}

async function activeVersionOf(tx: Tx, ctx: TenantContext, recipeId: string) {
  const recipe = await tx.recipe.findFirst({
    where: { organizationId: ctx.organizationId, id: recipeId },
    select: { id: true, code: true, name: true, nameAr: true, type: true },
  });
  if (!recipe) throw notFound("Recipe");
  const active = await tx.recipeVersion.findFirst({
    where: { organizationId: ctx.organizationId, recipeId, status: "ACTIVE" },
    select: { id: true, versionNo: true, portions: true },
  });
  return { recipe, active };
}

export async function recipeNutrition(ctx: TenantContext, recipeId: string) {
  assertPermission(ctx.grants, "nutrition.view");
  assertPermission(ctx.grants, "recipes.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const { recipe, active } = await activeVersionOf(tx, ctx, recipeId);
    if (!active) return { recipe, active: null, calc: null, blockers: [], names: new Map() };
    const units = await unitMap(tx, ctx);
    const calc = await calculateInTx(tx, ctx, active.id, units);
    const products = await tx.product.findMany({
      where: { organizationId: ctx.organizationId, id: { in: calc.productIds } },
      select: { id: true, sku: true, nameEn: true, nameAr: true },
    });
    return {
      recipe,
      active,
      calc,
      blockers: labelBlockers(calc),
      names: new Map(products.map((p) => [p.id, p])),
    };
  });
}

/** Allergen status of every active recipe (front-of-house matrix). */
export async function allergenMatrix(ctx: TenantContext) {
  assertPermission(ctx.grants, "nutrition.view");
  assertPermission(ctx.grants, "recipes.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const versions = await tx.recipeVersion.findMany({
      where: { organizationId: ctx.organizationId, status: "ACTIVE", recipe: { archivedAt: null } },
      select: {
        id: true,
        recipe: { select: { id: true, code: true, name: true, nameAr: true, type: true } },
      },
      orderBy: { recipe: { code: "asc" } },
      take: 300,
    });
    const structures = await loadRecipeStructureInTx(
      tx,
      ctx,
      versions.map((v) => v.id),
    );
    const all = new Set<string>();
    const reached = new Map<string, ReturnType<typeof reachedProducts>>();
    for (const v of versions) {
      const s = structures.get(v.id)!;
      const r = reachedProducts(s.root, s.world);
      reached.set(v.id, r);
      r.productIds.forEach((id) => all.add(id));
    }
    const { declarationInputs } = await currentStatements(tx, ctx, [...all]);
    return versions.map((v) => {
      const r = reached.get(v.id)!;
      return {
        recipe: v.recipe,
        allergens: rollupAllergens({
          productIds: r.productIds,
          declarations: declarationInputs,
          incomplete: r.incomplete,
        }),
      };
    });
  });
}

// ─── Labels ───

const exact = (values: Record<Nutrient, Decimal | null> | null) =>
  values ? Object.fromEntries(NUTRIENTS.map((n) => [n, values[n]?.toFixed() ?? null])) : null;
const rounded = (values: Record<Nutrient, Decimal | null> | null) =>
  values
    ? Object.fromEntries(
        NUTRIENTS.map((n) => [n, values[n] ? roundForLabel(n, values[n] as Decimal) : null]),
      )
    : null;

export interface LabelContent {
  recipe: { code: string; name: string; nameAr: string | null; versionNo: number };
  portionsPerBatch: string | null;
  per100Basis: "PER_100G" | "PER_100ML";
  perPortion: Record<Nutrient, string | null> | null;
  per100: Record<Nutrient, string | null> | null;
  perPortionExact: Record<Nutrient, string | null> | null;
  per100Exact: Record<Nutrient, string | null> | null;
  /** Descending by edible weight. */
  ingredients: Array<{ sku: string; name: string; nameAr: string | null; grams: string }>;
  contains: AllergenCode[];
  mayContain: AllergenCode[];
}

export async function generateLabel(ctx: TenantContext, recipeId: string) {
  assertPermission(ctx.grants, "nutrition.manage");
  assertPermission(ctx.grants, "recipes.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`labels:${ctx.organizationId}:${recipeId}`}))`;
    const { recipe, active } = await activeVersionOf(tx, ctx, recipeId);
    if (!active)
      throw businessRuleViolation("NO_ACTIVE_VERSION", "The recipe has no active version");
    const pending = await tx.recipeLabel.findFirst({
      where: { organizationId: ctx.organizationId, recipeId, status: "PENDING_REVIEW" },
      select: { id: true },
    });
    if (pending)
      throw businessRuleViolation("LABEL_PENDING", "A label is already waiting for review");
    const calc = await calculateInTx(tx, ctx, active.id, await unitMap(tx, ctx));
    const blockers = labelBlockers(calc);
    if (blockers.length > 0)
      throw businessRuleViolation(
        "LABEL_DATA_INCOMPLETE",
        "Nutrition or allergen data is missing",
        {
          count: blockers.length,
        },
      );
    const products = await tx.product.findMany({
      where: { organizationId: ctx.organizationId, id: { in: calc.productIds } },
      select: { id: true, sku: true, nameEn: true, nameAr: true },
    });
    const ingredients = [...calc.nutrition.grams]
      .sort((a, b) => b[1].comparedTo(a[1]))
      .map(([id, grams]) => {
        const p = products.find((x) => x.id === id)!;
        return {
          sku: p.sku,
          name: p.nameEn,
          nameAr: p.nameAr,
          grams: grams.toDecimalPlaces(1).toFixed(),
        };
      });
    const content: LabelContent = {
      recipe: {
        code: recipe.code,
        name: recipe.name,
        nameAr: recipe.nameAr,
        versionNo: active.versionNo,
      },
      portionsPerBatch: active.portions?.toFixed() ?? null,
      per100Basis: calc.per100Basis,
      perPortion: rounded(calc.perPortion) as LabelContent["perPortion"],
      per100: rounded(calc.per100) as LabelContent["per100"],
      perPortionExact: exact(calc.perPortion) as LabelContent["perPortionExact"],
      per100Exact: exact(calc.per100) as LabelContent["per100Exact"],
      ingredients,
      contains: ALLERGEN_CODES.filter((c) => calc.allergens[c].status === "CONTAINS"),
      mayContain: ALLERGEN_CODES.filter((c) => calc.allergens[c].status === "MAY_CONTAIN"),
    };
    const last = await tx.recipeLabel.aggregate({
      where: { organizationId: ctx.organizationId, recipeId },
      _max: { labelNo: true },
    });
    const label = await tx.recipeLabel.create({
      data: {
        organizationId: ctx.organizationId,
        recipeId,
        versionId: active.id,
        labelNo: (last._max.labelNo ?? 0) + 1,
        content: content as object,
        inputsHash: calc.inputsHash,
        createdByUserId: ctx.userId,
      },
      select: { id: true, labelNo: true },
    });
    await audit(tx, ctx, "recipe_label", label.id, "generated", {
      recipeId,
      labelNo: label.labelNo,
      versionNo: active.versionNo,
    });
    return label;
  });
}

const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"], { error: "invalidOption" }),
  note: optionalText(500),
});

/** Approve or reject a pending label — by someone with `labels.approve` other than its author. */
export async function reviewLabel(ctx: TenantContext, labelId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "labels.approve");
  const parsed = reviewSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const note = parsed.data.note;
  if (parsed.data.decision === "REJECT" && !note)
    throw businessRuleViolation("REASON_REQUIRED", "Say why the label is rejected", {
      field: "note",
    });
  await withTenantTx(ctx.organizationId, async (tx) => {
    const found = await tx.recipeLabel.findFirst({
      where: { organizationId: ctx.organizationId, id: labelId },
      select: { recipeId: true },
    });
    if (!found) throw notFound("Label");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`labels:${ctx.organizationId}:${found.recipeId}`}))`;
    const label = await tx.recipeLabel.findFirstOrThrow({ where: { id: labelId } });
    if (label.status !== "PENDING_REVIEW")
      throw businessRuleViolation("LABEL_NOT_PENDING", "The label was already reviewed");
    if (label.createdByUserId === ctx.userId)
      throw businessRuleViolation(
        "LABEL_SELF_REVIEW",
        "Someone other than who generated the label must review it",
      );
    const now = new Date();
    if (parsed.data.decision === "APPROVE") {
      // The data must still be what the label was calculated from.
      const calc = await calculateInTx(tx, ctx, label.versionId, await unitMap(tx, ctx));
      if (calc.inputsHash !== label.inputsHash)
        throw businessRuleViolation(
          "LABEL_STALE",
          "Ingredients or their data changed since the label was generated; generate it again",
        );
      await tx.recipeLabel.updateMany({
        where: { organizationId: ctx.organizationId, recipeId: label.recipeId, status: "APPROVED" },
        data: { status: "SUPERSEDED", supersededAt: now },
      });
    }
    await tx.recipeLabel.update({
      where: { id: label.id },
      data: {
        status: parsed.data.decision === "APPROVE" ? "APPROVED" : "REJECTED",
        reviewedAt: now,
        reviewedByUserId: ctx.userId,
        reviewNote: note ?? null,
      },
    });
    await audit(
      tx,
      ctx,
      "recipe_label",
      label.id,
      parsed.data.decision === "APPROVE" ? "approved" : "rejected",
      {
        labelNo: label.labelNo,
        note: note ?? null,
      },
    );
  });
}

export async function listLabels(ctx: TenantContext, recipeId: string) {
  assertPermission(ctx.grants, "nutrition.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.recipeLabel.findMany({
      where: { organizationId: ctx.organizationId, recipeId },
      select: { id: true, labelNo: true, status: true, createdAt: true, reviewedAt: true },
      orderBy: { labelNo: "desc" },
      take: 50,
    }),
  );
}

export async function getLabel(ctx: TenantContext, labelId: string) {
  assertPermission(ctx.grants, "nutrition.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const label = await tx.recipeLabel.findFirst({
      where: { organizationId: ctx.organizationId, id: labelId },
      include: { recipe: { select: { id: true, code: true, name: true, nameAr: true } } },
    });
    if (!label) throw notFound("Label");
    const users = await tx.user.findMany({
      where: {
        id: { in: [label.createdByUserId, label.reviewedByUserId].filter((v): v is string => !!v) },
      },
      select: { id: true, name: true },
    });
    const name = (id: string | null) =>
      id ? (users.find((u) => u.id === id)?.name ?? null) : null;
    let stale = false;
    if (label.status === "APPROVED" || label.status === "PENDING_REVIEW") {
      const calc = await calculateInTx(tx, ctx, label.versionId, await unitMap(tx, ctx));
      stale = calc.inputsHash !== label.inputsHash;
    }
    return {
      ...label,
      content: label.content as unknown as LabelContent,
      stale,
      names: { createdBy: name(label.createdByUserId), reviewedBy: name(label.reviewedByUserId) },
      can: {
        review:
          label.status === "PENDING_REVIEW" &&
          label.createdByUserId !== ctx.userId &&
          hasPermission(ctx.grants, "labels.approve"),
      },
    };
  });
}
