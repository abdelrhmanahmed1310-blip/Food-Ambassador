import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance, reverseDocument } from "@/modules/inventory/operations";
import { reconcileBalances } from "@/modules/inventory/queries";
import { reconcileValuations } from "@/modules/inventory/valuation-queries";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { traceLot } from "@/modules/traceability/trace";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { getSalesImport, importSales, listSalesImports, reverseSalesImport } from "./imports";

let ctx: TenantContext;
let units: Record<string, string>;
let kitchen: string;
let otherWh: string;
const ids: Record<string, string> = {};
let oldLot: string;
let newLot: string;

async function onHand(productId: string) {
  const rows = await getDb().stockBalance.findMany({
    where: { organizationId: ctx.organizationId, productId, warehouseId: kitchen },
  });
  return rows.reduce((a, r) => a.plus(r.onHandQuantity.toString()), new Decimal(0)).toFixed();
}
const csv = (rows: string[]) =>
  ["date,external_id,item_code,item_type,quantity,net_amount,channel", ...rows].join("\n");

beforeAll(async () => {
  ({ ctx } = await createTenant("sales"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "ZAM", name: "Zamalek", type: "RESTAURANT" }))
    .id;
  const other = (await createBranch(ctx, { code: "MAA", name: "Maadi", type: "RESTAURANT" })).id;
  kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  otherWh = (
    await createWarehouse(ctx, {
      branchId: other,
      code: "MKIT",
      name: "Maadi kitchen",
      type: "KITCHEN_STORE",
    })
  ).id;
  const make = async (sku: string, baseUomId: string, lotTracking?: string) =>
    (ids[sku] = (
      await createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId, lotTracking })
    ).id);
  await make("TOMATO", units.kg);
  await make("OIL", units.l);
  await make("EGG", units.each, "LOT_AND_EXPIRY");
  await make("WATER", units.each);
  await postOpeningBalance(ctx, {
    warehouseId: kitchen,
    productId: ids.TOMATO,
    quantity: "10",
    uomId: units.kg,
    unitCost: "20",
  });
  await postOpeningBalance(ctx, {
    warehouseId: kitchen,
    productId: ids.OIL,
    quantity: "2",
    uomId: units.l,
    unitCost: "80",
  });
  await postOpeningBalance(ctx, {
    warehouseId: kitchen,
    productId: ids.WATER,
    quantity: "24",
    uomId: units.each,
    unitCost: "5",
  });
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  await postOpeningBalance(ctx, {
    warehouseId: kitchen,
    productId: ids.EGG,
    lotCode: "E-LATE",
    expiresOn: later,
    quantity: "30",
    uomId: units.each,
    unitCost: "3",
  });
  await postOpeningBalance(ctx, {
    warehouseId: kitchen,
    productId: ids.EGG,
    lotCode: "E-SOON",
    expiresOn: soon,
    quantity: "4",
    uomId: units.each,
    unitCost: "3",
  });
  const lots = await getDb().inventoryLot.findMany({
    where: { organizationId: ctx.organizationId, productId: ids.EGG },
  });
  oldLot = lots.find((l) => l.lotCode === "E-SOON")!.id;
  newLot = lots.find((l) => l.lotCode === "E-LATE")!.id;
  // Sauce: 2 kg from 2.4 kg tomato (20 % waste) + 100 ml oil. Pasta: 4 portions = 500 g sauce + 2 eggs.
  const sauce = (await createRecipe(ctx, {
    code: "SAUCE",
    name: "Sauce",
    type: "PREPARATION",
    yieldQuantity: "2",
    yieldUomId: units.kg,
  }))!;
  await addIngredient(ctx, sauce.versionId, {
    item: `product:${ids.TOMATO}`,
    quantity: "2.4",
    uomId: units.kg,
    wastePercent: "20",
  });
  await addIngredient(ctx, sauce.versionId, {
    item: `product:${ids.OIL}`,
    quantity: "100",
    uomId: units.ml,
  });
  await activateVersion(ctx, sauce.versionId);
  const pasta = (await createRecipe(ctx, {
    code: "PASTA",
    name: "Pasta",
    type: "DISH",
    yieldQuantity: "4",
    yieldUomId: units.each,
    portions: "4",
  }))!;
  await addIngredient(ctx, pasta.versionId, {
    item: `recipe:${sauce.id}`,
    quantity: "500",
    uomId: units.g,
  });
  await addIngredient(ctx, pasta.versionId, {
    item: `product:${ids.EGG}`,
    quantity: "2",
    uomId: units.each,
  });
  await activateVersion(ctx, pasta.versionId);
  ids.PASTA = pasta.id;
  await createRecipe(ctx, {
    code: "SOUP",
    name: "Soup",
    type: "DISH",
    yieldQuantity: "1",
    yieldUomId: units.each,
    portions: "1",
  });
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
  expect(await reconcileValuations(ctx)).toEqual([]);
  await getDb().$disconnect();
});

describe("sales import", () => {
  it("uses stock through recipes, first-expiring lots first, and records the cost", async () => {
    const file = csv([
      "2026-11-01,T-1-1,PASTA,RECIPE,10,1200,dine-in",
      "2026-11-01,T-1-2,WATER,,3,45,",
    ]);
    const r = await importSales(ctx, { warehouseId: kitchen, fileName: "day1.csv", text: file });
    expect(r).toMatchObject({ ok: true, imported: 2, skipped: 0 });
    // 10 portions: 1.875 kg tomato, 0.0625 l oil, 5 eggs (4 from the lot expiring first, then 1); 3 water.
    expect(await onHand(ids.TOMATO)).toBe("8.125");
    expect(await onHand(ids.OIL)).toBe("1.9375");
    expect(await onHand(ids.WATER)).toBe("21");
    const egg = await getDb().stockBalance.findMany({
      where: { organizationId: ctx.organizationId, productId: ids.EGG },
    });
    expect(Object.fromEntries(egg.map((b) => [b.lotId, b.onHandQuantity.toFixed()]))).toEqual({
      [oldLot]: "0",
      [newLot]: "29",
    });
    const imp = await getSalesImport(ctx, r.importId!);
    // 1.875 × 20 + 0.0625 × 80 + 5 × 3 + 3 × 5 = 37.5 + 5 + 15 + 15.
    expect(imp.costAmount?.toFixed()).toBe("72.5");
    expect(imp.netAmount?.toFixed()).toBe("1245");
    expect(imp.lines[0]).toMatchObject({ itemType: "RECIPE", recipeVersion: { versionNo: 1 } });
    // Lot traceability now sees the consumption.
    const trace = await traceLot(ctx, oldLot);
    expect(trace.exits.map((e) => e.movementType)).toEqual(["CONSUMPTION"]);
  });

  it("never posts the same line twice", async () => {
    const again = await importSales(ctx, {
      warehouseId: kitchen,
      text: csv([
        "2026-11-01,T-1-1,PASTA,RECIPE,10,1200,dine-in",
        "2026-11-02,T-2-1,WATER,PRODUCT,1,15,",
      ]),
    });
    expect(again).toMatchObject({ ok: true, imported: 1, skipped: 1 });
    const nothing = await importSales(ctx, {
      warehouseId: kitchen,
      text: csv(["2026-11-02,T-2-1,WATER,PRODUCT,1,15,"]),
    });
    expect(nothing).toMatchObject({ ok: true, imported: 0, skipped: 1, importId: null });
    expect(await onHand(ids.WATER)).toBe("20");
  });

  it("posts nothing when any row or the stock is wrong, and lists every problem", async () => {
    const bad = await importSales(ctx, {
      warehouseId: kitchen,
      text: csv([
        "2026-13-01,T-3-1,PASTA,,1,,",
        "2026-11-03,T-3-2,NOPE,,1,,",
        "2026-11-03,T-3-3,SOUP,,1,,",
        "2026-11-03,T-3-3,WATER,,0,,",
        "2026-11-03,T-3-5,WATER,DISH,1,abc,",
      ]),
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.map((e) => [e.row, e.column, e.message])).toEqual([
      [1, "date", "invalidDate"],
      [2, "item_code", "unknownItem"],
      [3, "item_code", "NO_ACTIVE_VERSION"],
      [4, "external_id", "duplicateInFile"],
      [4, "quantity", expect.any(String)],
      [5, "net_amount", "invalidDecimal"],
      [5, "item_type", "invalidOption"],
    ]);
    const short = await importSales(ctx, {
      warehouseId: kitchen,
      text: csv(["2026-11-03,T-4-1,PASTA,,200,,"]),
    });
    expect(short.ok).toBe(false);
    expect(short.errors.map((e) => [e.message, e.params?.sku])).toEqual(
      expect.arrayContaining([
        ["INSUFFICIENT_STOCK", "TOMATO"],
        ["INSUFFICIENT_STOCK", "EGG"],
      ]),
    );
    expect(await onHand(ids.TOMATO)).toBe("8.125");
    const missing = await importSales(ctx, {
      warehouseId: kitchen,
      text: "date,item_code\n2026-11-01,PASTA",
    });
    expect(missing.errors.map((e) => e.column)).toEqual(["external_id", "quantity"]);
  });

  it("reverses an import, freeing its lines to be imported again", async () => {
    const [latest] = await listSalesImports(ctx);
    await expectAppError(
      reverseDocument(ctx, (await getSalesImport(ctx, latest.id)).documentId, {
        reasonCode: "ENTERED_IN_ERROR",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await reverseSalesImport(ctx, latest.id, { reason: "Wrong day" });
    expect(await onHand(ids.WATER)).toBe("21");
    expect((await getSalesImport(ctx, latest.id)).status).toBe("REVERSED");
    await expectAppError(
      reverseSalesImport(ctx, latest.id, { reason: "Again" }),
      "BUSINESS_RULE_VIOLATION",
    );
    const redo = await importSales(ctx, {
      warehouseId: kitchen,
      text: csv(["2026-11-02,T-2-1,WATER,PRODUCT,1,15,"]),
    });
    expect(redo).toMatchObject({ imported: 1, skipped: 0 });
  });

  it("limits imports to permitted warehouses and keeps tenants apart", async () => {
    const maadi = await addMember(ctx, "branch_manager", {
      scopeType: "BRANCH",
      branchId: (await getDb().warehouse.findUniqueOrThrow({ where: { id: otherWh } })).branchId,
    });
    // Another branch's warehouse is not even visible.
    await expectAppError(
      importSales(maadi.ctx, { warehouseId: kitchen, text: csv(["2026-11-04,T-9-1,WATER,,1,,"]) }),
      "NOT_FOUND",
    );
    expect(await listSalesImports(maadi.ctx)).toEqual([]);
    const finance = await addMember(ctx, "finance");
    expect((await listSalesImports(finance.ctx)).length).toBeGreaterThan(0);
    await expectAppError(
      importSales(finance.ctx, {
        warehouseId: kitchen,
        text: csv(["2026-11-04,T-9-1,WATER,,1,,"]),
      }),
      "FORBIDDEN",
    );
    const kitchenStaff = await addMember(ctx, "warehouse");
    await expectAppError(listSalesImports(kitchenStaff.ctx), "FORBIDDEN");
    const other = await createTenant("sales-other");
    await expectAppError(
      importSales(other.ctx, { warehouseId: kitchen, text: csv(["2026-11-04,T-9-1,WATER,,1,,"]) }),
      "NOT_FOUND",
    );
    const [latest] = await listSalesImports(ctx);
    await expectAppError(getSalesImport(other.ctx, latest.id), "NOT_FOUND");
  });
});
