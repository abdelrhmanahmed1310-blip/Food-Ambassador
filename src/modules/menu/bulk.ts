import "server-only";
import { z } from "zod";
import { assertPermission } from "@/modules/access/authorize";
import { businessDate } from "@/modules/inventory/rules";
import { optionalUuidSchema, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { AppError, notFound, validationFailed } from "@/server/errors";
import { menuCodeFrom, SALES_CHANNELS } from "./rules";
import { addMenuItemPrice, createMenuItem } from "./service";

/**
 * Put products and dishes on the menu in bulk (DECISIONS.md ADR-138). Any
 * product type can be sold — ingredients, semi-finished products, finished
 * goods (CPG), packaging, consumables — next to dishes, in any category: the
 * till treats them all alike (a product item uses one base unit of its stock;
 * a dish uses its recipe). Each new item goes through the same checks as one
 * added by hand.
 */

export const PRODUCT_TYPES = [
  "RAW_MATERIAL",
  "SEMI_FINISHED",
  "FINISHED_GOOD",
  "PACKAGING",
  "CONSUMABLE",
] as const;
export const CANDIDATE_LIMIT = 200;

const filterSchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  type: z.enum([...PRODUCT_TYPES, "DISH", "ALL"]).catch("ALL"),
});

/** Active products (any type) and dishes, and whether each is already on the menu. */
export async function menuCandidates(ctx: TenantContext, raw: Record<string, unknown> = {}) {
  assertPermission(ctx.grants, "menu.manage");
  const f = filterSchema.parse(raw);
  const org = ctx.organizationId;
  return withTenantTx(org, async (tx) => {
    const text = f.q ? { contains: f.q, mode: "insensitive" as const } : undefined;
    const [products, dishes, onMenu] = await Promise.all([
      f.type === "DISH"
        ? []
        : tx.product.findMany({
            where: {
              organizationId: org,
              archivedAt: null,
              ...(f.type === "ALL" ? {} : { type: f.type }),
              ...(text ? { OR: [{ sku: text }, { nameEn: text }, { nameAr: text }] } : {}),
            },
            select: {
              id: true,
              sku: true,
              nameEn: true,
              nameAr: true,
              type: true,
              baseUom: { select: { code: true } },
              barcodes: { select: { barcode: true }, take: 1 },
            },
            orderBy: { sku: "asc" },
            take: CANDIDATE_LIMIT,
          }),
      f.type === "ALL" || f.type === "DISH"
        ? tx.recipe.findMany({
            where: {
              organizationId: org,
              type: "DISH",
              archivedAt: null,
              ...(text ? { OR: [{ code: text }, { name: text }] } : {}),
            },
            select: { id: true, code: true, name: true },
            orderBy: { code: "asc" },
            take: CANDIDATE_LIMIT,
          })
        : [],
      tx.menuItem.findMany({
        where: { organizationId: org, archivedAt: null, kind: "ITEM" },
        select: { productId: true, recipeId: true },
      }),
    ]);
    const productsOn = new Set(onMenu.map((i) => i.productId).filter(Boolean));
    const dishesOn = new Set(onMenu.map((i) => i.recipeId).filter(Boolean));
    return {
      filter: f,
      rows: [
        ...products.map((p) => ({
          source: "PRODUCT" as const,
          id: p.id,
          code: p.sku,
          name: p.nameEn,
          nameAr: p.nameAr,
          type: p.type as string,
          unit: p.baseUom.code,
          barcode: p.barcodes[0]?.barcode ?? null,
          onMenu: productsOn.has(p.id),
        })),
        ...dishes.map((r) => ({
          source: "DISH" as const,
          id: r.id,
          code: r.code,
          name: r.name,
          nameAr: null,
          type: "DISH",
          unit: null,
          barcode: null,
          onMenu: dishesOn.has(r.id),
        })),
      ],
    };
  });
}

const addSchema = z.object({
  categoryId: uuidSchema,
  channels: z.array(z.enum(SALES_CHANNELS)).max(SALES_CHANNELS.length).default([]),
  branchId: optionalUuidSchema,
  lines: z
    .array(
      z.object({
        source: z.enum(["PRODUCT", "DISH"]),
        id: uuidSchema,
        // Empty: added without a price (not on sale until one is added).
        price: z
          .string()
          .trim()
          .optional()
          .transform((v) => (v ? v : undefined)),
      }),
    )
    .min(1, { error: "chooseAtLeastOne" })
    .max(CANDIDATE_LIMIT),
});

export interface AddToMenuResult {
  created: Array<{ id: string; code: string; name: string }>;
  skipped: Array<{ id: string; name: string; reason: string }>;
}

/**
 * Add chosen products and dishes to one category, each priced on the chosen
 * channels from today. Something already on the menu is skipped, and so is a
 * line the usual checks refuse (an archived product, a price that is not a
 * number); the rest are added. Each item is audited like one added by hand.
 */
export async function addToMenu(ctx: TenantContext, raw: unknown): Promise<AddToMenuResult> {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = addSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  const org = ctx.organizationId;
  const lines = [...new Map(input.lines.map((l) => [`${l.source}:${l.id}`, l])).values()];
  const { products, dishes, onMenu, codes } = await withTenantTx(org, async (tx) => {
    const category = await tx.menuCategory.findFirst({
      where: { organizationId: org, id: input.categoryId, archivedAt: null },
    });
    if (!category) throw notFound("Category");
    const ids = (s: "PRODUCT" | "DISH") => lines.filter((l) => l.source === s).map((l) => l.id);
    return {
      products: await tx.product.findMany({
        where: { organizationId: org, id: { in: ids("PRODUCT") } },
        select: { id: true, sku: true, nameEn: true, nameAr: true },
      }),
      dishes: await tx.recipe.findMany({
        where: { organizationId: org, id: { in: ids("DISH") } },
        select: { id: true, code: true, name: true },
      }),
      onMenu: await tx.menuItem.findMany({
        where: { organizationId: org, archivedAt: null, kind: "ITEM" },
        select: { productId: true, recipeId: true },
      }),
      codes: await tx.menuItem.findMany({ where: { organizationId: org }, select: { code: true } }),
    };
  });
  const taken = new Set(codes.map((c) => c.code.toUpperCase()));
  const productOf = new Map(products.map((p) => [p.id, p]));
  const dishOf = new Map(dishes.map((d) => [d.id, d]));
  const today = businessDate(ctx.timeZone);
  const result: AddToMenuResult = { created: [], skipped: [] };
  for (const l of lines) {
    const p = l.source === "PRODUCT" ? productOf.get(l.id) : undefined;
    const d = l.source === "DISH" ? dishOf.get(l.id) : undefined;
    if (!p && !d) {
      result.skipped.push({ id: l.id, name: "", reason: "NOT_FOUND" });
      continue;
    }
    const name = (p?.nameEn ?? d!.name).slice(0, 160);
    const already = onMenu.some((i) => (p ? i.productId === p.id : i.recipeId === d!.id));
    if (already) {
      result.skipped.push({ id: l.id, name, reason: "ALREADY_ON_MENU" });
      continue;
    }
    if (l.price && !/^\d{1,12}(\.\d{1,4})?$/.test(l.price)) {
      result.skipped.push({ id: l.id, name, reason: "PRICE_INVALID" });
      continue;
    }
    const code = menuCodeFrom(p?.sku ?? d!.code, taken);
    try {
      const item = (await createMenuItem(ctx, {
        code,
        name,
        nameAr: p?.nameAr ?? "",
        categoryId: input.categoryId,
        kind: "ITEM",
        ...(p ? { productId: p.id } : { recipeId: d!.id }),
      }))!;
      taken.add(item.code.toUpperCase());
      result.created.push({ id: item.id, code: item.code, name });
      if (l.price)
        for (const channel of input.channels)
          await addMenuItemPrice(ctx, item.id, {
            channel,
            branchId: input.branchId ?? "",
            price: l.price,
            effectiveFrom: today,
          });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const rule = typeof error.details?.rule === "string" ? error.details.rule : error.code;
      result.skipped.push({ id: l.id, name, reason: rule });
    }
  }
  return result;
}

const pricedSchema = z.object({
  price: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || /^\d{1,12}(\.\d{1,4})?$/.test(v), {
      error: "invalidDecimal",
    }),
  sellOn: z.array(z.enum(SALES_CHANNELS)).max(SALES_CHANNELS.length).default([]),
});

/**
 * A new menu item, priced on the chosen channels from today in the same step
 * (ADR-139), instead of creating it and then adding a price per channel. The
 * price is checked before anything is created.
 */
export async function createMenuItemPriced(
  ctx: TenantContext,
  raw: Record<string, unknown> & { price?: unknown; sellOn?: unknown },
) {
  assertPermission(ctx.grants, "menu.manage");
  const { price, sellOn, ...item } = raw;
  const parsed = pricedSchema.safeParse({ price, sellOn });
  if (!parsed.success) throw validationFailed(parsed.error);
  const created = (await createMenuItem(ctx, item))!;
  if (parsed.data.price)
    for (const channel of parsed.data.sellOn)
      await addMenuItemPrice(ctx, created.id, {
        channel,
        price: parsed.data.price,
        effectiveFrom: businessDate(ctx.timeZone),
      });
  return created;
}
