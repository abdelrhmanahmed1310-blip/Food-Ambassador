import "server-only";
import { companyContext } from "@/modules/fx/service";
import { z } from "zod";
import { isCalendarDate } from "@/lib/dates";
import { Decimal, decimalString } from "@/lib/decimal";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { businessDate } from "@/modules/inventory/rules";
import {
  codeSchema,
  optionalText,
  optionalUuidSchema,
  requiredText,
  uuidSchema,
} from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { hasValidGs1CheckDigit } from "@/modules/catalog/barcodes";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, conflict, notFound, validationFailed } from "@/server/errors";
import { SALES_CHANNELS, resolvePrice, type PriceRow, type SalesChannel } from "./rules";

/**
 * The point-of-sale menu (DECISIONS.md ADR-058): categories, items that use
 * a recipe or a stock product, combos of items, modifier groups with options
 * (price change and what they use from stock), prices per channel and
 * optionally per branch (dated, append-only), and items not offered at a
 * branch. Organization-wide, managed with `menu.manage`.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const day = (d: Date) => d.toISOString().slice(0, 10);
const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const sortOrder = z
  .string()
  .optional()
  .transform((v) => (blank(v) === undefined ? 0 : Number(v)))
  .refine((n) => Number.isInteger(n) && n >= 0 && n <= 9999, { error: "invalidNumber" });
const optionalQuantity = z
  .string()
  .optional()
  .transform(blank)
  .pipe(decimalString({ maxScale: 6, min: "0.000001" }).optional());

async function audit(
  tx: Tx,
  ctx: TenantContext,
  entityType: string,
  entityId: string,
  action: string,
  changes: Record<string, unknown> = {},
) {
  await recordAudit(tx, actorOf(ctx), {
    action: `${entityType}.${action}`,
    entityType,
    entityId,
    changes,
  });
}

function codeTaken(error: unknown): never {
  if (isUniqueViolation(error, "menu_items_barcode_key"))
    throw conflict("This barcode is already used", {
      reason: "menuBarcodeTaken",
      field: "barcode",
    });
  if (isUniqueViolation(error))
    throw conflict("This code is already used", { reason: "codeTaken", field: "code" });
  throw error;
}

/**
 * A menu item barcode (ADR-133): EAN-8, UPC-A, EAN-13 or GTIN-14 digits with a
 * valid check digit, or any printable code (Code 128, QR, in-house labels).
 */
const barcodeField = z
  .string()
  .trim()
  .max(64)
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^[\x21-\x7e]{1,64}$/.test(v), { error: "invalidBarcode" })
  .refine((v) => v === null || !/^(\d{8}|\d{12,14})$/.test(v) || hasValidGs1CheckDigit(v), {
    error: "invalidCheckDigit",
  });

// ─── Categories ───

const categorySchema = z.object({
  name: requiredText(120),
  nameAr: optionalText(120),
  sortOrder,
});

export async function createMenuCategory(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = categorySchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.menuCategory.create({
      data: { organizationId: ctx.organizationId, ...parsed.data },
      select: { id: true },
    });
    await audit(tx, ctx, "menu_category", c.id, "created", parsed.data);
    return c;
  });
}

export async function updateMenuCategory(
  ctx: TenantContext,
  categoryId: string,
  rawInput: unknown,
) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = categorySchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const c = await tx.menuCategory.findFirst({
      where: { organizationId: ctx.organizationId, id: categoryId },
    });
    if (!c) throw notFound("Category");
    await tx.menuCategory.update({
      where: { id: c.id },
      data: { ...parsed.data, nameAr: parsed.data.nameAr ?? null },
    });
    await audit(tx, ctx, "menu_category", c.id, "updated", parsed.data);
  });
}

// ─── Items ───

const itemSchema = z
  .object({
    code: codeSchema,
    name: requiredText(160),
    nameAr: optionalText(160),
    description: optionalText(500),
    categoryId: uuidSchema,
    kind: z.enum(["ITEM", "COMBO"], { error: "invalidOption" }),
    recipeId: optionalUuidSchema,
    productId: optionalUuidSchema,
    productQuantity: optionalQuantity,
    taxCodeId: optionalUuidSchema,
    barcode: barcodeField,
    sortOrder,
  })
  .superRefine((v, c) => {
    if (v.kind === "ITEM" && !v.recipeId === !v.productId)
      c.addIssue({ code: "custom", path: ["recipeId"], message: "chooseRecipeOrProduct" });
    if (v.kind === "COMBO" && (v.recipeId || v.productId))
      c.addIssue({ code: "custom", path: ["recipeId"], message: "comboUsesComponents" });
  });

/** Checks the item's links (dish recipe, active product, category, tax code) inside the transaction. */
async function itemLinks(tx: Tx, ctx: TenantContext, v: z.infer<typeof itemSchema>) {
  const org = ctx.organizationId;
  const category = await tx.menuCategory.findFirst({
    where: { organizationId: org, id: v.categoryId, archivedAt: null },
  });
  if (!category) throw notFound("Category");
  if (v.recipeId) {
    const r = await tx.recipe.findFirst({
      where: { organizationId: org, id: v.recipeId },
      select: { type: true, archivedAt: true },
    });
    if (!r) throw notFound("Recipe");
    if (r.type !== "DISH" || r.archivedAt)
      throw businessRuleViolation("MENU_RECIPE_NOT_DISH", "Only active dishes can be sold", {
        field: "recipeId",
      });
  }
  if (v.productId) {
    const p = await tx.product.findFirst({
      where: { organizationId: org, id: v.productId },
      select: { archivedAt: true },
    });
    if (!p) throw notFound("Product");
    if (p.archivedAt)
      throw businessRuleViolation("PRODUCT_ARCHIVED", "The product is archived", {
        field: "productId",
      });
  }
  if (v.taxCodeId) {
    const t = await tx.taxCode.findFirst({
      where: { organizationId: org, id: v.taxCodeId, archivedAt: null },
    });
    if (!t) throw notFound("Tax code");
  }
  // One scan, one item: a barcode of another product would make the scan ambiguous.
  if (v.barcode) {
    const owner = await tx.productBarcode.findFirst({
      where: { organizationId: org, barcode: v.barcode },
      select: { productId: true },
    });
    if (owner && !(v.kind === "ITEM" && owner.productId === v.productId))
      throw businessRuleViolation(
        "MENU_BARCODE_OF_OTHER_PRODUCT",
        "This barcode belongs to another product",
        { field: "barcode" },
      );
  }
  return {
    code: v.code,
    name: v.name,
    nameAr: v.nameAr ?? null,
    description: v.description ?? null,
    categoryId: v.categoryId,
    kind: v.kind,
    recipeId: v.kind === "ITEM" ? (v.recipeId ?? null) : null,
    productId: v.kind === "ITEM" ? (v.productId ?? null) : null,
    // A product item uses 1 base unit unless told otherwise.
    productQuantity: v.kind === "ITEM" && v.productId ? (v.productQuantity ?? "1") : null,
    taxCodeId: v.taxCodeId ?? null,
    barcode: v.barcode,
    sortOrder: v.sortOrder,
  };
}

export async function createMenuItem(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = itemSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const data = await itemLinks(tx, ctx, parsed.data);
      const item = await tx.menuItem.create({
        data: { organizationId: ctx.organizationId, ...data },
        select: { id: true, code: true },
      });
      await audit(tx, ctx, "menu_item", item.id, "created", data);
      return item;
    });
  } catch (error) {
    codeTaken(error);
  }
}

export async function updateMenuItem(ctx: TenantContext, itemId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = itemSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const before = await tx.menuItem.findFirst({
        where: { organizationId: ctx.organizationId, id: itemId },
      });
      if (!before) throw notFound("Menu item");
      if (before.kind !== parsed.data.kind)
        throw businessRuleViolation(
          "MENU_KIND_FIXED",
          "An item cannot become a combo or the other way round",
          {
            field: "kind",
          },
        );
      const data = await itemLinks(tx, ctx, parsed.data);
      await tx.menuItem.update({ where: { id: before.id }, data });
      await audit(tx, ctx, "menu_item", before.id, "updated", data);
    });
  } catch (error) {
    codeTaken(error);
  }
}

export async function setMenuItemArchived(ctx: TenantContext, itemId: string, archived: boolean) {
  assertPermission(ctx.grants, "menu.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const item = await tx.menuItem.findFirst({
      where: { organizationId: ctx.organizationId, id: itemId },
    });
    if (!item) throw notFound("Menu item");
    await tx.menuItem.update({
      where: { id: item.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await audit(tx, ctx, "menu_item", item.id, archived ? "archived" : "restored");
  });
}

// ─── Prices ───

const priceSchema = z.object({
  channel: z.enum(SALES_CHANNELS, { error: "invalidOption" }),
  branchId: optionalUuidSchema,
  price: decimalString({ maxScale: 4, min: "0" }),
  effectiveFrom: z.string().refine(isCalendarDate, { error: "invalidDate" }),
});

/** A new price from a date (history is kept; a correction is a new row). */
export async function addMenuItemPrice(ctx: TenantContext, itemId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = priceSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const item = await tx.menuItem.findFirst({
        where: { organizationId: ctx.organizationId, id: itemId },
      });
      if (!item) throw notFound("Menu item");
      if (input.branchId) {
        const b = await tx.branch.findFirst({
          where: { organizationId: ctx.organizationId, id: input.branchId },
        });
        if (!b) throw notFound("Branch");
      }
      const includesTax =
        (await tx.taxSettings.findUnique({ where: { organizationId: ctx.organizationId } }))
          ?.pricesIncludeTax ?? false;
      await tx.menuItemPrice.create({
        data: {
          organizationId: ctx.organizationId,
          itemId: item.id,
          channel: input.channel,
          branchId: input.branchId ?? null,
          price: input.price,
          includesTax,
          effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`),
          createdByUserId: ctx.userId,
        },
      });
      await audit(tx, ctx, "menu_item", item.id, "price_added", { ...input, includesTax });
    });
  } catch (error) {
    if (isUniqueViolation(error, "menu_item_prices_key"))
      throw conflict("A price already starts on this date", {
        reason: "duplicate",
        field: "effectiveFrom",
      });
    throw error;
  }
}

// ─── Modifiers ───

const groupSchema = z
  .object({
    name: requiredText(120),
    nameAr: optionalText(120),
    minSelect: z.coerce.number({ error: "invalidNumber" }).int().min(0).max(20),
    maxSelect: z.coerce.number({ error: "invalidNumber" }).int().min(1).max(20),
  })
  .refine((v) => v.minSelect <= v.maxSelect, { path: ["maxSelect"], message: "maxBelowMin" });

export async function createModifierGroup(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = groupSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const g = await tx.modifierGroup.create({
      data: { organizationId: ctx.organizationId, ...parsed.data },
      select: { id: true },
    });
    await audit(tx, ctx, "modifier_group", g.id, "created", parsed.data);
    return g;
  });
}

export async function updateModifierGroup(ctx: TenantContext, groupId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = groupSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const g = await tx.modifierGroup.findFirst({
      where: { organizationId: ctx.organizationId, id: groupId },
    });
    if (!g) throw notFound("Modifier group");
    await tx.modifierGroup.update({
      where: { id: g.id },
      data: { ...parsed.data, nameAr: parsed.data.nameAr ?? null },
    });
    await audit(tx, ctx, "modifier_group", g.id, "updated", parsed.data);
  });
}

const optionSchema = z
  .object({
    name: requiredText(120),
    nameAr: optionalText(120),
    priceDelta: z
      .string()
      .optional()
      .transform((v) => blank(v) ?? "0")
      .pipe(decimalString({ maxScale: 4, allowNegative: true })),
    recipeId: optionalUuidSchema,
    productId: optionalUuidSchema,
    quantity: optionalQuantity,
    sortOrder,
  })
  .superRefine((v, c) => {
    if (v.recipeId && v.productId)
      c.addIssue({ code: "custom", path: ["productId"], message: "chooseRecipeOrProduct" });
    if ((v.recipeId || v.productId) && !v.quantity)
      c.addIssue({ code: "custom", path: ["quantity"], message: "required" });
  });

export async function addModifierOption(ctx: TenantContext, groupId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = optionSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const v = parsed.data;
  return withTenantTx(ctx.organizationId, async (tx) => {
    const org = ctx.organizationId;
    const g = await tx.modifierGroup.findFirst({ where: { organizationId: org, id: groupId } });
    if (!g) throw notFound("Modifier group");
    if (
      v.recipeId &&
      !(await tx.recipe.count({ where: { organizationId: org, id: v.recipeId, archivedAt: null } }))
    )
      throw notFound("Recipe");
    if (
      v.productId &&
      !(await tx.product.count({
        where: { organizationId: org, id: v.productId, archivedAt: null },
      }))
    )
      throw notFound("Product");
    const data = {
      name: v.name,
      nameAr: v.nameAr ?? null,
      priceDelta: v.priceDelta,
      recipeId: v.recipeId ?? null,
      productId: v.productId ?? null,
      quantity: v.recipeId || v.productId ? (v.quantity ?? null) : null,
      sortOrder: v.sortOrder,
    };
    const o = await tx.modifierOption.create({
      data: { organizationId: org, groupId: g.id, ...data },
      select: { id: true },
    });
    await audit(tx, ctx, "modifier_group", g.id, "option_added", { optionId: o.id, ...data });
    return o;
  });
}

export async function setModifierOptionArchived(
  ctx: TenantContext,
  optionId: string,
  archived: boolean,
) {
  assertPermission(ctx.grants, "menu.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const o = await tx.modifierOption.findFirst({
      where: { organizationId: ctx.organizationId, id: optionId },
    });
    if (!o) throw notFound("Modifier option");
    await tx.modifierOption.update({
      where: { id: o.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await audit(
      tx,
      ctx,
      "modifier_group",
      o.groupId,
      archived ? "option_archived" : "option_restored",
      {
        optionId: o.id,
      },
    );
  });
}

export async function attachModifierGroup(ctx: TenantContext, itemId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = z.object({ groupId: uuidSchema, sortOrder }).safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const org = ctx.organizationId;
    const item = await tx.menuItem.findFirst({ where: { organizationId: org, id: itemId } });
    if (!item) throw notFound("Menu item");
    const g = await tx.modifierGroup.findFirst({
      where: { organizationId: org, id: parsed.data.groupId, archivedAt: null },
    });
    if (!g) throw notFound("Modifier group");
    await tx.menuItemModifierGroup
      .create({
        data: {
          organizationId: org,
          itemId: item.id,
          groupId: g.id,
          sortOrder: parsed.data.sortOrder,
        },
      })
      .catch((e) => {
        if (isUniqueViolation(e))
          throw conflict("Already attached", { reason: "duplicate", field: "groupId" });
        throw e;
      });
    await audit(tx, ctx, "menu_item", item.id, "modifier_group_attached", { groupId: g.id });
  });
}

export async function detachModifierGroup(ctx: TenantContext, itemId: string, groupId: string) {
  assertPermission(ctx.grants, "menu.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const n = await tx.menuItemModifierGroup.deleteMany({
      where: { organizationId: ctx.organizationId, itemId, groupId },
    });
    if (n.count === 0) throw notFound("Modifier group");
    await audit(tx, ctx, "menu_item", itemId, "modifier_group_detached", { groupId });
  });
}

// ─── Combos ───

export async function addComboComponent(ctx: TenantContext, comboId: string, rawInput: unknown) {
  assertPermission(ctx.grants, "menu.manage");
  const parsed = z
    .object({
      componentId: uuidSchema,
      quantity: z
        .string()
        .optional()
        .transform((v) => blank(v) ?? "1")
        .pipe(decimalString({ maxScale: 6, min: "0.000001" })),
    })
    .safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  await withTenantTx(ctx.organizationId, async (tx) => {
    const org = ctx.organizationId;
    const combo = await tx.menuItem.findFirst({ where: { organizationId: org, id: comboId } });
    if (!combo) throw notFound("Menu item");
    if (combo.kind !== "COMBO")
      throw businessRuleViolation("MENU_NOT_COMBO", "Only combos have components");
    const part = await tx.menuItem.findFirst({
      where: { organizationId: org, id: parsed.data.componentId, archivedAt: null },
    });
    if (!part) throw notFound("Menu item");
    // One level only: a combo is made of items, never of other combos.
    if (part.kind !== "ITEM")
      throw businessRuleViolation("MENU_COMBO_IN_COMBO", "A combo cannot contain another combo", {
        field: "componentId",
      });
    await tx.comboComponent
      .create({
        data: {
          organizationId: org,
          comboId: combo.id,
          componentId: part.id,
          quantity: parsed.data.quantity,
        },
      })
      .catch((e) => {
        if (isUniqueViolation(e))
          throw conflict("Already in the combo", { reason: "duplicate", field: "componentId" });
        throw e;
      });
    await audit(tx, ctx, "menu_item", combo.id, "component_added", {
      componentId: part.id,
      quantity: parsed.data.quantity,
    });
  });
}

export async function removeComboComponent(
  ctx: TenantContext,
  comboId: string,
  componentId: string,
) {
  assertPermission(ctx.grants, "menu.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const n = await tx.comboComponent.deleteMany({
      where: { organizationId: ctx.organizationId, comboId, componentId },
    });
    if (n.count === 0) throw notFound("Component");
    await audit(tx, ctx, "menu_item", comboId, "component_removed", { componentId });
  });
}

// ─── Availability ───

/** Offer or stop offering an item at a branch (not offered there, or sold out). */
export async function setItemAvailability(
  ctx: TenantContext,
  itemId: string,
  branchId: string,
  available: boolean,
) {
  assertPermission(ctx.grants, "menu.manage");
  await withTenantTx(ctx.organizationId, async (tx) => {
    const org = ctx.organizationId;
    const item = await tx.menuItem.findFirst({ where: { organizationId: org, id: itemId } });
    if (!item) throw notFound("Menu item");
    const b = await tx.branch.findFirst({ where: { organizationId: org, id: branchId } });
    if (!b) throw notFound("Branch");
    if (available)
      await tx.menuItemUnavailable.deleteMany({ where: { organizationId: org, itemId, branchId } });
    else
      await tx.menuItemUnavailable.upsert({
        where: { organizationId_itemId_branchId: { organizationId: org, itemId, branchId } },
        create: { organizationId: org, itemId, branchId },
        update: {},
      });
    await audit(tx, ctx, "menu_item", item.id, available ? "made_available" : "made_unavailable", {
      branchId,
    });
  });
}

// ─── Queries ───

const priceRow = (p: {
  channel: SalesChannel;
  branchId: string | null;
  price: { toString(): string };
  includesTax: boolean;
  effectiveFrom: Date;
}): PriceRow => ({
  channel: p.channel,
  branchId: p.branchId,
  price: dec(p.price),
  includesTax: p.includesTax,
  effectiveFrom: day(p.effectiveFrom),
});

export async function listMenu(ctx: TenantContext) {
  assertPermission(ctx.grants, "menu.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [categories, items] = [
      await tx.menuCategory.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      await tx.menuItem.findMany({
        where: { organizationId: ctx.organizationId },
        include: { prices: true, _count: { select: { modifierGroups: true, components: true } } },
        orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      }),
    ];
    const today = businessDate(ctx.timeZone);
    return categories.map((c) => ({
      ...c,
      items: items
        .filter((i) => i.categoryId === c.id)
        .map((i) => ({
          ...i,
          // Organization-wide prices in effect today, per channel.
          current: Object.fromEntries(
            SALES_CHANNELS.map((ch) => [
              ch,
              resolvePrice(i.prices.filter((p) => p.branchId === null).map(priceRow), {
                channel: ch,
                branchId: "",
                date: today,
              }),
            ]),
          ) as Record<SalesChannel, PriceRow | null>,
        })),
    }));
  });
}

export async function getMenuItem(ctx: TenantContext, itemId: string) {
  assertPermission(ctx.grants, "menu.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const item = await tx.menuItem.findFirst({
      where: { organizationId: ctx.organizationId, id: itemId },
      include: {
        category: { select: { id: true, name: true, nameAr: true } },
        recipe: { select: { id: true, code: true, name: true } },
        product: {
          select: {
            id: true,
            sku: true,
            nameEn: true,
            imageId: true,
            baseUom: { select: { code: true } },
            barcodes: { select: { barcode: true } },
          },
        },
        taxCode: { select: { id: true, code: true } },
        prices: {
          include: {
            branch: {
              select: { id: true, code: true, name: true, company: { select: { currency: true } } },
            },
          },
          orderBy: [{ channel: "asc" }, { effectiveFrom: "desc" }],
        },
        modifierGroups: {
          include: {
            group: {
              include: { options: { where: { archivedAt: null }, orderBy: { sortOrder: "asc" } } },
            },
          },
          orderBy: { sortOrder: "asc" },
        },
        components: {
          include: { component: { select: { id: true, code: true, name: true } } },
        },
        unavailable: { include: { branch: { select: { id: true, code: true, name: true } } } },
      },
    });
    if (!item) throw notFound("Menu item");
    return item;
  });
}

export async function listModifierGroups(ctx: TenantContext) {
  assertPermission(ctx.grants, "menu.view");
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.modifierGroup.findMany({
      where: { organizationId: ctx.organizationId },
      include: {
        options: {
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          include: {
            recipe: { select: { code: true } },
            product: { select: { sku: true } },
          },
        },
        _count: { select: { items: true } },
      },
      orderBy: { name: "asc" },
    }),
  );
}

/**
 * What a branch sells on a channel today: active items in active categories,
 * offered at the branch and priced on the channel, with their modifiers and
 * combo components (for the cashier app, POS1b).
 */
export async function menuForBranch(
  ctx: TenantContext,
  at: { branchId: string; channel: SalesChannel; date?: string },
) {
  assertPermission(ctx.grants, "menu.view");
  const date = at.date ?? businessDate(ctx.timeZone);
  return withTenantTx(ctx.organizationId, async (tx) => {
    const org = ctx.organizationId;
    // A branch of a company in another currency than the group's sells at its own
    // branch prices, without options that change the price (those are in the group's, ADR-086).
    const company = await companyContext(tx, ctx, { branchId: at.branchId });
    const ownPricesOnly = company.currency !== ctx.groupCurrency;
    const items = await tx.menuItem.findMany({
      where: {
        organizationId: org,
        archivedAt: null,
        category: { archivedAt: null },
        unavailable: { none: { branchId: at.branchId } },
      },
      include: {
        category: { select: { id: true, name: true, nameAr: true, sortOrder: true } },
        prices: {
          where: {
            channel: at.channel,
            ...(ownPricesOnly
              ? { branchId: at.branchId }
              : { OR: [{ branchId: null }, { branchId: at.branchId }] }),
          },
        },
        modifierGroups: {
          where: { group: { archivedAt: null } },
          orderBy: { sortOrder: "asc" },
          include: {
            group: {
              include: {
                options: {
                  where: { archivedAt: null, ...(ownPricesOnly ? { priceDelta: 0 } : {}) },
                  orderBy: { sortOrder: "asc" },
                },
              },
            },
          },
        },
        components: {
          include: { component: { select: { id: true, code: true, name: true, nameAr: true } } },
        },
        // Photo and barcodes for the till, kiosk and boards (ADR-133).
        product: { select: { imageId: true, barcodes: { select: { barcode: true } } } },
      },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }, { code: "asc" }],
    });
    return items.flatMap((i) => {
      const price = resolvePrice(i.prices.map(priceRow), {
        channel: at.channel,
        branchId: at.branchId,
        date,
      });
      return price ? [{ ...i, price }] : [];
    });
  });
}

/** Choices for the menu forms (people managing the menu may not manage recipes or the catalog). */
export async function menuFormOptions(ctx: TenantContext) {
  assertPermission(ctx.grants, "menu.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const org = ctx.organizationId;
    return {
      categories: await tx.menuCategory.findMany({
        where: { organizationId: org, archivedAt: null },
        select: { id: true, name: true, nameAr: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      dishes: await tx.recipe.findMany({
        where: { organizationId: org, type: "DISH", archivedAt: null },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
        take: 2000,
      }),
      recipes: await tx.recipe.findMany({
        where: { organizationId: org, archivedAt: null },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
        take: 2000,
      }),
      products: await tx.product.findMany({
        where: { organizationId: org, archivedAt: null },
        select: { id: true, sku: true, nameEn: true, baseUom: { select: { code: true } } },
        orderBy: { sku: "asc" },
        take: 3000,
      }),
      taxCodes: await tx.taxCode.findMany({
        where: { organizationId: org, archivedAt: null },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
      branches: await tx.branch.findMany({
        where: { organizationId: org, archivedAt: null },
        // A branch price is in the branch's company's currency (ADR-086).
        select: { id: true, code: true, name: true, company: { select: { currency: true } } },
        orderBy: { code: "asc" },
      }),
      groups: await tx.modifierGroup.findMany({
        where: { organizationId: org, archivedAt: null },
        select: { id: true, name: true, minSelect: true, maxSelect: true },
        orderBy: { name: "asc" },
      }),
      items: await tx.menuItem.findMany({
        where: { organizationId: org, archivedAt: null, kind: "ITEM" },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
      }),
      pricesIncludeTax:
        (await tx.taxSettings.findUnique({ where: { organizationId: org } }))?.pricesIncludeTax ??
        false,
    };
  });
}
