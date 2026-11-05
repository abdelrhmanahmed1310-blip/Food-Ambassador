import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { postDocument, type PostingLine } from "@/modules/inventory/posting";
import { reconcileBalances } from "@/modules/inventory/queries";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { updateProcurementSettings } from "@/modules/procurement/settings";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { createProductionOrder, productionPlan, setRecipeOutputProduct } from "./service";

/** Forecast batches on the central kitchen's production plan (ADR-121). */

let ctx: TenantContext;
let units: Record<string, string>;
let ck: string;
let zamalek: string;
let maadi: string;
let sauce: string;
let sauceRecipe: string;
let today: string;

type Line = Pick<PostingLine, "movementType" | "warehouseId" | "productId"> & { quantity: number };
let seq = 0;
/** Post a movement on a past business day (services always post now). */
async function postOn(date: string, type: "TRANSFER" | "CONSUMPTION", lines: Line[]) {
  await withTenantTx(ctx.organizationId, (tx) =>
    postDocument(
      tx,
      ctx,
      {
        type,
        warehouseId: lines[0].warehouseId,
        ...(type === "TRANSFER" ? { destinationWarehouseId: lines[1].warehouseId } : {}),
        occurredAt: new Date(`${date}T10:00:00Z`),
      },
      lines.map((l) => ({
        movementType: l.movementType,
        warehouseId: l.warehouseId,
        productId: l.productId,
        locationId: null,
        lotId: null,
        stockStatus: "AVAILABLE" as const,
        quantityDelta: new Decimal(l.quantity),
        enteredQuantity: new Decimal(l.quantity),
        enteredUomId: units.kg,
        postingKey: `production-forecast-test:${++seq}`,
      })),
      { year: Number(date.slice(0, 4)) },
    ),
  );
}

const row = async (options: Record<string, string> = {}, code = "SAUCE") =>
  (await productionPlan(ctx, ck, options)).rows.find((r) => r.recipe.code === code)!;

beforeAll(async () => {
  ({ ctx } = await createTenant("production-forecast"));
  today = businessDate(ctx.timeZone);
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const hq = (
    await createBranch(ctx, { code: "CK", name: "Central kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  const zam = (await createBranch(ctx, { code: "ZAM", name: "Zamalek", type: "RESTAURANT" })).id;
  const maa = (await createBranch(ctx, { code: "MAA", name: "Maadi", type: "RESTAURANT" })).id;
  ck = (await createWarehouse(ctx, { branchId: hq, code: "CK", name: "Kitchen", type: "MAIN" })).id;
  zamalek = (
    await createWarehouse(ctx, {
      branchId: zam,
      code: "ZK",
      name: "Zamalek",
      type: "KITCHEN_STORE",
    })
  ).id;
  maadi = (
    await createWarehouse(ctx, { branchId: maa, code: "MK", name: "Maadi", type: "KITCHEN_STORE" })
  ).id;
  const product = (sku: string, type: "RAW_MATERIAL" | "SEMI_FINISHED") =>
    createProduct(ctx, { sku, nameEn: sku, type, baseUomId: units.kg }).then((p) => p.id);
  const tomato = await product("TOMATO", "RAW_MATERIAL");
  sauce = await product("SAUCE-K", "SEMI_FINISHED");
  const dough = await product("DOUGH-K", "SEMI_FINISHED");
  for (const [code, output] of [
    ["SAUCE", sauce],
    ["DOUGH", dough],
  ] as const) {
    const r = await createRecipe(ctx, {
      code,
      name: code,
      type: "PREPARATION",
      yieldQuantity: "5",
      yieldUomId: units.kg,
    });
    await addIngredient(ctx, r!.versionId, {
      item: `product:${tomato}`,
      quantity: "6",
      uomId: units.kg,
    });
    await activateVersion(ctx, r!.versionId);
    await setRecipeOutputProduct(ctx, r!.id, { productId: output });
    if (code === "SAUCE") sauceRecipe = r!.id;
  }

  // The kitchen sends Zamalek 10 kg a day; Zamalek uses 8 kg and Maadi,
  // stocked once, 4 kg a day, for six weeks.
  await postOpeningBalance(ctx, {
    warehouseId: ck,
    productId: sauce,
    quantity: "500",
    uomId: units.kg,
    unitCost: "30",
  });
  await postOpeningBalance(ctx, {
    warehouseId: maadi,
    productId: sauce,
    quantity: "200",
    uomId: units.kg,
    unitCost: "30",
  });
  for (let back = 42; back >= 1; back--) {
    const date = addDays(today, -back);
    await postOn(date, "TRANSFER", [
      { movementType: "TRANSFER_OUT", warehouseId: ck, productId: sauce, quantity: -10 },
      { movementType: "TRANSFER_IN", warehouseId: zamalek, productId: sauce, quantity: 10 },
    ]);
    await postOn(date, "CONSUMPTION", [
      { movementType: "CONSUMPTION", warehouseId: zamalek, productId: sauce, quantity: -8 },
    ]);
    await postOn(date, "CONSUMPTION", [
      { movementType: "CONSUMPTION", warehouseId: maadi, productId: sauce, quantity: -4 },
    ]);
  }
}, 240_000);

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
  await getDb().$disconnect();
});

describe("forecast batches (ADR-121)", () => {
  it("forecasts what leaves the kitchen and plans whole batches over the cover", async () => {
    // 10 kg a day leaves the kitchen; 80 kg is left there.
    let r = await row();
    expect(r.usable.toFixed()).toBe("80");
    expect(r.forecast.status).toBe("OK");
    if (r.forecast.status !== "OK") return;
    expect([r.forecast.method, r.forecast.wape?.toFixed()]).toEqual(["MOVING_AVERAGE_28", "0"]);
    expect([r.forecast.demand.toFixed(), r.forecast.batches.toFixed()]).toEqual(["20", "0"]);

    r = await row({ coverDays: "14" });
    if (r.forecast.status !== "OK") throw new Error("expected a forecast");
    // 140 kg over 14 days − 80 kg = 60 kg → 12 batches of 5 kg.
    expect([
      r.forecast.demand.toFixed(),
      r.forecast.safety.toFixed(),
      r.forecast.batches.toFixed(),
      r.forecast.suggestedQuantity.toFixed(),
    ]).toEqual(["140", "0", "12", "60"]);
    // The requisition-based plan sees no open requests and no par level.
    expect(r.batches.toFixed()).toBe("0");
  });

  it("counts batches already planned", async () => {
    await createProductionOrder(ctx, {
      recipeId: sauceRecipe,
      warehouseId: ck,
      plannedQuantity: "10",
    });
    const r = await row({ coverDays: "14" });
    if (r.forecast.status !== "OK") throw new Error("expected a forecast");
    expect(r.forecast.batches.toFixed()).toBe("10");
  });

  it("can plan from what the branches use against the stock they hold", async () => {
    const r = await row({ coverDays: "14", basis: "BRANCHES" });
    if (r.forecast.status !== "OK") throw new Error("expected a forecast");
    // Branches use 12 kg a day (transfers are not use): 168 kg over 14 days,
    // against 80 + 84 + 32 kg held and 10 kg planned.
    expect([
      r.forecast.demand.toFixed(),
      r.forecast.stock.toFixed(),
      r.forecast.batches.toFixed(),
    ]).toEqual(["168", "196", "0"]);
  });

  it("gives no forecast without four weeks of history", async () => {
    const r = await row({}, "DOUGH");
    expect(r.forecast).toEqual({ status: "SHORT_HISTORY", historyDays: 0 });
  });

  it("uses the organization's service level and checks the options", async () => {
    await updateProcurementSettings(ctx, { forecastServiceLevel: "0.99" });
    expect((await productionPlan(ctx, ck)).serviceLevel).toBe("0.99");
    for (const options of [{ coverDays: "0" }, { coverDays: "15" }, { basis: "GUESS" }])
      await expectAppError(productionPlan(ctx, ck, options), "VALIDATION_FAILED");
  });

  it("is for those who see production at the kitchen", async () => {
    const cashier = await addMember(ctx, "cashier");
    await expect(productionPlan(cashier.ctx, ck)).rejects.toThrow();
    const { ctx: other } = await createTenant("production-forecast-other");
    await expectAppError(productionPlan(other, ck), "NOT_FOUND");
  });
});
