import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { addRecipePrice, foodCostReport, setRecipeTaxCode } from "@/modules/recipes/menu";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { getSalesImport, importSales } from "@/modules/sales/imports";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addTaxRate,
  applyCountryPreset,
  getTaxSetup,
  updateTaxSettings,
  vatSummary,
} from "./service";

let ctx: TenantContext;
let units: Record<string, string>;
let kitchen: string;
let water: string;
let salad: string;
const codes: Record<string, string> = {};
const csv = (rows: string[]) =>
  ["date,external_id,item_code,quantity,net_amount,gross_amount,tax_code", ...rows].join("\n");

beforeAll(async () => {
  ({ ctx } = await createTenant("vat"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  water = (
    await createProduct(ctx, {
      sku: "WATER",
      nameEn: "Water",
      type: "FINISHED_GOOD",
      baseUomId: units.each,
    })
  ).id;
  const tomato = (
    await createProduct(ctx, {
      sku: "TOMATO",
      nameEn: "Tomato",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: kitchen,
    productId: water,
    quantity: "100",
    uomId: units.each,
    unitCost: "1",
  });
  await postOpeningBalance(ctx, {
    warehouseId: kitchen,
    productId: tomato,
    quantity: "50",
    uomId: units.kg,
    unitCost: "10",
  });
  const r = (await createRecipe(ctx, {
    code: "SALAD",
    name: "Salad",
    type: "DISH",
    yieldQuantity: "1",
    yieldUomId: units.each,
    portions: "1",
  }))!;
  await addIngredient(ctx, r.versionId, {
    item: `product:${tomato}`,
    quantity: "0.5",
    uomId: units.kg,
  });
  await activateVersion(ctx, r.versionId);
  salad = r.id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("VAT setup", () => {
  it("applies the Saudi preset with its rate history, idempotently", async () => {
    await applyCountryPreset(ctx, "SA");
    await applyCountryPreset(ctx, "SA");
    const setup = await getTaxSetup(ctx);
    for (const c of setup.codes) codes[c.code] = c.id;
    expect(setup.codes.map((c) => c.code)).toEqual(["EXEMPT", "OOS", "STD", "ZERO"]);
    const std = setup.codes.find((c) => c.code === "STD")!;
    expect(
      std.rates.map((r) => [r.effectiveFrom.toISOString().slice(0, 10), r.rate.toFixed()]),
    ).toEqual([
      ["2020-07-01", "0.15"],
      ["2018-01-01", "0.05"],
    ]);
    expect(setup.settings).toMatchObject({
      country: "SA",
      pricesIncludeTax: true,
      vatRegistered: false,
      defaultSalesTaxCodeId: std.id,
    });
  });

  it("validates registration per country and keeps rate history append-only", async () => {
    const base = {
      country: "SA",
      vatRegistered: "on",
      pricesIncludeTax: "on",
      defaultSalesTaxCodeId: codes.STD,
      defaultPurchaseTaxCodeId: codes.STD,
    };
    await expectAppError(
      updateTaxSettings(ctx, { ...base, vatNumber: "123456789012345" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      updateTaxSettings(ctx, { ...base, vatNumber: "" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      updateTaxSettings(ctx, { ...base, country: "QA", vatNumber: "12345" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await updateTaxSettings(ctx, { ...base, vatNumber: "310 1223 9350 0003" });
    expect((await getTaxSetup(ctx)).settings?.vatNumber).toBe("310122393500003");
    await addTaxRate(ctx, codes.STD, {
      ratePercent: "16",
      effectiveFrom: "2099-01-01",
      source: "Hypothetical change for the test",
    });
    await expectAppError(
      addTaxRate(ctx, codes.STD, { ratePercent: "17", effectiveFrom: "2099-01-01" }),
      "CONFLICT",
    );
    await expectAppError(
      addTaxRate(ctx, codes.ZERO, { ratePercent: "5", effectiveFrom: "2030-01-01" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expect(
      getDb().taxRate.updateMany({ where: { taxCodeId: codes.STD }, data: { rate: "0.2" } }),
    ).rejects.toThrow();
    const finance = await addMember(ctx, "finance");
    await expectAppError(
      updateTaxSettings(finance.ctx, { ...base, vatNumber: "310122393500003" }),
      "FORBIDDEN",
    );
  });

  it("works out VAT per sale line at the rate on the sale date", async () => {
    const r = await importSales(ctx, {
      warehouseId: kitchen,
      text: csv([
        "2026-11-01,V-1,WATER,1,,11.50,",
        "2026-11-01,V-2,SALAD,2,100,,",
        "2019-06-01,V-3,WATER,1,,10.50,",
        "2026-11-01,V-4,WATER,1,20,,EXEMPT",
      ]),
    });
    expect(r).toMatchObject({ ok: true, imported: 4 });
    const imp = await getSalesImport(ctx, r.importId!);
    const lines = Object.fromEntries(
      imp.lines.map((l) => [
        l.externalId,
        [
          l.netAmount?.toFixed(),
          l.taxAmount?.toFixed(),
          l.grossAmount?.toFixed(),
          l.taxRate?.toFixed(),
        ],
      ]),
    );
    expect(lines).toEqual({
      "V-1": ["10", "1.5", "11.5", "0.15"],
      "V-2": ["100", "15", "115", "0.15"],
      "V-3": ["10", "0.5", "10.5", "0.05"],
      "V-4": ["20", "0", "20", "0"],
    });
    expect([
      imp.netAmount?.toFixed(),
      imp.taxAmount?.toFixed(),
      imp.grossAmount?.toFixed(),
    ]).toEqual(["140", "17", "157"]);
    const summary = await vatSummary(ctx, { from: "2026-11-01", to: "2026-11-30" });
    expect(summary.map((s) => [s.code?.code, s.tax?.toFixed()]).sort()).toEqual([
      ["EXEMPT", "0"],
      ["STD", "16.5"],
    ]);

    const bad = await importSales(ctx, {
      warehouseId: kitchen,
      text: csv([
        "2026-11-01,V-9,WATER,1,10,11.5,",
        "2026-11-01,V-10,WATER,1,10,,NOPE",
        "2017-01-01,V-11,WATER,1,10,,",
      ]),
    });
    expect(bad.errors.map((e) => e.message)).toEqual(["netOrGross", "unknownTaxCode", "noTaxRate"]);
  });

  it("uses the net price for food cost when prices include VAT", async () => {
    const today = businessDate("Africa/Cairo");
    await addRecipePrice(ctx, salad, { price: "23", effectiveFrom: addDays(today, -1) });
    let row = (await foodCostReport(ctx, {})).rows.find((x) => x.recipe.id === salad)!;
    // 23 incl. 15 % = 20 net; cost 0.5 kg × 10 = 5 → 25 %.
    expect([
      row.price?.entered.toFixed(),
      row.price?.includesTax,
      row.price?.net?.toFixed(),
      row.fraction?.toFixed(),
    ]).toEqual(["23", true, "20", "0.25"]);
    await setRecipeTaxCode(ctx, salad, codes.ZERO);
    row = (await foodCostReport(ctx, {})).rows.find((x) => x.recipe.id === salad)!;
    expect(row.price?.net?.toFixed()).toBe("23");
  });

  it("charges no VAT when the organization is not registered (Egypt preset, unregistered)", async () => {
    const eg = await createTenant("vat-eg");
    await applyCountryPreset(eg.ctx, "EG");
    const setup = await getTaxSetup(eg.ctx);
    expect(setup.codes.find((c) => c.code === "STD")?.rates[0].rate.toFixed()).toBe("0.14");
    expect(setup.settings?.vatRegistered).toBe(false);
    const qa = await createTenant("vat-qa");
    expect((await applyCountryPreset(qa.ctx, "QA")).vatInForce).toBe(false);
    expect((await getTaxSetup(qa.ctx)).codes).toEqual([]);
    await expectAppError(applyCountryPreset(qa.ctx, "FR"), "BUSINESS_RULE_VIOLATION");
  });
});
