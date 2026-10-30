import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { addStandardCost } from "./costs";
import {
  addRecipePrice,
  bulkReplaceIngredient,
  foodCostReport,
  listRecipePrices,
  recipesUsingProduct,
  setRecipeTarget,
  simulatePrice,
  updateRecipeSettings,
} from "./menu";
import {
  activateVersion,
  addIngredient,
  createDraftVersion,
  createRecipe,
  getRecipe,
  getVersion,
  updateVersion,
} from "./recipes";

let ctx: TenantContext;
let units: Record<string, string>;
let warehouseId: string;
const ids: Record<string, string> = {};
// Dates in the organization's time zone, as the services use them.
const today = businessDate("Africa/Cairo");
const yesterday = addDays(today, -1);
const nextWeek = addDays(today, 7);

async function recipe(
  code: string,
  type: "DISH" | "PREPARATION",
  yieldQuantity: string,
  yieldUom: string,
  lines: Array<[string, string, string]>,
) {
  const created = await createRecipe(ctx, {
    code,
    name: code,
    type,
    yieldQuantity,
    yieldUomId: units[yieldUom],
    portions: type === "DISH" ? yieldQuantity : undefined,
  });
  for (const [item, quantity, uom] of lines)
    await addIngredient(ctx, created!.versionId, {
      item,
      quantity,
      uomId: units[uom],
      wastePercent: item === `product:${ids.tomato}` && code === "SAUCE" ? "20" : undefined,
    });
  await activateVersion(ctx, created!.versionId);
  ids[code] = created!.id;
}

const row = (report: Awaited<ReturnType<typeof foodCostReport>>, code: string) =>
  report.rows.find((r) => r.recipe.code === code)!;

beforeAll(async () => {
  ({ ctx } = await createTenant("menu"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "HQ", name: "HQ", type: "RESTAURANT" })).id;
  warehouseId = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" }))
    .id;
  for (const [sku, uom] of [
    ["tomato", "kg"],
    ["oil", "l"],
    ["butter", "kg"],
    ["margarine", "kg"],
  ])
    ids[sku] = (
      await createProduct(ctx, {
        sku: sku.toUpperCase(),
        nameEn: sku,
        type: "RAW_MATERIAL",
        baseUomId: units[uom],
      })
    ).id;
  await postOpeningBalance(ctx, {
    warehouseId,
    productId: ids.tomato,
    quantity: "10",
    uomId: units.kg,
    unitCost: "20",
  });
  await addStandardCost(ctx, ids.oil, { unitCost: "80", effectiveFrom: yesterday });
  await addStandardCost(ctx, ids.margarine, { unitCost: "10", effectiveFrom: yesterday });
  // Sauce 68 for 2 kg; pasta 4 portions with 500 g sauce = 4.25; salad 0.5 kg tomato = 10; soup has butter without cost.
  await recipe("SAUCE", "PREPARATION", "2", "kg", [
    [`product:${ids.tomato}`, "2.4", "kg"],
    [`product:${ids.oil}`, "100", "ml"],
  ]);
  await recipe("PASTA", "DISH", "4", "each", [[`recipe:${ids.SAUCE}`, "500", "g"]]);
  await recipe("SALAD", "DISH", "1", "each", [[`product:${ids.tomato}`, "0.5", "kg"]]);
  await recipe("SOUP", "DISH", "1", "each", [[`product:${ids.butter}`, "100", "g"]]);
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("menu pricing and food cost", () => {
  it("keeps price history and uses the price in effect today", async () => {
    await addRecipePrice(ctx, ids.PASTA, { price: "12", effectiveFrom: yesterday });
    await addRecipePrice(ctx, ids.PASTA, { price: "15", effectiveFrom: today });
    await addRecipePrice(ctx, ids.PASTA, { price: "99", effectiveFrom: nextWeek });
    await expectAppError(
      addRecipePrice(ctx, ids.PASTA, { price: "16", effectiveFrom: today }),
      "CONFLICT",
    );
    await expectAppError(
      addRecipePrice(ctx, ids.SAUCE, { price: "5", effectiveFrom: today }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      addRecipePrice(ctx, ids.PASTA, { price: "0", effectiveFrom: today }),
      "VALIDATION_FAILED",
    );
    expect((await listRecipePrices(ctx, ids.PASTA)).map((p) => p.price.toFixed())).toEqual([
      "99",
      "15",
      "12",
    ]);
    const report = await foodCostReport(ctx, {});
    expect(row(report, "PASTA").price?.toFixed()).toBe("15");
  });

  it("classifies dishes against the target and suggests prices", async () => {
    await addRecipePrice(ctx, ids.SALAD, { price: "25", effectiveFrom: today });
    let report = await foodCostReport(ctx, {});
    expect(report.rows.map((r) => r.recipe.code)).toEqual(["PASTA", "SALAD", "SOUP"]);
    expect(row(report, "PASTA").status).toBe("NO_TARGET");
    expect(row(report, "SOUP").status).toBe("INCOMPLETE");

    await updateRecipeSettings(ctx, { targetPercent: "30" });
    report = await foodCostReport(ctx, {});
    const pasta = row(report, "PASTA");
    expect(pasta).toMatchObject({ status: "OK" });
    expect(pasta.costPerPortion.toFixed()).toBe("4.25");
    expect(pasta.fraction?.toFixed()).toBe("0.2833");
    expect(pasta.margin?.toFixed()).toBe("10.75");
    const salad = row(report, "SALAD");
    expect(salad.status).toBe("ABOVE_TARGET");
    expect(salad.suggested?.toFixed()).toBe("33.34");
    expect(row(report, "SOUP").suggested).toBeNull();

    // A recipe's own target wins over the organization's; blank clears it.
    await setRecipeTarget(ctx, ids.SALAD, { targetPercent: "45" });
    expect(row(await foodCostReport(ctx, {}), "SALAD").status).toBe("OK");
    await setRecipeTarget(ctx, ids.SALAD, { targetPercent: "" });
    expect(row(await foodCostReport(ctx, {}), "SALAD").status).toBe("ABOVE_TARGET");
    await expectAppError(updateRecipeSettings(ctx, { targetPercent: "100" }), "VALIDATION_FAILED");
  });

  it("simulates a cost change on the dishes that use the product, storing nothing", async () => {
    const sim = await simulatePrice(ctx, { productId: ids.tomato, unitCost: "30" }, {});
    expect(sim.rows.map((r) => r.recipe.code)).toEqual(["PASTA", "SALAD"]);
    const pasta = sim.rows[0];
    // Sauce becomes 3 × 30 + 8 = 98 per 2 kg; 0.5 kg = 24.5 for 4 portions.
    expect(pasta.before.costPerPortion.toFixed()).toBe("4.25");
    expect(pasta.after.costPerPortion.toFixed()).toBe("6.125");
    expect(pasta.after.status).toBe("ABOVE_TARGET");
    expect(sim.rows[1].change.toFixed()).toBe("5");
    const valuation = await getDb().stockValuation.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, productId: ids.tomato },
    });
    expect(valuation.averageUnitCost?.toFixed()).toBe("20");
    expect(row(await foodCostReport(ctx, {}), "PASTA").costPerPortion.toFixed()).toBe("4.25");
  });

  it("replaces an ingredient across recipes as new versions", async () => {
    expect((await recipesUsingProduct(ctx, ids.tomato)).map((r) => r.code)).toEqual([
      "SALAD",
      "SAUCE",
    ]);
    await createDraftVersion(ctx, ids.SALAD);
    const result = await bulkReplaceIngredient(ctx, [ids.SOUP, ids.SALAD, ids.PASTA], {
      fromProductId: ids.butter,
      toProductId: ids.margarine,
      factor: "1.2",
      activate: "on",
    });
    expect(result.done.map((d) => [d.code, d.activated])).toEqual([["SOUP", true]]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { code: "SALAD", reason: "HAS_DRAFT" },
        { code: "PASTA", reason: "NOT_USED" },
      ]),
    );
    const soup = await getRecipe(ctx, ids.SOUP);
    expect(soup.versions.map((v) => [v.versionNo, v.status])).toEqual([
      [2, "ACTIVE"],
      [1, "RETIRED"],
    ]);
    const v2 = await getVersion(ctx, soup.versions[0].id);
    expect(v2.ingredients[0]).toMatchObject({ productId: ids.margarine });
    expect(v2.ingredients[0].quantity.toFixed()).toBe("120");
    // 0.12 kg × 10 standard = 1.2; the soup now has a complete cost.
    const soupRow = row(await foodCostReport(ctx, {}), "SOUP");
    expect(soupRow.costPerPortion.toFixed()).toBe("1.2");
    expect(soupRow.status).toBe("NO_PRICE");

    const incompatible = await bulkReplaceIngredient(ctx, [ids.SAUCE], {
      fromProductId: ids.tomato,
      toProductId: ids.oil,
      factor: "1",
    });
    expect(incompatible.skipped).toEqual([{ code: "SAUCE", reason: "INCOMPATIBLE_UNITS" }]);
    await expectAppError(
      bulkReplaceIngredient(ctx, [ids.SAUCE], {
        fromProductId: ids.tomato,
        toProductId: ids.tomato,
        factor: "1",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      bulkReplaceIngredient(ctx, [], {
        fromProductId: ids.tomato,
        toProductId: ids.oil,
        factor: "1",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("keeps the method with the version and locks it once active", async () => {
    const draft = (await getRecipe(ctx, ids.SALAD)).versions.find((v) => v.status === "DRAFT")!;
    await updateVersion(ctx, draft.id, {
      yieldQuantity: "1",
      yieldUomId: units.each,
      portions: "1",
      method: "Slice, dress, serve cold.",
    });
    await activateVersion(ctx, draft.id);
    expect((await getVersion(ctx, draft.id)).method).toBe("Slice, dress, serve cold.");
    await expect(
      getDb().recipeVersion.update({ where: { id: draft.id }, data: { method: "Changed" } }),
    ).rejects.toThrow();
  });

  it("limits prices, targets and reports to permitted users of this organization", async () => {
    const kitchen = (await addMember(ctx, "warehouse")).ctx;
    await expectAppError(foodCostReport(kitchen, {}), "FORBIDDEN");
    await expectAppError(
      simulatePrice(kitchen, { productId: ids.tomato, unitCost: "1" }, {}),
      "FORBIDDEN",
    );
    await expectAppError(
      addRecipePrice(kitchen, ids.PASTA, { price: "1", effectiveFrom: today }),
      "FORBIDDEN",
    );
    await expectAppError(updateRecipeSettings(kitchen, { targetPercent: "20" }), "FORBIDDEN");
    const other = await createTenant("menu-other");
    await expectAppError(
      addRecipePrice(other.ctx, ids.PASTA, { price: "1", effectiveFrom: today }),
      "NOT_FOUND",
    );
    await expectAppError(
      setRecipeTarget(other.ctx, ids.PASTA, { targetPercent: "20" }),
      "NOT_FOUND",
    );
    expect((await foodCostReport(other.ctx, {})).rows).toEqual([]);
    expect(await listRecipePrices(other.ctx, ids.PASTA)).toEqual([]);
  });
});
