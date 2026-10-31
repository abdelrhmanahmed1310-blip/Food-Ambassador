import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { createProduct, listUnits } from "@/modules/catalog/service";
import {
  postAdjustment,
  postOpeningBalance,
  postWriteOff,
  reverseDocument,
} from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { importSales } from "@/modules/sales/imports";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  exportBranchComparisonCsv,
  exportWasteCsv,
  foodCostReport,
  foodCostTrend,
  wasteReport,
} from "./service";

let ctx: TenantContext;
let units: Record<string, string>;
let zam: string; // warehouse in branch ZAM
let maa: string; // warehouse in branch MAA
let maaBranch: string;
let water: string; // each, cost 5
let juice: string; // each, cost 10

const csv = (rows: string[]) =>
  ["date,external_id,item_code,item_type,quantity,net_amount", ...rows].join("\n");
let today: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("reports"));
  today = businessDate(ctx.timeZone);
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const zamBranch = (await createBranch(ctx, { code: "ZAM", name: "Zamalek", type: "RESTAURANT" }))
    .id;
  maaBranch = (await createBranch(ctx, { code: "MAA", name: "Maadi", type: "RESTAURANT" })).id;
  zam = (
    await createWarehouse(ctx, {
      branchId: zamBranch,
      code: "ZK",
      name: "Zamalek kitchen",
      type: "KITCHEN_STORE",
    })
  ).id;
  maa = (
    await createWarehouse(ctx, {
      branchId: maaBranch,
      code: "MK",
      name: "Maadi kitchen",
      type: "KITCHEN_STORE",
    })
  ).id;
  water = (
    await createProduct(ctx, {
      sku: "WATER",
      nameEn: "Water",
      type: "FINISHED_GOOD",
      baseUomId: units.each,
    })
  ).id;
  juice = (
    await createProduct(ctx, {
      sku: "JUICE",
      nameEn: "Juice",
      type: "FINISHED_GOOD",
      baseUomId: units.each,
    })
  ).id;
  for (const [wh, productId, cost] of [
    [zam, water, "5"],
    [zam, juice, "10"],
    [maa, water, "5"],
  ] as const)
    await postOpeningBalance(ctx, {
      warehouseId: wh,
      productId,
      quantity: "100",
      uomId: units.each,
      unitCost: cost,
    });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("reports", () => {
  it("reports waste and stock differences net of reversals", async () => {
    await postWriteOff(ctx, {
      warehouseId: zam,
      productId: water,
      quantity: "4",
      uomId: units.each,
      stockStatus: "AVAILABLE",
      reasonCode: "DAMAGED",
    });
    await postWriteOff(ctx, {
      warehouseId: zam,
      productId: juice,
      quantity: "2",
      uomId: units.each,
      stockStatus: "AVAILABLE",
      reasonCode: "EXPIRED",
    });
    const wrong = await postWriteOff(ctx, {
      warehouseId: maa,
      productId: water,
      quantity: "10",
      uomId: units.each,
      stockStatus: "AVAILABLE",
      reasonCode: "SPOILED",
    });
    await reverseDocument(ctx, wrong.documentId, { reasonCode: "ENTERED_IN_ERROR" });
    await postAdjustment(ctx, {
      warehouseId: maa,
      productId: water,
      direction: "DECREASE",
      quantity: "3",
      uomId: units.each,
      reasonCode: "DATA_CORRECTION",
    });
    await postAdjustment(ctx, {
      warehouseId: zam,
      productId: juice,
      direction: "INCREASE",
      quantity: "1",
      uomId: units.each,
      reasonCode: "FOUND_STOCK",
    });

    const r = await wasteReport(ctx, { from: today, to: today });
    expect(r.total.WASTE.toFixed()).toBe("40"); // 4 × 5 + 2 × 10; the reversed write-off nets to zero
    expect(r.total.DIFFERENCE.toFixed()).toBe("5"); // 3 × 5 lost − 1 × 10 found
    expect(r.byReason.map((b) => [b.kind, b.reason, b.value.toFixed()])).toEqual([
      ["WASTE", "DAMAGED", "20"],
      ["WASTE", "EXPIRED", "20"],
      ["DIFFERENCE", "DATA_CORRECTION", "15"],
      ["DIFFERENCE", "FOUND_STOCK", "-10"],
    ]);
    expect(r.rows.find((x) => x.reason === "DAMAGED")).toMatchObject({
      quantity: expect.anything(),
      warehouse: { code: "ZK" },
    });
    expect(
      (
        await wasteReport(ctx, { from: today, to: today }, { warehouseId: maa })
      ).total.WASTE.toFixed(),
    ).toBe("0");
    expect((await wasteReport(ctx, { from: "2020-01-01", to: "2020-01-31" })).rows).toEqual([]);
    const rows = parseCsv(
      (await exportWasteCsv(ctx, { from: today, to: today })).replace(/^﻿/, ""),
    );
    expect(rows[0]).toEqual([
      "kind",
      "warehouse",
      "sku",
      "product",
      "reason",
      "quantity",
      "unit",
      "value",
      "cost_missing",
    ]);
    await expectAppError(wasteReport(ctx, { from: today, to: "2020-01-01" }), "VALIDATION_FAILED");
  });

  it("computes actual food cost per branch from imports inside the period, with losses", async () => {
    // Zamalek: 10 water (cost 50) for 200 net; Maadi: 20 water (cost 100) for 250.
    await importSales(ctx, {
      warehouseId: zam,
      text: csv(["2026-10-05,Z-1,WATER,PRODUCT,10,200"]),
    });
    await importSales(ctx, {
      warehouseId: maa,
      text: csv(["2026-10-06,M-1,WATER,PRODUCT,20,250"]),
    });
    // Spans September and October: listed, not counted in October.
    await importSales(ctx, {
      warehouseId: zam,
      text: csv(["2026-09-30,Z-2,JUICE,PRODUCT,1,30", "2026-10-01,Z-3,JUICE,PRODUCT,1,30"]),
    });
    const r = await foodCostReport(ctx, { from: "2026-10-01", to: "2026-10-31" });
    const fig = (code: string) => r.branches.find((b) => b.branch.code === code)!;
    expect([
      fig("ZAM").imports,
      fig("ZAM").net?.toFixed(),
      fig("ZAM").cost.toFixed(),
      fig("ZAM").foodCost?.toFixed(),
    ]).toEqual([1, "200", "50", "0.25"]);
    expect(fig("MAA").foodCost?.toFixed()).toBe("0.4");
    expect(r.total.foodCost?.toFixed(4)).toBe("0.3333");
    expect(r.straddling.map((s) => [s.firstSale, s.lastSale])).toEqual([
      ["2026-09-30", "2026-10-01"],
    ]);
    // Waste and differences dated today are only in a period that includes today.
    const now = await foodCostReport(ctx, { from: today, to: today });
    expect(now.branches.find((b) => b.branch.code === "ZAM")?.waste.toFixed()).toBe("40");
    expect(now.total.foodCost).toBeNull(); // no imports dated today

    const trend = await foodCostTrend(ctx, 24);
    const zamRow = trend.rows.find((x) => x.branch.code === "ZAM")!;
    expect(zamRow.cells.find((c) => c.month === "2026-10")?.foodCost?.toFixed()).toBe("0.25");
    expect(zamRow.cells.find((c) => c.month === "2026-09")?.foodCost).toBeNull();
    const out = parseCsv(
      (await exportBranchComparisonCsv(ctx, { from: "2026-10-01", to: "2026-10-31" })).replace(
        /^﻿/,
        "",
      ),
    );
    expect(out[1].slice(0, 5)).toEqual(["MAA", "1", "250.00", "100.00", "40.00"]);
  });

  it("shows each user only the sites and figures they may see", async () => {
    const analyst = (await addMember(ctx, "analyst")).ctx;
    expect(
      (await foodCostReport(analyst, { from: "2026-10-01", to: "2026-10-31" })).branches,
    ).toHaveLength(2);
    const manager = (
      await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: maaBranch })
    ).ctx;
    // A branch manager sees stock value but not other branches.
    const own = await wasteReport(manager, { from: today, to: today });
    expect(own.warehouses.map((w) => w.code)).toEqual(["MK"]);
    expect(own.total.WASTE.toFixed()).toBe("0");
    const procurement = (await addMember(ctx, "procurement")).ctx;
    await expectAppError(
      foodCostReport(procurement, { from: "2026-10-01", to: "2026-10-31" }),
      "FORBIDDEN",
    );
    const other = await createTenant("reports-other");
    expect(
      (await foodCostReport(other.ctx, { from: "2026-10-01", to: "2026-10-31" })).branches,
    ).toEqual([]);
  });
});
