import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { exportBalancesCsv, importOpeningBalances, importProducts } from "./csv";
import { reconcileBalances } from "./queries";

let ctx: TenantContext;

beforeAll(async () => {
  ({ ctx } = await createTenant("csv"));
  const b = await createBranch(ctx, { code: "B1", name: "Branch", type: "RESTAURANT" });
  await createWarehouse(ctx, { branchId: b.id, code: "MAIN", name: "Main", type: "MAIN" });
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
  await getDb().$disconnect();
});

describe("product import", () => {
  it("reports every row error and imports nothing when any row is invalid", async () => {
    const csv = [
      "sku,name_en,name_ar,type,base_unit,lot_tracking",
      "flour,Flour,دقيق,raw_material,kg,",
      "FLOUR,Flour again,,RAW_MATERIAL,kg,",
      "bad sku!,Bad,,RAW_MATERIAL,kg,",
      "OIL,,,RAW_MATERIAL,litre,",
      "SALT,Salt,,PALACE,g,",
    ].join("\n");
    const result = await importProducts(ctx, csv);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        { row: 2, column: "sku", message: "skuDuplicateInFile" },
        { row: 3, column: "sku", message: "invalidSku" },
        { row: 4, column: "base_unit", message: "unknownUnit" },
        { row: 4, column: "name_en", message: "required" },
        { row: 5, column: "type", message: "invalidOption" },
      ]),
    );
    expect(await getDb().product.count({ where: { organizationId: ctx.organizationId } })).toBe(0);
  });

  it("imports valid files and rejects existing SKUs on re-import", async () => {
    const csv =
      "sku,name_en,name_ar,type,base_unit,lot_tracking,shelf_life_days,storage\nFLOUR,Flour,دقيق,raw_material,kg,,,ambient\nMILK,Milk,حليب,RAW_MATERIAL,l,lot_and_expiry,7,chilled\n";
    expect(await importProducts(ctx, csv)).toEqual({ ok: true, imported: 2, errors: [] });
    const milk = await getDb().product.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, sku: "MILK" },
    });
    expect(milk).toMatchObject({
      lotTracking: "LOT_AND_EXPIRY",
      shelfLifeDays: 7,
      storageRequirement: "CHILLED",
      nameAr: "حليب",
    });
    const again = await importProducts(ctx, csv);
    expect(again.errors).toEqual([
      { row: 1, column: "sku", message: "skuTaken" },
      { row: 2, column: "sku", message: "skuTaken" },
    ]);
  });

  it("rejects malformed files, missing columns and oversize files", async () => {
    expect((await importProducts(ctx, 'sku,name_en\n"unterminated')).errors[0].message).toBe(
      "csvMalformed",
    );
    expect((await importProducts(ctx, "sku,name_en\nA,B")).errors.map((e) => e.column)).toEqual([
      "type",
      "base_unit",
    ]);
    expect((await importProducts(ctx, "sku,name_en,type,base_unit\n")).errors[0].message).toBe(
      "csvEmpty",
    );
  });

  it("requires catalog.manage", async () => {
    const { ctx: analyst } = await addMember(ctx, "analyst");
    await expectAppError(
      importProducts(analyst, "sku,name_en,type,base_unit\nX,X,RAW_MATERIAL,kg"),
      "FORBIDDEN",
    );
  });
});

describe("opening balance import", () => {
  const file = [
    "warehouse_code,location_code,sku,lot_code,expires_on,quantity,unit,unit_cost",
    "main,,flour,,,25,kg,40",
    "MAIN,,MILK,m-1,2099-01-31,500,ml,",
  ].join("\n");

  it("validates rows without writing anything on error", async () => {
    const bad =
      file + "\nMAIN,,MILK,,,1,l,\nNOPE,,FLOUR,,,1,kg,\nMAIN,,FLOUR,,,-3,kg,\nMAIN,,FLOUR,,,1,l,";
    const result = await importOpeningBalances(ctx, bad);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        { row: 3, column: "lot_code", message: "lotRequired" },
        { row: 4, column: "warehouse_code", message: "unknownWarehouse" },
        { row: 5, column: "quantity", message: "mustNotBeNegative" },
        { row: 6, column: "", message: "INCOMPATIBLE_UNITS" },
      ]),
    );
    expect(
      await getDb().inventoryLedgerEntry.count({ where: { organizationId: ctx.organizationId } }),
    ).toBe(0);
    // Lots created while validating were rolled back.
    expect(
      await getDb().inventoryLot.count({ where: { organizationId: ctx.organizationId } }),
    ).toBe(0);
  });

  it("posts one document per warehouse and refuses the same file twice", async () => {
    const result = await importOpeningBalances(ctx, file);
    expect(result).toMatchObject({ ok: true, imported: 2 });
    expect(result.documents).toHaveLength(1);
    await expect(importOpeningBalances(ctx, file)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "fileAlreadyImported" },
    });

    const csv = await exportBalancesCsv(ctx, {});
    const rows = parseCsv(csv.slice(1));
    expect(rows[0]).toEqual([
      "warehouse_code",
      "location_code",
      "sku",
      "name_en",
      "name_ar",
      "lot_code",
      "expires_on",
      "status",
      "on_hand",
      "available",
      "unit",
      "expiry_state",
    ]);
    expect(rows.slice(1).map((r) => [r[2], r[5], r[8], r[10]])).toEqual([
      ["FLOUR", "", "25", "kg"],
      ["MILK", "M-1", "0.5", "l"],
    ]);
  });
});
