import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { addOrderLine, createOrder, getOrder, submitOrder } from "@/modules/procurement/orders";
import { getReceipt, postReceipt, reverseReceipt } from "@/modules/procurement/receipts";
import { updateProcurementSettings } from "@/modules/procurement/settings";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addChargeLine,
  addGoodsLine,
  approveException,
  cancelInvoice,
  createInvoice,
  getInvoice,
  inputVatSummary,
  listInvoices,
  postInvoice,
  removeInvoiceLine,
  uninvoicedReceiptLines,
  updateInvoiceHeader,
} from "./service";

let ctx: TenantContext;
let finance: TenantContext;
let units: Record<string, string>;
let warehouseId: string;
let supplierId: string;
let otherSupplierId: string;
let flour: string;
let codes: Record<string, string>;

/** Order at `orderPrice`, receive at `receivedPrice`; returns the receipt line ids by product. */
async function received(
  supplier: string,
  lines: Array<{
    productId: string;
    quantity: string;
    orderPrice: string;
    receivedPrice?: string;
    uom?: string;
  }>,
) {
  const { id } = await createOrder(ctx, { supplierId: supplier, warehouseId });
  for (const l of lines)
    await addOrderLine(ctx, id, {
      productId: l.productId,
      quantity: l.quantity,
      unitPrice: l.orderPrice,
      uomId: l.uom ?? units.kg,
    });
  await submitOrder(ctx, id);
  const order = await getOrder(ctx, id);
  const receipt = await postReceipt(ctx, id, {
    lines: order.lines.map((ol, i) => ({
      purchaseOrderLineId: ol.id,
      receivedQuantity: ol.quantity.toString(),
      unitPrice: lines[i].receivedPrice ?? lines[i].orderPrice,
    })),
  });
  const r = await getReceipt(ctx, receipt.id);
  return { receiptId: receipt.id, lineIds: r.lines.map((l) => l.id) };
}

beforeAll(async () => {
  ({ ctx } = await createTenant("invoices"));
  finance = (await addMember(ctx, "finance")).ctx;
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "RYD", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  warehouseId = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" }))
    .id;
  flour = (
    await createProduct(ctx, {
      sku: "FLOUR",
      nameEn: "Flour",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  supplierId = (
    await createSupplier(ctx, { code: "MILL", name: "Mill Co", paymentTermsDays: "30" })
  ).id;
  otherSupplierId = (await createSupplier(ctx, { code: "OTHER", name: "Other" })).id;
  await applyCountryPreset(ctx, "SA");
  codes = Object.fromEntries((await getTaxSetup(ctx)).codes.map((c) => [c.code, c.id]));
  await updateTaxSettings(ctx, {
    country: "SA",
    vatRegistered: "on",
    pricesIncludeTax: "on",
    defaultSalesTaxCodeId: codes.STD,
    defaultPurchaseTaxCodeId: codes.STD,
    vatNumber: "310122393500003",
  });
  await updateProcurementSettings(ctx, {
    approvalThreshold: "",
    overReceiptTolerancePercent: "0",
    invoicePriceTolerancePercent: "2",
  });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("supplier invoices", () => {
  it("matches an invoice to the receipt and order, with VAT by invoice date, and posts it", async () => {
    const { lineIds } = await received(supplierId, [
      { productId: flour, quantity: "100", orderPrice: "10" },
    ]);
    const inv = await createInvoice(ctx, {
      supplierId,
      supplierInvoiceNo: "MC-1001",
      invoiceDate: "2026-10-05",
      printedGross: "1150",
    });
    expect(inv.number).toMatch(/^PI-2026-\d{6}$/);
    expect((await uninvoicedReceiptLines(ctx, supplierId)).map((l) => l.open.toFixed())).toContain(
      "100",
    );
    // Within the 2 % tolerance.
    await addGoodsLine(ctx, inv.id, {
      receiptLineId: lineIds[0],
      quantity: "100",
      unitPrice: "10.1",
    });
    // A draft line already takes the quantity: it is not offered again.
    expect(
      (await uninvoicedReceiptLines(ctx, supplierId)).find((l) => l.id === lineIds[0]),
    ).toBeUndefined();
    let view = await getInvoice(ctx, inv.id);
    expect(view.dueDate?.toISOString().slice(0, 10)).toBe("2026-11-04");
    expect(view.lines[0]).toMatchObject({ match: "MATCHED" });
    expect(view.lines[0].priceVariance?.toFixed()).toBe("10");
    expect([
      view.netAmount.toFixed(),
      view.taxAmount.toFixed(),
      view.grossAmount.toFixed(),
    ]).toEqual(["1010", "151.5", "1161.5"]);
    // The printed total does not match the lines.
    expect(view.matchStatus).toBe("EXCEPTION");
    expect(view.totalOk).toBe(false);
    await updateInvoiceHeader(ctx, inv.id, {
      supplierInvoiceNo: "MC-1001",
      invoiceDate: "2026-10-05",
      printedGross: "1161.50",
    });
    view = await getInvoice(ctx, inv.id);
    expect(view.matchStatus).toBe("MATCHED");
    expect(view.can.post).toBe(true);
    await postInvoice(ctx, inv.id);
    expect((await getInvoice(ctx, inv.id)).status).toBe("POSTED");
    // Fully invoiced: the receipt line is no longer offered.
    expect(
      (await uninvoicedReceiptLines(ctx, supplierId)).find((l) => l.id === lineIds[0]),
    ).toBeUndefined();
    // Posted invoices are read-only; the same supplier number cannot be entered twice.
    await expectAppError(
      addChargeLine(ctx, inv.id, { description: "x", netAmount: "1" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      createInvoice(ctx, {
        supplierId,
        supplierInvoiceNo: "MC-1001",
        invoiceDate: "2026-10-06",
        printedGross: "1",
      }),
      "CONFLICT",
    );
    // …but another supplier may use the same number.
    await createInvoice(ctx, {
      supplierId: otherSupplierId,
      supplierInvoiceNo: "MC-1001",
      invoiceDate: "2026-10-06",
      printedGross: "1",
    });
  });

  it("flags price and quantity variances and needs another person to approve them", async () => {
    const { lineIds } = await received(supplierId, [
      { productId: flour, quantity: "50", orderPrice: "10" },
    ]);
    const inv = await createInvoice(ctx, {
      supplierId,
      supplierInvoiceNo: "MC-1002",
      invoiceDate: "2026-10-10",
      printedGross: "690",
    });
    await addGoodsLine(ctx, inv.id, { receiptLineId: lineIds[0], quantity: "50", unitPrice: "12" });
    let view = await getInvoice(ctx, inv.id);
    expect(view.lines[0].match).toBe("PRICE_VARIANCE");
    expect(view.lines[0].priceVariance?.toFixed()).toBe("100");
    expect(view.totalOk).toBe(true);
    expect(view.matchStatus).toBe("EXCEPTION");
    await expectAppError(postInvoice(ctx, inv.id), "BUSINESS_RULE_VIOLATION");
    await expectAppError(approveException(ctx, inv.id, { note: "ok" }), "BUSINESS_RULE_VIOLATION");
    await approveException(finance, inv.id, { note: "Price rise agreed by phone" });
    // A change after approval clears it.
    const charge = await addChargeLine(ctx, inv.id, {
      description: "Delivery",
      netAmount: "20",
      taxCodeId: codes.ZERO,
    }).then(() => getInvoice(ctx, inv.id));
    expect(charge.exceptionApprovedAt).toBeNull();
    expect(charge.grossAmount.toFixed()).toBe("710");
    await removeInvoiceLine(ctx, inv.id, charge.lines[1].id);
    await approveException(finance, inv.id, { note: "Price rise agreed by phone" });
    await postInvoice(ctx, inv.id);
    view = await getInvoice(ctx, inv.id);
    expect(view.status).toBe("POSTED");
    expect(view.names.approvedBy).toBeTruthy();

    // Invoicing more than was received is a quantity variance, also across invoices.
    const extra = await createInvoice(ctx, {
      supplierId,
      supplierInvoiceNo: "MC-1003",
      invoiceDate: "2026-10-11",
      printedGross: "57.5",
    });
    await addGoodsLine(ctx, extra.id, {
      receiptLineId: lineIds[0],
      quantity: "5",
      unitPrice: "10",
    });
    view = await getInvoice(ctx, extra.id);
    expect(view.lines[0].match).toBe("QUANTITY_VARIANCE");
    expect(view.lines[0].quantityVariance?.toFixed()).toBe("5");
    // Cancelling frees nothing here, but is recorded with a reason.
    await cancelInvoice(ctx, extra.id, { reason: "Duplicate of MC-1002" });
    expect((await listInvoices(ctx, { status: "CANCELLED" })).map((i) => i.id)).toContain(extra.id);
    // A cancelled number may be entered again.
    await createInvoice(ctx, {
      supplierId,
      supplierInvoiceNo: "MC-1003",
      invoiceDate: "2026-10-11",
      printedGross: "1",
    });
  });

  it("refuses receipts of other suppliers or reversed ones and keeps the date when lines exist", async () => {
    const mine = await received(supplierId, [
      { productId: flour, quantity: "3", orderPrice: "10" },
    ]);
    const theirs = await received(otherSupplierId, [
      { productId: flour, quantity: "3", orderPrice: "10" },
    ]);
    const inv = await createInvoice(ctx, {
      supplierId,
      supplierInvoiceNo: "MC-1004",
      invoiceDate: "2026-10-12",
      printedGross: "34.5",
    });
    await expectAppError(
      addGoodsLine(ctx, inv.id, {
        receiptLineId: theirs.lineIds[0],
        quantity: "3",
        unitPrice: "10",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await addGoodsLine(ctx, inv.id, {
      receiptLineId: mine.lineIds[0],
      quantity: "3",
      unitPrice: "10",
    });
    await expectAppError(
      updateInvoiceHeader(ctx, inv.id, {
        supplierInvoiceNo: "MC-1004",
        invoiceDate: "2026-09-01",
        printedGross: "34.5",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    const rev = await received(supplierId, [{ productId: flour, quantity: "2", orderPrice: "10" }]);
    await reverseReceipt(ctx, rev.receiptId, { reasonCode: "ENTERED_IN_ERROR" });
    await expectAppError(
      addGoodsLine(ctx, inv.id, { receiptLineId: rev.lineIds[0], quantity: "2", unitPrice: "10" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      createInvoice(ctx, {
        supplierId,
        supplierInvoiceNo: "MC-1005",
        invoiceDate: "2026-10-12",
        dueDate: "2026-10-01",
        printedGross: "1",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("uses the VAT rate in force on the invoice date and summarizes input VAT", async () => {
    const { lineIds } = await received(supplierId, [
      { productId: flour, quantity: "10", orderPrice: "10" },
    ]);
    // Before 2020-07-01 the Saudi standard rate was 5 %.
    const old = await createInvoice(ctx, {
      supplierId,
      supplierInvoiceNo: "MC-2020",
      invoiceDate: "2020-06-30",
      printedGross: "105",
    });
    await addGoodsLine(ctx, old.id, { receiptLineId: lineIds[0], quantity: "10", unitPrice: "10" });
    const view = await getInvoice(ctx, old.id);
    expect(view.lines[0].taxRate?.toFixed()).toBe("0.05");
    expect(view.matchStatus).toBe("MATCHED");
    await postInvoice(ctx, old.id);
    const summary = await inputVatSummary(ctx, { from: "2026-10-01", to: "2026-10-31" });
    expect(summary.reclaimable).toBe(true);
    const std = summary.rows.find((r) => r.code?.code === "STD" && r.rate?.toFixed() === "0.15");
    // MC-1001 (151.5) and MC-1002 (90) are posted in October; drafts and cancelled ones are not counted.
    expect(std?.tax?.toFixed()).toBe("241.5");
  });

  it("is limited by permission and tenant", async () => {
    const procurement = (await addMember(ctx, "procurement")).ctx;
    await expectAppError(
      createInvoice(procurement, {
        supplierId,
        supplierInvoiceNo: "P-1",
        invoiceDate: "2026-10-12",
        printedGross: "1",
      }),
      "FORBIDDEN",
    );
    expect((await listInvoices(procurement)).length).toBeGreaterThan(0);
    const other = await createTenant("invoices-other");
    const mine = (await listInvoices(ctx))[0];
    await expectAppError(getInvoice(other.ctx, mine.id), "NOT_FOUND");
    await expectAppError(cancelInvoice(other.ctx, mine.id, { reason: "x" }), "NOT_FOUND");
    await expectAppError(
      createInvoice(other.ctx, {
        supplierId,
        supplierInvoiceNo: "X-1",
        invoiceDate: "2026-10-12",
        printedGross: "1",
      }),
      "NOT_FOUND",
    );
  });
});
