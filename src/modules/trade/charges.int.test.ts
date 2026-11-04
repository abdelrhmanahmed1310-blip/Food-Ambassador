import { beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { setExchangeRate } from "@/modules/fx/service";
import { postWriteOff } from "@/modules/inventory/operations";
import { reconcileValuations } from "@/modules/inventory/valuation-queries";
import { businessDate } from "@/modules/inventory/rules";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { postReceipt } from "@/modules/procurement/receipts";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { postShipmentCharge, recordCustomsEntry } from "./charges";
import { advanceShipment, createShipment, getShipment, linkOrder, linkReceipt } from "./shipments";

/** Customs entries and shipment charges spread over receipts (ADR-115). */

let ctx: TenantContext;
let buyer: TenantContext;
let today: string;
let warehouseId: string;
let shipmentId: string;
let flour: string;
let sugar: string;
let units: Record<string, string>;

async function expectRule(promise: Promise<unknown>, rule: string) {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; details?: { rule?: string } };
    expect(`${e.code}:${e.details?.rule}`).toBe(`BUSINESS_RULE_VIOLATION:${rule}`);
    return;
  }
  throw new Error(`Expected ${rule} but the call succeeded`);
}

async function valuation(productId: string) {
  const v = await getDb().stockValuation.findFirstOrThrow({
    where: { organizationId: ctx.organizationId, warehouseId, productId },
  });
  return [v.totalValue.toFixed(2), v.averageUnitCost?.toFixed(2)];
}

async function receive(
  currency: string,
  productId: string,
  qty: string,
  price: string,
  supplierId: string,
) {
  const { id } = await createOrder(buyer, { supplierId, warehouseId, currency });
  await addOrderLine(buyer, id, { productId, uomId: units.kg, quantity: qty, unitPrice: price });
  await submitOrder(buyer, id);
  await linkOrder(buyer, shipmentId, { purchaseOrderId: id });
  return id;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("trade-charges", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  buyer = (await addMember(ctx, "procurement")).ctx;
  today = businessDate(ctx.timeZone);
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  await setExchangeRate(ctx, { currency: "USD", rateDate: today, rate: "3.75" });
  const branchId = (
    await createBranch(ctx, { code: "DMM", name: "Dammam", type: "CENTRAL_KITCHEN" })
  ).id;
  warehouseId = (await createWarehouse(ctx, { branchId, code: "DC", name: "DC", type: "MAIN" })).id;
  flour = (
    await createProduct(ctx, {
      sku: "FLOUR",
      nameEn: "Flour",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  sugar = (
    await createProduct(ctx, {
      sku: "SUGAR",
      nameEn: "Sugar",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  const supplierId = (await createSupplier(ctx, { code: "GULF", name: "Gulf Trading" })).id;
  shipmentId = (await createShipment(buyer, { supplierId, warehouseId, mode: "SEA" })).id;
  // 100 kg flour at 10 SAR (1 000 SAR) and 50 kg sugar at 4 USD (750 SAR at 3.75).
  const orders = [
    await receive("SAR", flour, "100", "10", supplierId),
    await receive("USD", sugar, "50", "4", supplierId),
  ];
  await advanceShipment(buyer, shipmentId);
  await advanceShipment(buyer, shipmentId);
  for (const id of orders) {
    const po = await getOrder(buyer, id);
    const r = await postReceipt(buyer, id, {
      lines: [
        {
          purchaseOrderLineId: po.lines[0].id,
          receivedQuantity: po.lines[0].quantity.toString(),
          unitPrice: po.lines[0].unitPrice.toString(),
        },
      ],
    });
    await linkReceipt(buyer, shipmentId, { receiptId: r.id });
  }
  // Half the flour is already used before the freight bill arrives.
  await postWriteOff(ctx, {
    warehouseId,
    productId: flour,
    quantity: "50",
    uomId: units.kg,
    stockStatus: "AVAILABLE",
    reasonCode: "DAMAGED",
  });
}, 90_000);

describe("customs entries and shipment charges (ADR-115)", () => {
  it("records the declaration as customs assessed it, in the company's currency", async () => {
    await recordCustomsEntry(buyer, shipmentId, {
      number: "SA-IMP-2026-0042",
      declaredOn: today,
      broker: "Al Bahar Clearing",
      customsValue: "1750",
      dutyAmount: "87.5",
      importVat: "275.63",
    });
    await expectAppError(
      recordCustomsEntry(buyer, shipmentId, { number: "SA-IMP-2026-0042", declaredOn: today }),
      "CONFLICT",
    );
    await expectRule(
      recordCustomsEntry(buyer, shipmentId, {
        number: "X",
        declaredOn: today,
        dutyAmount: "1.001",
      }),
      "AMOUNT_TOO_PRECISE",
    );
    const costs = (await getShipment(buyer, shipmentId)).costs;
    expect(
      costs.customsEntries.map((e) => [
        e.number,
        e.currency,
        e.dutyAmount.toFixed(2),
        e.importVat.toFixed(2),
        e.dutyPosted.toFixed(2),
      ]),
    ).toEqual([["SA-IMP-2026-0042", "SAR", "87.50", "275.63", "0.00"]]);
    // The database keeps it as recorded.
    const entry = await getDb().importCustomsEntry.findFirstOrThrow({ where: { shipmentId } });
    await expect(
      getDb().importCustomsEntry.update({ where: { id: entry.id }, data: { dutyAmount: "1" } }),
    ).rejects.toThrow();
  });

  it("spreads freight over both receipts by value in SAR, adding to stock still on hand", async () => {
    // Procurement may not change stock values; finance-type permission is needed.
    await expectAppError(
      postShipmentCharge(buyer, shipmentId, {
        chargeType: "FREIGHT",
        method: "BY_VALUE",
        amount: "1",
      }),
      "FORBIDDEN",
    );
    const r = await postShipmentCharge(ctx, shipmentId, {
      chargeType: "FREIGHT",
      method: "BY_VALUE",
      amount: "1750",
      reference: "MAERSK-INV-9",
    });
    // 1 750 SAR over 1 000 SAR of flour and 750 SAR of sugar (200 USD at 3.75): 1 000 / 750.
    // Half the flour was used: 500 of its share is expensed, 500 added to the 50 kg left.
    expect([r.amount, r.capitalized, r.expensed, r.documents.length]).toEqual([
      "1750",
      "1250",
      "500",
      2,
    ]);
    expect(await valuation(sugar)).toEqual(["1500.00", "30.00"]);
    expect(await valuation(flour)).toEqual(["1000.00", "20.00"]);
    expect(await reconcileValuations(ctx)).toEqual([]);
  });

  it("posts the assessed duty against the declaration, and sums the landed cost", async () => {
    const entry = (await getShipment(ctx, shipmentId)).costs.customsEntries[0];
    await postShipmentCharge(ctx, shipmentId, {
      chargeType: "CUSTOMS_DUTY",
      method: "BY_QUANTITY",
      amount: "87.5",
      customsEntryId: entry.id,
    });
    const costs = (await getShipment(ctx, shipmentId)).costs;
    expect(costs.customsEntries[0].dutyPosted.toFixed(2)).toBe("87.50");
    expect([
      costs.goods.toFixed(2),
      costs.totalCharges.toFixed(2),
      costs.landedTotal.toFixed(2),
      costs.uplift?.toFixed(4),
    ]).toEqual(["1750.00", "1837.50", "3587.50", "1.0500"]);
    expect(costs.byType.map((b) => b.chargeType)).toEqual(["FREIGHT", "CUSTOMS_DUTY"]);
    expect(costs.charges[1].documents.length).toBe(2);
    await expect(
      getDb().importShipmentCharge.update({
        where: { id: costs.charges[0].id },
        data: { amount: "1" },
      }),
    ).rejects.toThrow();
  });

  it("needs an arrived shipment with receipts; others see nothing", async () => {
    const other = await createShipment(buyer, {
      supplierId: (await getShipment(buyer, shipmentId)).supplier.id,
      warehouseId,
      mode: "AIR",
    });
    await expectRule(
      postShipmentCharge(ctx, other.id, {
        chargeType: "FREIGHT",
        method: "BY_VALUE",
        amount: "10",
      }),
      "SHIPMENT_NOT_ARRIVED",
    );
    await expectRule(
      recordCustomsEntry(buyer, other.id, { number: "N", declaredOn: today }),
      "SHIPMENT_NOT_ARRIVED",
    );
    const { ctx: stranger } = await createTenant("trade-charges-other");
    await expectAppError(
      postShipmentCharge(stranger, shipmentId, {
        chargeType: "FREIGHT",
        method: "BY_VALUE",
        amount: "1",
      }),
      "NOT_FOUND",
    );
  });
});
