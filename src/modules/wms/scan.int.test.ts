import { beforeAll, describe, expect, it } from "vitest";
import {
  addSalesOrderLine,
  confirmSalesOrder,
  createCustomer,
  createSalesOrder,
} from "@/modules/b2b/service";
import { addBarcode, createProduct, listUnits } from "@/modules/catalog/service";
import { createCount } from "@/modules/inventory/counts";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { createBranch } from "@/modules/sites/branches";
import { createLocation, createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { packUnit } from "./loading";
import { confirmPick, createPickList, getPickList } from "./picking";
import { countScanLines, pickScanPlan, resolveScan } from "./scan";

/** Scanning lookups (ADR-104). */

let ctx: TenantContext;
let main: string;
let milk: string;
let listId: string;
let unitNumber: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("scan"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (
    await createBranch(ctx, { code: "CK", name: "Kitchen", type: "CENTRAL_KITCHEN" })
  ).id;
  main = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  const shelf = (
    await createLocation(ctx, main, {
      code: "A-01",
      name: "Shelf A1",
      temperatureZone: "CHILLED",
      zone: "PICKING",
    })
  ).id;
  await createLocation(ctx, main, {
    code: "DSP",
    name: "Dispatch",
    temperatureZone: "CHILLED",
    zone: "DISPATCH",
  });
  milk = (
    await createProduct(ctx, {
      sku: "MILK",
      nameEn: "Milk",
      type: "RAW_MATERIAL",
      baseUomId: units.l,
      lotTracking: "LOT",
      storageRequirement: "CHILLED",
    })
  ).id;
  await addBarcode(ctx, milk, { barcode: "6221234567891", symbology: "EAN13" });
  await postOpeningBalance(ctx, {
    warehouseId: main,
    locationId: shelf,
    productId: milk,
    lotCode: "M-77",
    quantity: "12",
    uomId: units.l,
    unitCost: "3",
  });
  const customerId = (await createCustomer(ctx, { code: "CAFE", name: "Cafe" })).id;
  const order = await createSalesOrder(ctx, { customerId, warehouseId: main });
  await addSalesOrderLine(ctx, order.id, {
    productId: milk,
    quantity: "4",
    uomId: units.l,
    unitPrice: "5",
  });
  await confirmSalesOrder(ctx, order.id);
  listId = (await createPickList(ctx, order.id)).id;
});

describe("scanning (ADR-104)", () => {
  it("the guided pick knows which location and codes to expect", async () => {
    const { steps } = await pickScanPlan(ctx, listId);
    expect(steps).toEqual([
      expect.objectContaining({
        locationCode: "A-01",
        sku: "MILK",
        barcodes: ["6221234567891"],
        lotCode: "M-77",
        planned: "4",
        unit: "l",
      }),
    ]);
    const view = await getPickList(ctx, listId);
    await confirmPick(ctx, listId, { lines: [{ id: view.lines[0].id, pickedQuantity: "4" }] });
    unitNumber = (await packUnit(ctx, listId, { type: "CRATE" })).number;
  });

  it("resolves units, locations, products and lots from what a scanner sends", async () => {
    const kinds = async (code: string) => (await resolveScan(ctx, code)).matches.map((m) => m.kind);
    expect(await kinds(`${unitNumber.toLowerCase()}\r\n`)).toEqual(["PACK_UNIT"]);
    expect(await kinds("a-01")).toEqual(["LOCATION"]);
    expect((await resolveScan(ctx, "6221234567891")).matches).toEqual([
      expect.objectContaining({ kind: "PRODUCT", id: milk, via: "BARCODE" }),
    ]);
    expect((await resolveScan(ctx, "milk")).matches).toEqual([
      expect.objectContaining({ kind: "PRODUCT", via: "SKU" }),
    ]);
    expect(await kinds("M-77")).toEqual(["LOT"]);
    expect(await kinds("NOTHING-HERE")).toEqual([]);
    expect(await kinds("   ")).toEqual([]);
  });

  it("finds the count lines for a scanned product", async () => {
    const { id } = await createCount(ctx, { warehouseId: main });
    // The milk is on the shelf and staged in dispatch: both lines match.
    const byBarcode = (await countScanLines(ctx, id, "6221234567891")).lines;
    expect(byBarcode.map((l) => l.location?.code).sort()).toEqual(["A-01", "DSP"]);
    expect((await countScanLines(ctx, id, "M-77")).lines).toHaveLength(2);
    expect((await countScanLines(ctx, id, "OTHER")).lines).toEqual([]);
  });

  it("shows nothing across organizations and needs stock rights", async () => {
    const { ctx: other } = await createTenant("scan-other");
    expect((await resolveScan(other, unitNumber)).matches).toEqual([]);
    expect((await resolveScan(other, "6221234567891")).matches).toEqual([]);
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(resolveScan(cashier.ctx, "MILK"), "FORBIDDEN");
  });
});
