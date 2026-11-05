import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { addConversion, createProduct, createUnit, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { postDocument, type PostingLine } from "@/modules/inventory/posting";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { getOrder } from "@/modules/procurement/orders";
import { createOrdersFromPlan, reorderPlan, saveReorderRule } from "@/modules/procurement/reorder";
import { updateProcurementSettings } from "@/modules/procurement/settings";
import { createSupplier, saveSupplierProduct } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { exportForecastCsv, warehouseForecast } from "./demand";

/** Demand forecasts and forecast-based orders (ADR-120). */

let ctx: TenantContext;
let units: Record<string, string>;
let main: string;
let bar: string;
let flour: string; // kg, bought in 25 kg sacks, 3 days lead time
let sugar: string; // kg, supplier without a lead time
let fresh: string; // kg, stocked today only
let today: string;
/** Weekdays 10 kg, Friday and Saturday (the Cairo weekend) 30 kg. */
const usage = (date: string): number =>
  [5, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) ? 30 : 10;

let seq = 0;
/** Post a movement on a past business day (services always post now). */
async function postOn(
  date: string,
  lines: Array<
    Omit<
      PostingLine,
      "postingKey" | "enteredUomId" | "locationId" | "lotId" | "stockStatus" | "enteredQuantity"
    >
  >,
) {
  await withTenantTx(ctx.organizationId, (tx) =>
    postDocument(
      tx,
      ctx,
      {
        type:
          lines[0].movementType === "TRANSFER_OUT"
            ? "TRANSFER"
            : (lines[0].movementType as "CONSUMPTION" | "WRITE_OFF"),
        warehouseId: lines[0].warehouseId,
        ...(lines[0].movementType === "TRANSFER_OUT" ? { destinationWarehouseId: bar } : {}),
        occurredAt: new Date(`${date}T10:00:00Z`), // noon in Cairo
      },
      lines.map((l) => ({
        ...l,
        locationId: null,
        lotId: null,
        stockStatus: "AVAILABLE" as const,
        enteredQuantity: l.quantityDelta,
        enteredUomId: units.kg,
        postingKey: `forecast-test:${++seq}`,
      })),
      { year: Number(date.slice(0, 4)) },
    ),
  );
}

beforeAll(async () => {
  ({ ctx } = await createTenant("forecast"));
  today = businessDate(ctx.timeZone);
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  units.sack = (
    await createUnit(ctx, { code: "sack", nameEn: "Sack", nameAr: "شوال", dimension: "COUNT" })
  ).id;
  const branchId = (
    await createBranch(ctx, { code: "CK", name: "Kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  main = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  bar = (await createWarehouse(ctx, { branchId, code: "BAR", name: "Bar", type: "BAR" })).id;
  const product = (sku: string) =>
    createProduct(ctx, { sku, nameEn: sku, type: "RAW_MATERIAL", baseUomId: units.kg }).then(
      (p) => p.id,
    );
  flour = await product("FLOUR");
  sugar = await product("SUGAR");
  fresh = await product("FRESH");
  await addConversion(ctx, flour, { uomId: units.sack, factorToBase: "25" });
  const mills = (await createSupplier(ctx, { code: "MILLS", name: "Mills" })).id;
  await saveSupplierProduct(ctx, mills, {
    productId: flour,
    purchaseUomId: units.sack,
    lastUnitPrice: "300",
    leadTimeDays: "3",
  });
  await saveSupplierProduct(ctx, mills, {
    productId: sugar,
    purchaseUomId: units.kg,
    lastUnitPrice: "9",
  });
  await saveSupplierProduct(ctx, mills, {
    productId: fresh,
    purchaseUomId: units.kg,
    lastUnitPrice: "5",
    leadTimeDays: "1",
  });
  for (const [productId, quantity] of [
    [flour, "2000"],
    [sugar, "100"],
    [fresh, "10"],
  ] as const)
    await postOpeningBalance(ctx, {
      warehouseId: main,
      productId,
      quantity,
      uomId: units.kg,
      unitCost: "10",
    });
  for (const productId of [flour, sugar, fresh])
    await saveReorderRule(ctx, {
      warehouseId: main,
      productId,
      uomId: units.kg,
      minQuantity: "5",
      maxQuantity: "50",
    });

  // Six weeks of use, a transfer to the bar and a write-off.
  for (let back = 42; back >= 1; back--) {
    const date = addDays(today, -back);
    await postOn(date, [
      {
        movementType: "CONSUMPTION",
        warehouseId: main,
        productId: flour,
        quantityDelta: new Decimal(-usage(date)),
      },
    ]);
  }
  await postOn(addDays(today, -40), [
    {
      movementType: "CONSUMPTION",
      warehouseId: main,
      productId: sugar,
      quantityDelta: new Decimal(-4),
    },
  ]);
  await postOn(addDays(today, -3), [
    {
      movementType: "WRITE_OFF",
      warehouseId: main,
      productId: flour,
      quantityDelta: new Decimal(-7),
    },
  ]);
}, 180_000);

afterAll(async () => {
  await getDb().$disconnect();
});

describe("demand forecasts (ADR-120)", () => {
  it("reads demand from use and transfers out, not write-offs or transfers in", async () => {
    // Before the six weeks of use, so it does not disturb the forecast scores.
    await postOn(addDays(today, -43), [
      {
        movementType: "TRANSFER_OUT",
        warehouseId: main,
        productId: flour,
        quantityDelta: new Decimal(-20),
      },
      {
        movementType: "TRANSFER_IN",
        warehouseId: bar,
        productId: flour,
        quantityDelta: new Decimal(20),
      },
    ]);
    const f = await warehouseForecast(ctx, main);
    expect(f.rows.map((r) => [r.product.sku, r.result.status])).toEqual([
      ["FLOUR", "OK"],
      ["FRESH", "SHORT_HISTORY"],
      ["SUGAR", "OK"],
    ]);
    const row = f.rows.find((r) => r.product.sku === "FLOUR")!;
    const lastWeek = Array.from({ length: 7 }, (_, i) => usage(addDays(today, -7 + i))).reduce(
      (a, b) => a + b,
    );
    expect(row.weeks.at(-1)!.toFixed()).toBe(String(lastWeek));
    // The week of the transfer holds only the 20 kg sent to the bar; the write-off is not demand.
    expect(row.weeks.map((w) => w.toFixed())).toEqual([
      "0",
      "20",
      ...Array.from({ length: 6 }, (_, k) =>
        String(
          Array.from({ length: 7 }, (_, i) => usage(addDays(today, -42 + k * 7 + i))).reduce(
            (a, b) => a + b,
          ),
        ),
      ),
    ]);
    expect(row.historyDays).toBe(43);
    // The bar received flour but used none.
    expect((await warehouseForecast(ctx, bar)).rows).toEqual([]);
  });

  it("chooses the method that would have been most accurate and shows its error", async () => {
    const row = (await warehouseForecast(ctx, main)).rows.find((r) => r.product.sku === "FLOUR")!;
    if (row.result.status !== "OK") throw new Error("expected a forecast");
    expect(row.result.method).toBe("SAME_WEEKDAY");
    expect(row.result.scores.map((s) => s.method)).toEqual([
      "MOVING_AVERAGE_28",
      "MOVING_AVERAGE_7",
      "SAME_WEEKDAY",
    ]);
    const next7 = Array.from({ length: 7 }, (_, i) => usage(addDays(today, i))).reduce(
      (a, b) => a + b,
    );
    expect(row.next7?.toFixed()).toBe(String(next7));
    const csv = await exportForecastCsv(ctx, main);
    expect(csv.split("\n")[0]).toContain("average_daily_28d,method,wape");
    expect(csv).toContain("FLOUR,FLOUR,kg");
    expect(csv).toContain("SAME_WEEKDAY");
  });

  it("orders forecast demand over lead time and review, never guessing a lead time", async () => {
    const plan = await reorderPlan(ctx, main);
    const line = (sku: string) => plan.lines.find((l) => l.rule.product.sku === sku)!;
    expect(line("FRESH").forecast.reason).toBe("SHORT_HISTORY");
    expect(line("SUGAR").forecast.reason).toBe("NO_LEAD_TIME");
    const f = line("FLOUR");
    expect(f.suggestion).toBeNull(); // plenty above the 5–50 kg par level
    const order = f.forecast.order!;
    expect(order.coverDays).toBe(10); // 3 days lead time + 7 days review
    expect(order.safetyBase.toFixed()).toBe("0"); // the pattern was forecast exactly
    const cover = Array.from({ length: 10 }, (_, i) => usage(addDays(today, i))).reduce(
      (a, b) => a + b,
    );
    expect(order.demandBase.toFixed()).toBe(String(cover));
    expect(order.purchaseUnits).toBeNull(); // 2000 kg less six weeks of use is still enough
  });

  it("turns forecast suggestions into draft orders in purchase units", async () => {
    // Use most of the flour so the forecast calls for more.
    const plan0 = await reorderPlan(ctx, main);
    const left = plan0.lines.find((l) => l.rule.product.sku === "FLOUR")!.availableBase;
    await postOn(addDays(today, -1), [
      {
        movementType: "CONSUMPTION",
        warehouseId: main,
        productId: flour,
        quantityDelta: left.minus(60).negated(),
      },
    ]);
    // The heavy day moves the series, so the target is read back from the plan.
    const line = (await reorderPlan(ctx, main)).lines.find((l) => l.rule.product.sku === "FLOUR")!;
    const order = line.forecast.order!;
    expect(order.projectedBase.toFixed()).toBe("60");
    const sacks = order.targetBase.minus(60).dividedBy(25).toDecimalPlaces(0, Decimal.ROUND_UP);
    expect(order.purchaseUnits?.toFixed()).toBe(sacks.toFixed());

    // The par level asks for nothing more than 50 kg, so min/max orders nothing for flour.
    const byForecast = await createOrdersFromPlan(ctx, main, [line.rule.id], "FORECAST");
    expect(byForecast.skipped).toEqual([]);
    const po = await getOrder(ctx, byForecast.orders[0].id);
    expect(po.lines.map((l) => [l.quantity.toString(), l.unitPrice.toString()])).toEqual([
      [sacks.toFixed(), "300"],
    ]);
    const sugarRule = (await reorderPlan(ctx, main)).lines.find(
      (l) => l.rule.product.sku === "SUGAR",
    )!;
    expect(
      (await createOrdersFromPlan(ctx, main, [sugarRule.rule.id], "FORECAST")).skipped,
    ).toEqual(["SUGAR"]);
    await expectAppError(
      createOrdersFromPlan(ctx, main, [line.rule.id], "GUESS" as "FORECAST"),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("covers the review period and service level the organization sets", async () => {
    await expectAppError(
      updateProcurementSettings(ctx, { forecastReviewDays: "14", forecastServiceLevel: "0.97" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      updateProcurementSettings(ctx, { forecastReviewDays: "0" }),
      "VALIDATION_FAILED",
    );
    await updateProcurementSettings(ctx, {
      forecastReviewDays: "14",
      forecastServiceLevel: "0.99",
    });
    const line = (await reorderPlan(ctx, main)).lines.find((l) => l.rule.product.sku === "FLOUR")!;
    expect(line.forecast.order?.coverDays).toBe(17);
  });

  it("is for those who buy for the warehouse, within the organization", async () => {
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(warehouseForecast(cashier.ctx, main), "NOT_FOUND");
    const { ctx: other } = await createTenant("forecast-other");
    await expectAppError(warehouseForecast(other, main), "NOT_FOUND");
  });
});
