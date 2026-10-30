import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { createCategory, listCategories, setCategoryArchived, updateCategory } from "./categories";
import { createProduct, getProduct, listProducts, listUnits, updateProduct } from "./service";

let ctx: TenantContext;
let kg: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("categories"));
  kg = (await listUnits(ctx)).find((u) => u.code === "kg")!.id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("product categories", () => {
  it("creates, renames, assigns, filters and archives categories", async () => {
    const dry = await createCategory(ctx, { code: "dry", name: "Dry goods", nameAr: "مواد جافة" });
    await expectAppError(createCategory(ctx, { code: "DRY", name: "Again" }), "CONFLICT");
    await updateCategory(ctx, dry.id, { code: "DRY", name: "Dry store" });
    const product = await createProduct(ctx, {
      sku: "RICE",
      nameEn: "Rice",
      type: "RAW_MATERIAL",
      baseUomId: kg,
      categoryId: dry.id,
    });
    expect((await getProduct(ctx, product.id)).category?.name).toBe("Dry store");
    await createProduct(ctx, { sku: "SALT", nameEn: "Salt", type: "RAW_MATERIAL", baseUomId: kg });
    const filtered = await listProducts(ctx, { categoryId: dry.id });
    expect(filtered.items.map((p) => p.sku)).toEqual(["RICE"]);

    await setCategoryArchived(ctx, dry.id, true);
    expect((await listCategories(ctx)).map((c) => c.code)).toEqual([]);
    // An archived category cannot be newly assigned, but products keep it.
    await expectAppError(
      createProduct(ctx, {
        sku: "SUGAR",
        nameEn: "Sugar",
        type: "RAW_MATERIAL",
        baseUomId: kg,
        categoryId: dry.id,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await updateProduct(ctx, product.id, {
      sku: "RICE",
      nameEn: "Basmati rice",
      type: "RAW_MATERIAL",
      baseUomId: kg,
      categoryId: dry.id,
    });
    // Clearing the category is allowed.
    await updateProduct(ctx, product.id, {
      sku: "RICE",
      nameEn: "Basmati rice",
      type: "RAW_MATERIAL",
      baseUomId: kg,
    });
    expect((await getProduct(ctx, product.id)).category).toBeNull();
  });

  it("needs catalog.manage and keeps categories per tenant", async () => {
    const analyst = await addMember(ctx, "analyst");
    await expectAppError(createCategory(analyst.ctx, { code: "X", name: "X" }), "FORBIDDEN");
    const mine = await createCategory(ctx, { code: "CHILL", name: "Chilled" });
    const { ctx: other } = await createTenant("categories-other");
    const otherKg = (await listUnits(other)).find((u) => u.code === "kg")!.id;
    await expectAppError(
      createProduct(other, {
        sku: "MILK",
        nameEn: "Milk",
        type: "RAW_MATERIAL",
        baseUomId: otherKg,
        categoryId: mine.id,
      }),
      "NOT_FOUND",
    );
    expect(await listCategories(other)).toEqual([]);
  });
});
