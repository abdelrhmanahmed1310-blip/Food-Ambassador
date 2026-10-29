import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@/lib/uuid";
import {
  addConversion,
  createProduct,
  createUnit,
  listUnits,
  setProductArchived,
  updateProduct,
} from "@/modules/catalog/service";
import { createBranch } from "@/modules/sites/branches";
import { createLocation, createWarehouse, setWarehouseArchived } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addCountLine,
  createCount,
  getCount,
  postCount,
  recordCountedQuantity,
  submitCount,
} from "./counts";
import {
  postAdjustment,
  postOpeningBalance,
  postStatusChange,
  postTransfer,
  postWriteOff,
  reverseDocument,
} from "./operations";
import { postDocument } from "./posting";
import {
  fefoSuggestions,
  getDocument,
  inventoryDashboard,
  listBalances,
  listMovements,
  reconcileBalances,
} from "./queries";
import { addDays, businessDate } from "./rules";
import { Decimal } from "@/lib/decimal";

let ctx: TenantContext;
let units: Record<string, string>;
let mainWh: string;
let kitchenWh: string;
let shelf: string;
let branchId: string;
let rice: string; // base kg, no lots
let milk: string; // base l, lot + expiry
let eggs: string; // base each, lots; 1 case = 30 each
const today = businessDate("Africa/Cairo");

async function balance(
  productId: string,
  warehouseId: string,
  status = "AVAILABLE",
  lotCode?: string,
) {
  const rows = await getDb().stockBalance.findMany({
    where: {
      organizationId: ctx.organizationId,
      productId,
      warehouseId,
      stockStatus: status as never,
      ...(lotCode ? { lot: { lotCode } } : {}),
    },
  });
  return rows.reduce((sum, r) => sum.plus(r.onHandQuantity.toString()), new Decimal(0)).toFixed();
}

async function lotId(productId: string, lotCode: string) {
  return (
    await getDb().inventoryLot.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, productId, lotCode },
    })
  ).id;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("inventory"));
  const all = await listUnits(ctx);
  units = Object.fromEntries(all.map((u) => [u.code, u.id]));
  units.case = (
    await createUnit(ctx, { code: "case", nameEn: "Case", nameAr: "كرتونة", dimension: "COUNT" })
  ).id;
  branchId = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  mainWh = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  kitchenWh = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  shelf = (
    await createLocation(ctx, mainWh, {
      code: "SHELF-1",
      name: "Shelf",
      temperatureZone: "AMBIENT",
    })
  ).id;
  rice = (
    await createProduct(ctx, {
      sku: "RICE",
      nameEn: "Rice",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  milk = (
    await createProduct(ctx, {
      sku: "MILK",
      nameEn: "Milk",
      nameAr: "حليب",
      type: "RAW_MATERIAL",
      baseUomId: units.l,
      lotTracking: "LOT_AND_EXPIRY",
      storageRequirement: "CHILLED",
    })
  ).id;
  eggs = (
    await createProduct(ctx, {
      sku: "EGGS",
      nameEn: "Eggs",
      type: "RAW_MATERIAL",
      baseUomId: units.each,
      lotTracking: "LOT",
    })
  ).id;
  await addConversion(ctx, eggs, { uomId: units.case, factorToBase: "30" });
});

afterAll(async () => {
  // The ledger must always equal the balances.
  expect(await reconcileBalances(ctx)).toEqual([]);
  await getDb().$disconnect();
});

describe("units", () => {
  it("shows system units to every tenant and custom units only to their owner", async () => {
    const { ctx: other } = await createTenant("units-other");
    const codes = (await listUnits(other)).map((u) => u.code);
    expect(codes).toEqual(expect.arrayContaining(["g", "kg", "l", "ml", "each", "dozen"]));
    expect(codes).not.toContain("case");
    // Another tenant's custom unit cannot be used, even by id.
    await expectAppError(
      createProduct(other, { sku: "X", nameEn: "X", type: "CONSUMABLE", baseUomId: units.case }),
      "NOT_FOUND",
    );
    // The database also refuses it if application checks are bypassed.
    await expect(
      getDb().product.create({
        data: {
          organizationId: other.organizationId,
          sku: "Y",
          nameEn: "Y",
          type: "CONSUMABLE",
          baseUomId: units.case,
          createdByUserId: other.userId,
          updatedByUserId: other.userId,
        },
      }),
    ).rejects.toThrow(/foreign key|another organization/i);
  });
});

describe("opening balances, lots and unit conversion", () => {
  it("posts in base units, keeps what was entered, and records unit cost per base unit", async () => {
    const res = await postOpeningBalance(ctx, {
      warehouseId: mainWh,
      productId: rice,
      quantity: "2500",
      uomId: units.g,
      unitCost: "0.05",
    });
    expect(res.number).toMatch(/^OB-\d{4}-\d{6}$/);
    expect(await balance(rice, mainWh)).toBe("2.5");
    const entry = await getDb().inventoryLedgerEntry.findFirstOrThrow({
      where: { documentId: res.documentId },
    });
    expect(entry.enteredQuantity.toString()).toBe("2500");
    expect(entry.quantityDelta.toString()).toBe("2.5");
    expect(entry.unitCost?.toString()).toBe("50"); // 0.05 per g = 50 per kg
  });

  it("rejects incompatible units without a product conversion", async () => {
    await expectAppError(
      postOpeningBalance(ctx, {
        warehouseId: mainWh,
        productId: rice,
        quantity: "1",
        uomId: units.l,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("converts packaging units through product-specific factors", async () => {
    await postOpeningBalance(ctx, {
      warehouseId: mainWh,
      productId: eggs,
      lotCode: "egg-a",
      quantity: "2",
      uomId: units.case,
    });
    expect(await balance(eggs, mainWh, "AVAILABLE", "EGG-A")).toBe("60");
  });

  it("enforces lot rules", async () => {
    await expectAppError(
      postOpeningBalance(ctx, {
        warehouseId: mainWh,
        productId: milk,
        quantity: "1",
        uomId: units.l,
      }),
      "VALIDATION_FAILED",
    ); // lot required
    await expectAppError(
      postOpeningBalance(ctx, {
        warehouseId: mainWh,
        productId: milk,
        lotCode: "M-NOEXP",
        quantity: "1",
        uomId: units.l,
      }),
      "VALIDATION_FAILED",
    ); // expiry required
    await expectAppError(
      postOpeningBalance(ctx, {
        warehouseId: mainWh,
        productId: rice,
        lotCode: "R1",
        quantity: "1",
        uomId: units.kg,
      }),
      "BUSINESS_RULE_VIOLATION",
    ); // not lot-tracked
    await postOpeningBalance(ctx, {
      warehouseId: mainWh,
      productId: milk,
      lotCode: "M-1",
      expiresOn: addDays(today, 3),
      quantity: "10",
      uomId: units.l,
    });
    await expectAppError(
      postOpeningBalance(ctx, {
        warehouseId: mainWh,
        productId: milk,
        lotCode: "M-1",
        expiresOn: addDays(today, 9),
        quantity: "1",
        uomId: units.l,
      }),
      "BUSINESS_RULE_VIOLATION",
    ); // same lot, different expiry
  });

  it("only accepts opening balances before other movements", async () => {
    await postAdjustment(ctx, {
      warehouseId: mainWh,
      productId: rice,
      direction: "DECREASE",
      quantity: "0.5",
      uomId: units.kg,
      reasonCode: "DATA_CORRECTION",
    });
    await expectAppError(
      postOpeningBalance(ctx, {
        warehouseId: mainWh,
        productId: rice,
        quantity: "1",
        uomId: units.kg,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect(await balance(rice, mainWh)).toBe("2");
  });
});

describe("negative stock is impossible", () => {
  it("rejects a decrease beyond available stock and changes nothing", async () => {
    const before = await getDb().inventoryLedgerEntry.count({
      where: { organizationId: ctx.organizationId },
    });
    await expectAppError(
      postAdjustment(ctx, {
        warehouseId: mainWh,
        productId: rice,
        direction: "DECREASE",
        quantity: "2.000001",
        uomId: units.kg,
        reasonCode: "DATA_CORRECTION",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect(await balance(rice, mainWh)).toBe("2");
    expect(
      await getDb().inventoryLedgerEntry.count({ where: { organizationId: ctx.organizationId } }),
    ).toBe(before);
  });

  it("is also enforced by a database constraint", async () => {
    const row = await getDb().stockBalance.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, productId: rice, warehouseId: mainWh },
    });
    await expect(
      getDb()
        .$executeRaw`UPDATE "stock_balances" SET "on_hand_quantity" = -1 WHERE "id" = ${row.id}::uuid`,
    ).rejects.toThrow(/stock_balances_on_hand_ck/);
  });

  it("serializes concurrent issues: exactly the available quantity succeeds", async () => {
    const lot = await postOpeningBalance(ctx, {
      warehouseId: kitchenWh,
      productId: eggs,
      lotCode: "EGG-RACE",
      quantity: "5",
      uomId: units.each,
    });
    expect(lot.number).toBeTruthy();
    const lotRace = await lotId(eggs, "EGG-RACE");
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        postWriteOff(ctx, {
          warehouseId: kitchenWh,
          productId: eggs,
          lotId: lotRace,
          stockStatus: "AVAILABLE",
          quantity: "1",
          uomId: units.each,
          reasonCode: "DAMAGED",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    for (const r of results.filter((r) => r.status === "rejected"))
      expect((r as PromiseRejectedResult).reason.details?.rule).toBe("INSUFFICIENT_STOCK");
    expect(await balance(eggs, kitchenWh, "AVAILABLE", "EGG-RACE")).toBe("0");
  });

  it("does not deadlock on concurrent transfers in opposite directions", async () => {
    await postOpeningBalance(ctx, {
      warehouseId: kitchenWh,
      productId: rice,
      quantity: "10",
      uomId: units.kg,
    });
    const transfers = Array.from({ length: 8 }, (_, i) =>
      postTransfer(
        ctx,
        i % 2 === 0
          ? {
              warehouseId: mainWh,
              productId: rice,
              toWarehouseId: kitchenWh,
              quantity: "0.1",
              uomId: units.kg,
            }
          : {
              warehouseId: kitchenWh,
              productId: rice,
              toWarehouseId: mainWh,
              quantity: "0.1",
              uomId: units.kg,
            },
      ),
    );
    const results = await Promise.allSettled(transfers);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await balance(rice, mainWh)).toBe("2");
    expect(await balance(rice, kitchenWh)).toBe("10");
  });
});

describe("duplicate submissions", () => {
  it("returns the original document for a repeated idempotency key", async () => {
    const key = uuidv7();
    const input = {
      warehouseId: mainWh,
      productId: rice,
      direction: "INCREASE",
      quantity: "1",
      uomId: units.kg,
      reasonCode: "FOUND_STOCK",
      idempotencyKey: key,
    };
    const [a, b] = await Promise.all([postAdjustment(ctx, input), postAdjustment(ctx, input)]);
    expect(a.documentId).toBe(b.documentId);
    expect(await getDb().inventoryLedgerEntry.count({ where: { documentId: a.documentId } })).toBe(
      1,
    );
    expect(await balance(rice, mainWh)).toBe("3");
  });

  it("rejects re-posting the same posting key", async () => {
    const lineFor = (key: string) => ({
      movementType: "ADJUSTMENT" as const,
      warehouseId: mainWh,
      locationId: null,
      productId: rice,
      lotId: null,
      stockStatus: "AVAILABLE" as const,
      quantityDelta: new Decimal("1"),
      enteredQuantity: new Decimal("1"),
      enteredUomId: units.kg,
      postingKey: key,
    });
    const key = `test:${uuidv7()}`;
    await withTenantTx(ctx.organizationId, (tx) =>
      postDocument(tx, ctx, { type: "ADJUSTMENT", warehouseId: mainWh }, [lineFor(key)], {
        year: 2026,
      }),
    );
    await expectAppError(
      withTenantTx(ctx.organizationId, (tx) =>
        postDocument(tx, ctx, { type: "ADJUSTMENT", warehouseId: mainWh }, [lineFor(key)], {
          year: 2026,
        }),
      ),
      "CONFLICT",
    );
    await postAdjustment(ctx, {
      warehouseId: mainWh,
      productId: rice,
      direction: "DECREASE",
      quantity: "1",
      uomId: units.kg,
      reasonCode: "DATA_CORRECTION",
    });
    expect(await balance(rice, mainWh)).toBe("3");
  });
});

describe("expiry, quarantine and release", () => {
  let expiredLot: string;
  let freshLot: string;

  beforeAll(async () => {
    await postOpeningBalance(ctx, {
      warehouseId: kitchenWh,
      productId: milk,
      lotCode: "M-OLD",
      expiresOn: addDays(today, -1),
      quantity: "4",
      uomId: units.l,
    });
    await postOpeningBalance(ctx, {
      warehouseId: kitchenWh,
      productId: milk,
      lotCode: "M-NEW",
      expiresOn: addDays(today, 20),
      quantity: "6",
      uomId: units.l,
    });
    await postOpeningBalance(ctx, {
      warehouseId: kitchenWh,
      productId: milk,
      lotCode: "M-TODAY",
      expiresOn: today,
      quantity: "2",
      uomId: units.l,
    });
    expiredLot = await lotId(milk, "M-OLD");
    freshLot = await lotId(milk, "M-NEW");
  });

  it("does not let expired stock be transferred, but allows writing it off", async () => {
    await expectAppError(
      postTransfer(ctx, {
        warehouseId: kitchenWh,
        productId: milk,
        lotId: expiredLot,
        toWarehouseId: mainWh,
        quantity: "1",
        uomId: units.l,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await postWriteOff(ctx, {
      warehouseId: kitchenWh,
      productId: milk,
      lotId: expiredLot,
      stockStatus: "AVAILABLE",
      quantity: "4",
      uomId: units.l,
      reasonCode: "EXPIRED",
    });
    expect(await balance(milk, kitchenWh, "AVAILABLE", "M-OLD")).toBe("0");
  });

  it("treats stock expiring today as usable and suggests lots FEFO", async () => {
    const suggestions = await fefoSuggestions(ctx, kitchenWh, milk);
    expect(suggestions.map((s) => s.lot?.lotCode)).toEqual(["M-TODAY", "M-NEW"]);
  });

  it("excludes quarantined stock from availability; release needs its own permission", async () => {
    await postStatusChange(ctx, {
      warehouseId: kitchenWh,
      productId: milk,
      lotId: freshLot,
      fromStatus: "AVAILABLE",
      toStatus: "QUARANTINE",
      quantity: "6",
      uomId: units.l,
      reasonCode: "TEMPERATURE_EXCURSION",
    });
    expect(await balance(milk, kitchenWh, "QUARANTINE", "M-NEW")).toBe("6");
    // Not available for transfer while quarantined.
    await expectAppError(
      postTransfer(ctx, {
        warehouseId: kitchenWh,
        productId: milk,
        lotId: freshLot,
        toWarehouseId: mainWh,
        quantity: "1",
        uomId: units.l,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    const rows = await listBalances(ctx, {
      productId: milk,
      warehouseId: kitchenWh,
      status: "QUARANTINE",
    });
    expect(rows.items[0].available.toFixed()).toBe("0");

    const warehouseStaff = await addMember(ctx, "warehouse");
    await expectAppError(
      postStatusChange(warehouseStaff.ctx, {
        warehouseId: kitchenWh,
        productId: milk,
        lotId: freshLot,
        fromStatus: "QUARANTINE",
        toStatus: "AVAILABLE",
        quantity: "6",
        uomId: units.l,
        reasonCode: "RELEASED_AFTER_INSPECTION",
      }),
      "FORBIDDEN",
    );
    const qa = await addMember(ctx, "food_safety");
    await postStatusChange(qa.ctx, {
      warehouseId: kitchenWh,
      productId: milk,
      lotId: freshLot,
      fromStatus: "QUARANTINE",
      toStatus: "AVAILABLE",
      quantity: "5",
      uomId: units.l,
      reasonCode: "RELEASED_AFTER_INSPECTION",
    });
    await postStatusChange(qa.ctx, {
      warehouseId: kitchenWh,
      productId: milk,
      lotId: freshLot,
      fromStatus: "QUARANTINE",
      toStatus: "REJECTED",
      quantity: "1",
      uomId: units.l,
      reasonCode: "QUALITY_CHECK",
    });
    expect(await balance(milk, kitchenWh, "AVAILABLE", "M-NEW")).toBe("5");
    expect(await balance(milk, kitchenWh, "REJECTED", "M-NEW")).toBe("1");
  });

  it("never releases rejected or expired stock to normal use", async () => {
    await expectAppError(
      postStatusChange(ctx, {
        warehouseId: kitchenWh,
        productId: milk,
        lotId: freshLot,
        fromStatus: "REJECTED",
        toStatus: "AVAILABLE",
        quantity: "1",
        uomId: units.l,
        reasonCode: "OTHER",
        note: "x",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await postOpeningBalance(ctx, {
      warehouseId: mainWh,
      productId: milk,
      lotCode: "M-Q-OLD",
      expiresOn: addDays(today, -2),
      quantity: "1",
      uomId: units.l,
    });
    const oldLot = await lotId(milk, "M-Q-OLD");
    await postStatusChange(ctx, {
      warehouseId: mainWh,
      productId: milk,
      lotId: oldLot,
      fromStatus: "AVAILABLE",
      toStatus: "QUARANTINE",
      quantity: "1",
      uomId: units.l,
      reasonCode: "QUALITY_CHECK",
    });
    await expectAppError(
      postStatusChange(ctx, {
        warehouseId: mainWh,
        productId: milk,
        lotId: oldLot,
        fromStatus: "QUARANTINE",
        toStatus: "AVAILABLE",
        quantity: "1",
        uomId: units.l,
        reasonCode: "RELEASED_AFTER_INSPECTION",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("requires a note when the reason is OTHER", async () => {
    await expectAppError(
      postWriteOff(ctx, {
        warehouseId: kitchenWh,
        productId: milk,
        lotId: freshLot,
        stockStatus: "REJECTED",
        quantity: "1",
        uomId: units.l,
        reasonCode: "OTHER",
      }),
      "VALIDATION_FAILED",
    );
  });
});

describe("transfers and reversals", () => {
  it("moves stock between warehouses and locations, preserving the lot", async () => {
    const lot = await lotId(eggs, "EGG-A");
    const res = await postTransfer(ctx, {
      warehouseId: mainWh,
      productId: eggs,
      lotId: lot,
      toWarehouseId: kitchenWh,
      quantity: "1",
      uomId: units.case,
    });
    expect(await balance(eggs, mainWh, "AVAILABLE", "EGG-A")).toBe("30");
    expect(await balance(eggs, kitchenWh, "AVAILABLE", "EGG-A")).toBe("30");
    // Same warehouse, into a location.
    await postTransfer(ctx, {
      warehouseId: mainWh,
      productId: eggs,
      lotId: lot,
      toWarehouseId: mainWh,
      toLocationId: shelf,
      quantity: "10",
      uomId: units.each,
    });
    const shelfRow = await getDb().stockBalance.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, productId: eggs, locationId: shelf },
    });
    expect(shelfRow.onHandQuantity.toString()).toBe("10");
    await expectAppError(
      postTransfer(ctx, {
        warehouseId: mainWh,
        productId: eggs,
        lotId: lot,
        toWarehouseId: mainWh,
        quantity: "1",
        uomId: units.each,
      }),
      "BUSINESS_RULE_VIOLATION",
    );

    const doc = await getDocument(ctx, res.documentId);
    expect(doc.entries.map((e) => [e.movementType, e.quantityDelta.toString()])).toEqual([
      ["TRANSFER_OUT", "-30"],
      ["TRANSFER_IN", "30"],
    ]);
  });

  it("reverses exactly once, and never a reversal", async () => {
    const res = await postAdjustment(ctx, {
      warehouseId: mainWh,
      productId: rice,
      direction: "INCREASE",
      quantity: "7",
      uomId: units.kg,
      reasonCode: "FOUND_STOCK",
    });
    expect(await balance(rice, mainWh)).toBe("10");
    const rev = await reverseDocument(ctx, res.documentId, { reasonCode: "ENTERED_IN_ERROR" });
    expect(await balance(rice, mainWh)).toBe("3");
    await expectAppError(
      reverseDocument(ctx, res.documentId, { reasonCode: "ENTERED_IN_ERROR" }),
      "CONFLICT",
    );
    await expectAppError(
      reverseDocument(ctx, rev.documentId, { reasonCode: "ENTERED_IN_ERROR" }),
      "BUSINESS_RULE_VIOLATION",
    );
    const doc = await getDocument(ctx, res.documentId);
    expect(doc.reversedBy?.number).toBe(rev.number);
    expect(doc.canReverse).toBe(false);
  });

  it("cannot reverse stock that has since been used", async () => {
    const res = await postAdjustment(ctx, {
      warehouseId: kitchenWh,
      productId: rice,
      direction: "INCREASE",
      quantity: "1",
      uomId: units.kg,
      reasonCode: "FOUND_STOCK",
    });
    await postWriteOff(ctx, {
      warehouseId: kitchenWh,
      productId: rice,
      stockStatus: "AVAILABLE",
      quantity: "11",
      uomId: units.kg,
      reasonCode: "SPOILED",
    });
    await expectAppError(
      reverseDocument(ctx, res.documentId, { reasonCode: "ENTERED_IN_ERROR" }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("handles concurrent reversal attempts: one wins", async () => {
    const res = await postAdjustment(ctx, {
      warehouseId: mainWh,
      productId: rice,
      direction: "INCREASE",
      quantity: "1",
      uomId: units.kg,
      reasonCode: "FOUND_STOCK",
    });
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => reverseDocument(ctx, res.documentId, { reasonCode: "ENTERED_IN_ERROR" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance(rice, mainWh)).toBe("3");
  });
});

describe("history is immutable", () => {
  it("rejects UPDATE and DELETE on ledger entries and documents", async () => {
    const entry = await getDb().inventoryLedgerEntry.findFirstOrThrow({
      where: { organizationId: ctx.organizationId },
    });
    await expect(
      getDb().inventoryLedgerEntry.update({ where: { id: entry.id }, data: { note: "tampered" } }),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().inventoryLedgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(
      getDb().inventoryDocument.delete({ where: { id: entry.documentId } }),
    ).rejects.toThrow(/append-only/);
  });
});

describe("stock counts", () => {
  it("adjusts by the difference captured when each line is counted", async () => {
    const { id } = await createCount(ctx, { warehouseId: kitchenWh });
    let count = await getCount(ctx, id);
    // The sheet lists every AVAILABLE bucket with stock (rice here was fully written off earlier).
    expect(count.lines.some((l) => l.product.sku === "RICE")).toBe(false);
    expect(count.lines.find((l) => l.lot?.lotCode === "EGG-A")?.expectedQuantity.toString()).toBe(
      "30",
    );

    // Stock moves after the count sheet was created but before this item is counted.
    await postAdjustment(ctx, {
      warehouseId: kitchenWh,
      productId: eggs,
      lotCode: "EGG-A",
      direction: "DECREASE",
      quantity: "5",
      uomId: units.each,
      reasonCode: "DATA_CORRECTION",
    });
    count = await getCount(ctx, id);
    for (const l of count.lines) {
      const counted =
        l.product.sku === "EGGS" && l.lot?.lotCode === "EGG-A"
          ? "24"
          : l.expectedQuantity.toString();
      await recordCountedQuantity(ctx, id, l.id, { countedQuantity: counted });
    }
    // A lot found on the shelf that the system did not know about.
    const found = await addCountLine(ctx, id, {
      productId: milk,
      lotCode: "M-FOUND",
      expiresOn: addDays(today, 5),
    });
    await expectAppError(submitCount(ctx, id), "BUSINESS_RULE_VIOLATION"); // found line not counted yet
    await recordCountedQuantity(ctx, id, found.id, { countedQuantity: "3" });
    await submitCount(ctx, id);
    await expectAppError(
      recordCountedQuantity(ctx, id, found.id, { countedQuantity: "4" }),
      "BUSINESS_RULE_VIOLATION",
    ); // locked after submit

    const counter = await addMember(ctx, "warehouse");
    await expectAppError(postCount(counter.ctx, id), "FORBIDDEN"); // approval needs inventory.count.approve
    const { documentNumber } = await postCount(ctx, id);
    expect(documentNumber).toMatch(/^CNT-/);
    expect(await balance(eggs, kitchenWh, "AVAILABLE", "EGG-A")).toBe("24"); // 25 after the decrease, counted 24
    expect(await balance(milk, kitchenWh, "AVAILABLE", "M-FOUND")).toBe("3");
    await expectAppError(postCount(ctx, id), "BUSINESS_RULE_VIOLATION"); // already posted
  });
});

describe("product and warehouse rules", () => {
  it("freezes base unit and lot tracking after movements; blocks archiving stocked items", async () => {
    await expectAppError(
      updateProduct(ctx, rice, {
        sku: "RICE",
        nameEn: "Rice",
        type: "RAW_MATERIAL",
        baseUomId: units.g,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(setProductArchived(ctx, rice, true), "BUSINESS_RULE_VIOLATION");
    await expectAppError(setWarehouseArchived(ctx, mainWh, true), "BUSINESS_RULE_VIOLATION");
  });
});

describe("scope and tenant isolation", () => {
  it("limits a warehouse-scoped user to that warehouse", async () => {
    const scoped = await addMember(ctx, "branch_manager", {
      scopeType: "WAREHOUSE",
      warehouseId: kitchenWh,
    });
    const visible = await listBalances(scoped.ctx);
    expect(visible.items.length).toBeGreaterThan(0);
    expect(visible.items.every((r) => r.warehouse.id === kitchenWh)).toBe(true);
    const moves = await listMovements(scoped.ctx);
    expect(moves.items.every((m) => m.warehouse.id === kitchenWh)).toBe(true);
    await expectAppError(
      postAdjustment(scoped.ctx, {
        warehouseId: mainWh,
        productId: rice,
        direction: "INCREASE",
        quantity: "1",
        uomId: units.kg,
        reasonCode: "FOUND_STOCK",
      }),
      "NOT_FOUND",
    );
    // Transfers need permission at both ends.
    await expectAppError(
      postTransfer(scoped.ctx, {
        warehouseId: kitchenWh,
        productId: milk,
        lotId: await lotId(milk, "M-NEW"),
        toWarehouseId: mainWh,
        quantity: "1",
        uomId: units.l,
      }),
      "NOT_FOUND",
    );
  });

  it("a read-only analyst can view but not move stock", async () => {
    const analyst = await addMember(ctx, "analyst");
    expect((await listBalances(analyst.ctx)).total).toBeGreaterThan(0);
    await expectAppError(
      postAdjustment(analyst.ctx, {
        warehouseId: mainWh,
        productId: rice,
        direction: "INCREASE",
        quantity: "1",
        uomId: units.kg,
        reasonCode: "FOUND_STOCK",
      }),
      "FORBIDDEN",
    );
  });

  it("other tenants see nothing and can post nothing", async () => {
    const { ctx: other } = await createTenant("inv-other");
    const someDoc = await getDb().inventoryDocument.findFirstOrThrow({
      where: { organizationId: ctx.organizationId },
    });
    await expectAppError(getDocument(other, someDoc.id), "NOT_FOUND");
    await expectAppError(
      reverseDocument(other, someDoc.id, { reasonCode: "ENTERED_IN_ERROR" }),
      "NOT_FOUND",
    );
    await expectAppError(
      postOpeningBalance(other, {
        warehouseId: mainWh,
        productId: rice,
        quantity: "1",
        uomId: units.kg,
      }),
      "NOT_FOUND",
    );
    expect((await listBalances(other)).total).toBe(0);
    expect((await listMovements(other)).total).toBe(0);
    // RLS hides ledger rows even from an unfiltered query.
    const leaked = await withTenantTx(other.organizationId, (tx) =>
      tx.inventoryLedgerEntry.count(),
    );
    expect(leaked).toBe(0);
  });
});

describe("dashboard", () => {
  it("reports real figures from balances", async () => {
    const d = await inventoryDashboard(ctx);
    expect(d.productsInStock).toBeGreaterThanOrEqual(3);
    expect(d.rejectedBuckets).toBeGreaterThanOrEqual(1);
    expect(d.expiring.some((r) => r.lot?.lotCode === "M-TODAY" || r.lot?.lotCode === "M-1")).toBe(
      true,
    );
    expect(d.recentDocuments.length).toBeGreaterThan(0);
  });
});
