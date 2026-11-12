import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  createCategory,
  getCategory,
  listCategories,
  setCategoryArchived,
  updateCategory,
} from "./categories";
import { importCategories } from "./category-import";
import { createProduct, listProducts, listUnits } from "./service";

/** Subcategories and the category bulk upload (ADR-134). */

let ctx: TenantContext;
let each: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("category-tree"));
  each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("category tree (ADR-134)", () => {
  it("nests up to three levels, never in a loop, and filters products with subcategories", async () => {
    const bev = (await createCategory(ctx, { code: "BEV", name: "Beverages" }))!.id;
    const hot = (await createCategory(ctx, { code: "HOT", name: "Hot drinks", parentId: bev }))!.id;
    const coffee = (await createCategory(ctx, { code: "COF", name: "Coffee", parentId: hot }))!.id;
    await expectAppError(
      createCategory(ctx, { code: "ESP", name: "Espresso", parentId: coffee }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      updateCategory(ctx, bev, { code: "BEV", name: "Beverages", parentId: coffee }),
      "BUSINESS_RULE_VIOLATION",
    );
    // The database refuses it too, whatever the service does.
    await expect(
      getDb().productCategory.update({ where: { id: bev }, data: { parentId: coffee } }),
    ).rejects.toThrow();

    const tree = await listCategories(ctx);
    expect(tree.map((c) => `${c.depth}:${c.code}`)).toEqual(["0:BEV", "1:HOT", "2:COF"]);
    expect(tree[2].path.map((p) => p.code)).toEqual(["BEV", "HOT", "COF"]);
    expect((await getCategory(ctx, hot)).subcategories.map((s) => s.code)).toEqual(["COF"]);

    const arabica = await createProduct(ctx, {
      sku: "ARABICA",
      nameEn: "Arabica beans",
      type: "RAW_MATERIAL",
      baseUomId: each,
      categoryId: coffee,
    });
    await createProduct(ctx, {
      sku: "OTHER",
      nameEn: "Other",
      type: "RAW_MATERIAL",
      baseUomId: each,
    });
    // Filtering by "Beverages" finds the coffee beans two levels down.
    expect((await listProducts(ctx, { categoryId: bev })).items.map((p) => p.id)).toEqual([
      arabica.id,
    ]);

    // A parent with active subcategories is not archived; its leaves can be.
    await expectAppError(setCategoryArchived(ctx, hot, true), "BUSINESS_RULE_VIOLATION");
    await setCategoryArchived(ctx, coffee, true);
    await setCategoryArchived(ctx, hot, true);
    await expectAppError(setCategoryArchived(ctx, coffee, false), "BUSINESS_RULE_VIOLATION");
    await setCategoryArchived(ctx, hot, false);
    await setCategoryArchived(ctx, coffee, false);
  });

  it("bulk uploads categories with parents in any order, all or nothing", async () => {
    const analyst = (await addMember(ctx, "analyst", {}, "category-analyst")).ctx;
    await expectAppError(importCategories(analyst, "code,name\nX,X"), "FORBIDDEN");
    const good = [
      "code,name,name_ar,parent_code",
      "DAI-MILK,Milk,حليب,DAIRY",
      "DAIRY,Dairy,ألبان,",
      "DAI-CHEESE,Cheese,,dairy",
      "HOT-TEA,Tea,شاي,HOT",
    ].join("\n");
    expect(await importCategories(ctx, good)).toEqual({ ok: true, imported: 4, errors: [] });
    const tree = await listCategories(ctx);
    const milk = tree.find((c) => c.code === "DAI-MILK")!;
    expect([milk.depth, milk.nameAr, milk.path.map((p) => p.code)]).toEqual([
      1,
      "حليب",
      ["DAIRY", "DAI-MILK"],
    ]);
    expect(tree.find((c) => c.code === "HOT-TEA")!.path.map((p) => p.code)).toEqual([
      "BEV",
      "HOT",
      "HOT-TEA",
    ]);

    const before = await getDb().productCategory.count({
      where: { organizationId: ctx.organizationId },
    });
    const bad = [
      "code,name,parent_code",
      "DAIRY,Dairy again,", // exists
      "NEW1,New,NOPE", // unknown parent
      "LOOP-A,A,LOOP-B",
      "LOOP-B,B,LOOP-A",
      "DEEP,Deep,COF", // fourth level
      "NEW1,Twice,", // duplicate in file
    ].join("\n");
    const r = await importCategories(ctx, bad);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => `${e.row}:${e.message}`)).toEqual([
      "1:categoryCodeTaken",
      "6:categoryDuplicateInFile",
      "2:categoryUnknownParent",
    ]);
    // Fix those rows: the loop and the depth are then reported.
    const second = await importCategories(
      ctx,
      ["code,name,parent_code", "LOOP-A,A,LOOP-B", "LOOP-B,B,LOOP-A", "DEEP,Deep,COF"].join("\n"),
    );
    expect(second.errors.map((e) => `${e.row}:${e.message}`)).toEqual([
      "1:CATEGORY_LOOP",
      "2:CATEGORY_LOOP",
      "3:CATEGORY_TOO_DEEP",
    ]);
    expect(
      await getDb().productCategory.count({ where: { organizationId: ctx.organizationId } }),
    ).toBe(before);
    expect((await importCategories(ctx, "name\nX")).errors[0]).toMatchObject({
      message: "csvMissingColumn",
    });
  });

  it("keeps organizations apart", async () => {
    const other = (await createTenant("category-tree-other")).ctx;
    const bev = (await listCategories(ctx)).find((c) => c.code === "BEV")!.id;
    await expectAppError(
      createCategory(other, { code: "X", name: "X", parentId: bev }),
      "NOT_FOUND",
    );
    const r = await importCategories(other, "code,name,parent_code\nX,X,BEV");
    expect(r.errors[0]).toMatchObject({ message: "categoryUnknownParent" });
  });
});
