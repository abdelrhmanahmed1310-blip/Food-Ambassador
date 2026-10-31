import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { addConversion, createProduct, createUnit, listUnits } from "@/modules/catalog/service";
import { postWriteOff, reverseDocument } from "@/modules/inventory/operations";
import { reconcileBalances } from "@/modules/inventory/queries";
import { reconcileValuations } from "@/modules/inventory/valuation-queries";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addOrderLine,
  approveOrder,
  cancelOrder,
  closeOrder,
  createOrder,
  getOrder,
  listOrders,
  rejectOrder,
  removeOrderLine,
  submitOrder,
} from "./orders";
import { getReceipt, postReceipt, reverseReceipt } from "./receipts";
import { updateProcurementSettings } from "./settings";
import {
  createSupplier,
  getSupplier,
  saveSupplierProduct,
  setSupplierArchived,
  updateSupplier,
} from "./suppliers";

let ctx: TenantContext;
let units: Record<string, string>;
let branchId: string;
let mainWh: string;
let kitchenWh: string;
let supplierId: string;
let flour: string; // kg, no lots
let milk: string; // l, lot + expiry, chilled
let eggs: string; // each, lots; ordered by the case (30)

const future = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function stock(productId: string, warehouseId: string, status = "AVAILABLE") {
  const rows = await getDb().stockBalance.findMany({
    where: {
      organizationId: ctx.organizationId,
      productId,
      warehouseId,
      stockStatus: status as never,
    },
  });
  return rows.reduce((s, r) => s.plus(r.onHandQuantity.toString()), new Decimal(0)).toFixed();
}

async function valueOf(productId: string, warehouseId: string) {
  const v = await getDb().stockValuation.findFirst({
    where: { organizationId: ctx.organizationId, productId, warehouseId },
  });
  return v?.totalValue.toFixed() ?? "0";
}

/** A draft order with lines, submitted (auto-approved while no threshold is set). */
async function approvedOrder(
  lines: Array<{ productId: string; uomId: string; quantity: string; unitPrice: string }>,
  warehouseId = mainWh,
  expectedOn?: string,
) {
  const { id } = await createOrder(ctx, { supplierId, warehouseId, expectedOn });
  for (const l of lines) await addOrderLine(ctx, id, l);
  await submitOrder(ctx, id);
  return getOrder(ctx, id);
}

const receiveLine = (
  lineId: string,
  fields: Partial<Record<string, string>> & { receivedQuantity: string; unitPrice: string },
) => ({ purchaseOrderLineId: lineId, ...fields });

beforeAll(async () => {
  ({ ctx } = await createTenant("procurement"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  units.case = (
    await createUnit(ctx, { code: "case", nameEn: "Case", nameAr: "كرتونة", dimension: "COUNT" })
  ).id;
  branchId = (await createBranch(ctx, { code: "GIZ", name: "Giza", type: "RESTAURANT" })).id;
  mainWh = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" })).id;
  kitchenWh = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  flour = (
    await createProduct(ctx, {
      sku: "FLOUR",
      nameEn: "Flour",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  milk = (
    await createProduct(ctx, {
      sku: "MILK",
      nameEn: "Milk",
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
  supplierId = (await createSupplier(ctx, { code: "NILE-MILLS", name: "Nile Mills" })).id;
});

afterAll(async () => {
  expect(await reconcileBalances(ctx)).toEqual([]);
  expect(await reconcileValuations(ctx)).toEqual([]);
  await getDb().$disconnect();
});

describe("suppliers", () => {
  it("creates, rejects duplicate codes, updates and links products", async () => {
    await expectAppError(createSupplier(ctx, { code: "nile-mills", name: "Again" }), "CONFLICT");
    await expectAppError(createSupplier(ctx, { code: "X", name: "" }), "VALIDATION_FAILED");
    await updateSupplier(ctx, supplierId, {
      code: "NILE-MILLS",
      name: "Nile Mills Co.",
      email: "orders@nile-mills.example",
      leadTimeDays: "2",
    });
    await saveSupplierProduct(ctx, supplierId, {
      productId: eggs,
      purchaseUomId: units.case,
      supplierSku: "EG-30",
      lastUnitPrice: "150",
    });
    // A purchase unit that cannot convert to the product's base unit is refused.
    await expectAppError(
      saveSupplierProduct(ctx, supplierId, { productId: flour, purchaseUomId: units.l }),
      "BUSINESS_RULE_VIOLATION",
    );
    const { supplier, products } = await getSupplier(ctx, supplierId);
    expect(supplier.name).toBe("Nile Mills Co.");
    expect(
      products.map((p) => [p.product.sku, p.purchaseUom.code, p.lastUnitPrice?.toFixed()]),
    ).toEqual([["EGGS", "case", "150"]]);
  });
});

describe("purchase orders and approval", () => {
  it("builds a draft with exact totals and refuses duplicate products", async () => {
    const { id, number } = await createOrder(ctx, { supplierId, warehouseId: mainWh });
    expect(number).toMatch(/^PO-\d{4}-\d{6}$/);
    await addOrderLine(ctx, id, {
      productId: flour,
      uomId: units.kg,
      quantity: "12.5",
      unitPrice: "4.4",
    });
    await addOrderLine(ctx, id, {
      productId: eggs,
      uomId: units.case,
      quantity: "3",
      unitPrice: "0.333333",
    });
    await expectAppError(
      addOrderLine(ctx, id, { productId: flour, uomId: units.g, quantity: "1", unitPrice: "1" }),
      "CONFLICT",
    );
    let order = await getOrder(ctx, id);
    expect(order.totalAmount.toFixed()).toBe("56"); // 55 + 1
    expect(order.lines.map((l) => l.quantityBase.toFixed())).toEqual(["12.5", "90"]);
    await removeOrderLine(ctx, id, order.lines[1].id);
    order = await getOrder(ctx, id);
    expect(order.totalAmount.toFixed()).toBe("55");
    await expectAppError(
      submitOrder(ctx, (await createOrder(ctx, { supplierId, warehouseId: mainWh })).id),
      "BUSINESS_RULE_VIOLATION",
    ); // no lines
  });

  it("approves on submit without a threshold; above a threshold another user must approve", async () => {
    const auto = await approvedOrder([
      { productId: flour, uomId: units.kg, quantity: "1", unitPrice: "100" },
    ]);
    expect(auto.status).toBe("APPROVED");
    expect(auto.autoApproved).toBe(true);

    // Single-approver mode: no branch steps, no head office (ADR-023 rule).
    await updateProcurementSettings(ctx, {
      approvalThreshold: "500",
      overReceiptTolerancePercent: "0",
      branchApprovalSteps: "0",
      headOfficeApproval: "false",
    });
    const small = await approvedOrder([
      { productId: flour, uomId: units.kg, quantity: "5", unitPrice: "100" },
    ]);
    expect(small.status).toBe("APPROVED"); // at the threshold
    const { id } = await createOrder(ctx, { supplierId, warehouseId: mainWh });
    await addOrderLine(ctx, id, {
      productId: flour,
      uomId: units.kg,
      quantity: "6",
      unitPrice: "100",
    });
    expect((await submitOrder(ctx, id)).status).toBe("PENDING_APPROVAL");
    await expectAppError(
      addOrderLine(ctx, id, { productId: eggs, uomId: units.each, quantity: "1", unitPrice: "1" }),
      "BUSINESS_RULE_VIOLATION",
    ); // no edits after submit
    await expectAppError(approveOrder(ctx, id), "BUSINESS_RULE_VIOLATION"); // self-approval

    const finance = await addMember(ctx, "finance");
    await rejectOrder(finance.ctx, id, { reason: "Use the framework price" });
    let order = await getOrder(ctx, id);
    expect(order.status).toBe("DRAFT");
    expect(order.rejectionNote).toBe("Use the framework price");
    await submitOrder(ctx, id);
    await expectAppError(approveOrder((await addMember(ctx, "warehouse")).ctx, id), "FORBIDDEN");
    await approveOrder(finance.ctx, id);
    order = await getOrder(ctx, id);
    expect(order.status).toBe("APPROVED");
    expect(order.autoApproved).toBe(false);
    expect(order.names.approvedBy).toBe(finance.user.name);
    await updateProcurementSettings(ctx, {
      approvalThreshold: "",
      overReceiptTolerancePercent: "0",
    });
  });

  it("runs the approval chain: two branch approvers, then head office (ADR-049)", async () => {
    await updateProcurementSettings(ctx, {
      approvalThreshold: "0",
      overReceiptTolerancePercent: "0",
    });
    const buyer = await addMember(ctx, "procurement", { scopeType: "BRANCH", branchId });
    const local1 = await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId });
    const local2 = await addMember(ctx, "branch_manager", {
      scopeType: "WAREHOUSE",
      warehouseId: mainWh,
    });
    const finance = await addMember(ctx, "finance"); // organization-wide approver = head office
    const otherBranch = (await createBranch(ctx, { code: "ALX", name: "Alex", type: "RESTAURANT" }))
      .id;
    const outsider = await addMember(ctx, "branch_manager", {
      scopeType: "BRANCH",
      branchId: otherBranch,
    });

    const { id } = await createOrder(buyer.ctx, { supplierId, warehouseId: mainWh });
    await addOrderLine(buyer.ctx, id, {
      productId: flour,
      uomId: units.kg,
      quantity: "2",
      unitPrice: "50",
    });
    expect((await submitOrder(buyer.ctx, id)).status).toBe("PENDING_APPROVAL");
    let order = await getOrder(local1.ctx, id);
    expect(order.approvalSteps.map((s) => s.level)).toEqual(["BRANCH", "BRANCH", "HEAD_OFFICE"]);
    expect(order.can.approve).toBe(true);

    // Head office and other branches cannot sign the branch steps; the author never.
    expect((await getOrder(finance.ctx, id)).approvalBlocked).toBe("LEVEL");
    await expectAppError(approveOrder(finance.ctx, id), "BUSINESS_RULE_VIOLATION");
    await expectAppError(approveOrder(ctx, id), "BUSINESS_RULE_VIOLATION"); // owner = head office
    await expectAppError(approveOrder(outsider.ctx, id), "NOT_FOUND");
    await expectAppError(approveOrder(buyer.ctx, id), "FORBIDDEN"); // no approval right

    expect(await approveOrder(local1.ctx, id)).toMatchObject({
      status: "PENDING_APPROVAL",
      step: 1,
      of: 3,
    });
    await expectAppError(approveOrder(local1.ctx, id), "BUSINESS_RULE_VIOLATION"); // same person twice
    expect((await getOrder(local1.ctx, id)).approvalBlocked).toBe("ALREADY_SIGNED");
    expect(await approveOrder(local2.ctx, id)).toMatchObject({ step: 2 });
    await expectAppError(approveOrder(local1.ctx, id), "BUSINESS_RULE_VIOLATION"); // HO step now

    // Head office sends it back: the chain starts again on resubmission.
    await rejectOrder(finance.ctx, id, { reason: "Wrong supplier" });
    order = await getOrder(ctx, id);
    expect(order).toMatchObject({ status: "DRAFT", rejectionNote: "Wrong supplier" });
    await submitOrder(buyer.ctx, id);
    order = await getOrder(ctx, id);
    expect(order.approvalSteps.every((s) => s.signedAt === null)).toBe(true);
    await approveOrder(local2.ctx, id);
    await approveOrder(local1.ctx, id);
    expect(await approveOrder(finance.ctx, id)).toMatchObject({ status: "APPROVED", step: 3 });
    order = await getOrder(ctx, id);
    expect(order).toMatchObject({ status: "APPROVED", autoApproved: false });
    expect(order.names.approvedBy).toBe(finance.user.name);
    expect(order.approvalSteps.map((s) => s.signedBy)).toEqual([
      local2.user.name,
      local1.user.name,
      finance.user.name,
    ]);
    const history = await getDb().purchaseOrderApproval.findMany({
      where: { purchaseOrderId: id },
    });
    expect(history.map((h) => h.round).sort()).toEqual([1, 1, 2, 2, 2]);

    // The database refuses an approval row by the order's author, whatever the code path.
    const { id: other } = await createOrder(buyer.ctx, { supplierId, warehouseId: mainWh });
    await addOrderLine(buyer.ctx, other, {
      productId: flour,
      uomId: units.kg,
      quantity: "1",
      unitPrice: "5",
    });
    await submitOrder(buyer.ctx, other);
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.purchaseOrderApproval.create({
          data: {
            organizationId: ctx.organizationId,
            purchaseOrderId: other,
            round: 1,
            step: 1,
            level: "BRANCH",
            approvedByUserId: buyer.user.id,
          },
        }),
      ),
    ).rejects.toThrow();
    await cancelOrder(buyer.ctx, other, { reason: "test" });
    await updateProcurementSettings(ctx, {
      approvalThreshold: "",
      overReceiptTolerancePercent: "0",
    });
  });

  it("cancels drafts and approved orders without receipts", async () => {
    const order = await approvedOrder([
      { productId: flour, uomId: units.kg, quantity: "1", unitPrice: "1" },
    ]);
    await expectAppError(cancelOrder(ctx, order.id, { reason: "" }), "VALIDATION_FAILED");
    await cancelOrder(ctx, order.id, { reason: "Ordered by mistake" });
    expect((await getOrder(ctx, order.id)).status).toBe("CANCELLED");
    await expectAppError(
      postReceipt(ctx, order.id, {
        lines: [receiveLine(order.lines[0].id, { receivedQuantity: "1", unitPrice: "1" })],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });
});

describe("receiving", () => {
  it("posts accepted stock at the price charged, records rejections, and tracks progress", async () => {
    const order = await approvedOrder(
      [{ productId: flour, uomId: units.kg, quantity: "10", unitPrice: "20" }],
      mainWh,
      future(1),
    );
    const receipt = await postReceipt(ctx, order.id, {
      deliveryNoteRef: "DN-1001",
      lines: [
        receiveLine(order.lines[0].id, {
          receivedQuantity: "6",
          rejectedQuantity: "1",
          rejectionReason: "DAMAGED",
          unitPrice: "21",
        }),
      ],
    });
    expect(receipt.number).toMatch(/^GRN-\d{4}-\d{6}$/);
    expect(receipt.orderStatus).toBe("PARTIALLY_RECEIVED");
    expect(await stock(flour, mainWh)).toBe("5");
    expect(await valueOf(flour, mainWh)).toBe("105"); // 5 × 21, the price charged

    const detail = await getReceipt(ctx, receipt.id);
    expect(detail.document?.number).toMatch(/^RCV-/);
    expect(detail.lines[0]).toMatchObject({ rejectionReason: "DAMAGED" });
    expect(detail.lines[0].acceptedQuantity.toFixed()).toBe("5");
    const entry = await getDb().inventoryLedgerEntry.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, documentId: detail.document!.id },
    });
    expect(entry).toMatchObject({
      movementType: "RECEIPT",
      costSource: "ENTERED",
      sourceLineId: detail.lines[0].id,
    });

    // Rejected goods never enter stock and do not count as received.
    const after = await getOrder(ctx, order.id);
    expect(after.lines[0].receivedQuantityBase.toFixed()).toBe("5");
    expect(after.lines[0].openQuantityBase.toFixed()).toBe("5");
    // The supplier's last price follows the receipt.
    const { products } = await getSupplier(ctx, supplierId);
    expect(products.find((p) => p.product.sku === "FLOUR")?.lastUnitPrice?.toFixed()).toBe("21");
  });

  it("blocks over-receipt beyond the tolerance and allows it within", async () => {
    const order = await approvedOrder([
      { productId: flour, uomId: units.kg, quantity: "10", unitPrice: "20" },
    ]);
    const line = order.lines[0].id;
    await postReceipt(ctx, order.id, {
      lines: [receiveLine(line, { receivedQuantity: "8", unitPrice: "20" })],
    });
    try {
      await postReceipt(ctx, order.id, {
        lines: [receiveLine(line, { receivedQuantity: "3", unitPrice: "20" })],
      });
      throw new Error("expected OVER_RECEIPT");
    } catch (error) {
      expect((error as { details?: Record<string, unknown> }).details).toMatchObject({
        rule: "OVER_RECEIPT",
        field: "lines.0.receivedQuantity",
        maximum: "2",
      });
    }
    await updateProcurementSettings(ctx, {
      approvalThreshold: "",
      overReceiptTolerancePercent: "10",
    });
    const r = await postReceipt(ctx, order.id, {
      lines: [receiveLine(line, { receivedQuantity: "3", unitPrice: "20" })],
    });
    expect(r.orderStatus).toBe("RECEIVED");
    await expectAppError(
      postReceipt(ctx, order.id, {
        lines: [receiveLine(line, { receivedQuantity: "0.1", unitPrice: "20" })],
      }),
      "BUSINESS_RULE_VIOLATION",
    ); // fully received orders cannot take more
    await updateProcurementSettings(ctx, {
      approvalThreshold: "",
      overReceiptTolerancePercent: "0",
    });
  });

  it("converts pack units, requires lots, expiry and temperature, and quarantines on request", async () => {
    const order = await approvedOrder(
      [
        { productId: eggs, uomId: units.case, quantity: "2", unitPrice: "150" },
        { productId: milk, uomId: units.l, quantity: "40", unitPrice: "30" },
      ],
      kitchenWh,
    );
    const [eggLine, milkLine] = order.lines;
    const attempt = (milkFields: Record<string, string>) =>
      postReceipt(ctx, order.id, {
        lines: [
          receiveLine(eggLine.id, { receivedQuantity: "2", unitPrice: "150", lotCode: "e-0001" }),
          receiveLine(milkLine.id, { receivedQuantity: "40", unitPrice: "30", ...milkFields }),
        ],
      });
    const fieldOf = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (error) {
        const d = (error as { details?: { field?: string; issues?: Array<{ path: string }> } })
          .details;
        return d?.field ?? d?.issues?.[0]?.path;
      }
      throw new Error("expected a failure");
    };
    expect(await fieldOf(attempt({ expiresOn: future(5), temperatureCelsius: "4" }))).toBe(
      "lines.1.lotCode",
    );
    expect(await fieldOf(attempt({ lotCode: "M-1", temperatureCelsius: "4" }))).toBe(
      "lines.1.expiresOn",
    );
    expect(await fieldOf(attempt({ lotCode: "M-1", expiresOn: future(5) }))).toBe(
      "lines.1.temperatureCelsius",
    );
    await expectAppError(
      attempt({ lotCode: "M-OLD", expiresOn: future(-2), temperatureCelsius: "4" }),
      "BUSINESS_RULE_VIOLATION",
    ); // expired goods cannot be accepted
    await attempt({
      lotCode: "M-1",
      expiresOn: future(5),
      temperatureCelsius: "4.5",
      quarantine: "on",
    });
    expect(await stock(eggs, kitchenWh)).toBe("60"); // 2 cases × 30
    expect(await stock(milk, kitchenWh, "QUARANTINE")).toBe("40");
    expect(await stock(milk, kitchenWh, "AVAILABLE")).toBe("0");
    expect(await valueOf(eggs, kitchenWh)).toBe("300");
    // Nothing from the failed attempts was kept (one transaction per receipt).
    expect(
      await getDb().inventoryLot.count({
        where: { organizationId: ctx.organizationId, lotCode: "M-OLD" },
      }),
    ).toBe(0);
  });

  it("records an all-rejected delivery without touching stock", async () => {
    const order = await approvedOrder(
      [{ productId: flour, uomId: units.kg, quantity: "4", unitPrice: "20" }],
      kitchenWh,
    );
    const before = await stock(flour, kitchenWh);
    const r = await postReceipt(ctx, order.id, {
      lines: [
        receiveLine(order.lines[0].id, {
          receivedQuantity: "4",
          rejectedQuantity: "4",
          rejectionReason: "QUALITY",
          unitPrice: "20",
        }),
      ],
    });
    expect(r.orderStatus).toBe("APPROVED");
    expect((await getReceipt(ctx, r.id)).document).toBeNull();
    expect(await stock(flour, kitchenWh)).toBe(before);
    await expectAppError(
      postReceipt(ctx, order.id, {
        lines: [
          receiveLine(order.lines[0].id, {
            receivedQuantity: "1",
            rejectedQuantity: "1",
            unitPrice: "20",
          }),
        ],
      }),
      "VALIDATION_FAILED",
    ); // rejections need a reason
    await expectAppError(
      postReceipt(ctx, order.id, {
        lines: [receiveLine(order.lines[0].id, { receivedQuantity: "0", unitPrice: "20" })],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("reverses a receipt: stock and value out, order quantities back", async () => {
    const order = await approvedOrder(
      [{ productId: flour, uomId: units.kg, quantity: "10", unitPrice: "30" }],
      kitchenWh,
    );
    const valueBefore = await valueOf(flour, kitchenWh);
    const r = await postReceipt(ctx, order.id, {
      lines: [receiveLine(order.lines[0].id, { receivedQuantity: "10", unitPrice: "300" })], // wrong price
    });
    const detail = await getReceipt(ctx, r.id);
    await expectAppError(
      reverseDocument(ctx, detail.document!.id, { reasonCode: "ENTERED_IN_ERROR" }),
      "BUSINESS_RULE_VIOLATION",
    ); // receipts are reversed from purchasing
    const warehouse = await addMember(ctx, "warehouse");
    await expectAppError(
      reverseReceipt(warehouse.ctx, r.id, { reasonCode: "ENTERED_IN_ERROR" }),
      "FORBIDDEN",
    );
    const result = await reverseReceipt(ctx, r.id, {
      reasonCode: "ENTERED_IN_ERROR",
      note: "Wrong price",
    });
    expect(result.orderStatus).toBe("APPROVED");
    expect(await valueOf(flour, kitchenWh)).toBe(valueBefore); // the wrong value is fully removed
    const reversed = await getReceipt(ctx, r.id);
    expect(reversed.status).toBe("REVERSED");
    expect(reversed.reversal?.number).toMatch(/^REV-/);
    expect((await getOrder(ctx, order.id)).lines[0].receivedQuantityBase.toFixed()).toBe("0");
    await expectAppError(
      reverseReceipt(ctx, r.id, { reasonCode: "ENTERED_IN_ERROR" }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("refuses to reverse a receipt whose stock was used", async () => {
    const order = await approvedOrder([
      { productId: eggs, uomId: units.each, quantity: "30", unitPrice: "5" },
    ]);
    const r = await postReceipt(ctx, order.id, {
      lines: [
        receiveLine(order.lines[0].id, {
          receivedQuantity: "30",
          unitPrice: "5",
          lotCode: "E-USED",
        }),
      ],
    });
    const lot = await getDb().inventoryLot.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, productId: eggs, lotCode: "E-USED" },
    });
    await postWriteOff(ctx, {
      warehouseId: mainWh,
      productId: eggs,
      lotId: lot.id,
      stockStatus: "AVAILABLE",
      quantity: "1",
      uomId: units.each,
      reasonCode: "DAMAGED",
    });
    await expectAppError(
      reverseReceipt(ctx, r.id, { reasonCode: "WRONG_QUANTITY" }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await getReceipt(ctx, r.id)).status).toBe("POSTED");
  });

  it("short-closes a partly received order", async () => {
    const order = await approvedOrder([
      { productId: flour, uomId: units.kg, quantity: "10", unitPrice: "20" },
    ]);
    await postReceipt(ctx, order.id, {
      lines: [receiveLine(order.lines[0].id, { receivedQuantity: "4", unitPrice: "20" })],
    });
    await expectAppError(cancelOrder(ctx, order.id, { reason: "x" }), "BUSINESS_RULE_VIOLATION");
    await closeOrder(ctx, order.id, { reason: "Supplier out of stock" });
    expect((await getOrder(ctx, order.id)).status).toBe("CLOSED");
    await expectAppError(
      postReceipt(ctx, order.id, {
        lines: [receiveLine(order.lines[0].id, { receivedQuantity: "1", unitPrice: "20" })],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("serializes concurrent receipts so an order cannot be over-received", async () => {
    const order = await approvedOrder([
      { productId: flour, uomId: units.kg, quantity: "5", unitPrice: "10" },
    ]);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        postReceipt(ctx, order.id, {
          lines: [receiveLine(order.lines[0].id, { receivedQuantity: "5", unitPrice: "10" })],
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getOrder(ctx, order.id)).lines[0].receivedQuantityBase.toFixed()).toBe("5");
  });

  it("posts a receipt once for the same submission", async () => {
    const order = await approvedOrder([
      { productId: flour, uomId: units.kg, quantity: "2", unitPrice: "10" },
    ]);
    const input = {
      idempotencyKey: crypto.randomUUID(),
      lines: [receiveLine(order.lines[0].id, { receivedQuantity: "1", unitPrice: "10" })],
    };
    const a = await postReceipt(ctx, order.id, input);
    const b = await postReceipt(ctx, order.id, input);
    expect(b.id).toBe(a.id);
    expect((await getOrder(ctx, order.id)).lines[0].receivedQuantityBase.toFixed()).toBe("1");
  });
});

describe("supplier performance", () => {
  it("scores real receipts only", async () => {
    const { id } = await createSupplier(ctx, { code: "DELTA", name: "Delta Dairy" });
    const { performance: empty } = await getSupplier(ctx, id);
    expect(empty).toMatchObject({
      receipts: 0,
      onTimeRate: null,
      fillRate: null,
      rejectionRate: null,
    });

    const { id: orderId } = await createOrder(ctx, {
      supplierId: id,
      warehouseId: mainWh,
      expectedOn: future(1),
    });
    await addOrderLine(ctx, orderId, {
      productId: flour,
      uomId: units.kg,
      quantity: "10",
      unitPrice: "20",
    });
    await submitOrder(ctx, orderId);
    const order = await getOrder(ctx, orderId);
    await postReceipt(ctx, orderId, {
      lines: [
        receiveLine(order.lines[0].id, {
          receivedQuantity: "10",
          rejectedQuantity: "2",
          rejectionReason: "DAMAGED",
          unitPrice: "21",
        }),
      ],
    });
    await closeOrder(ctx, orderId, { reason: "Rest not needed" });
    const { performance } = await getSupplier(ctx, id);
    expect(performance.receipts).toBe(1);
    expect(performance.onTimeRate?.toFixed()).toBe("1"); // received before the expected date
    expect(performance.fillRate?.toFixed()).toBe("0.8");
    expect(performance.rejectionRate?.toFixed()).toBe("0.2");
    expect(performance.priceVariance.toFixed()).toBe("8"); // (21 − 20) × 8 accepted

    await expectAppError(setSupplierArchived(ctx, supplierId, true), "BUSINESS_RULE_VIOLATION"); // has open orders
    await setSupplierArchived(ctx, id, true);
    await expectAppError(
      createOrder(ctx, { supplierId: id, warehouseId: mainWh }),
      "BUSINESS_RULE_VIOLATION",
    );
  });
});

describe("access and isolation", () => {
  it("lets each role do only its part", async () => {
    const order = await approvedOrder([
      { productId: flour, uomId: units.kg, quantity: "3", unitPrice: "10" },
    ]);
    const warehouse = await addMember(ctx, "warehouse");
    await expectAppError(
      createOrder(warehouse.ctx, { supplierId, warehouseId: mainWh }),
      "FORBIDDEN",
    );
    await expectAppError(createSupplier(warehouse.ctx, { code: "W", name: "W" }), "FORBIDDEN");
    await postReceipt(warehouse.ctx, order.id, {
      lines: [receiveLine(order.lines[0].id, { receivedQuantity: "3", unitPrice: "10" })],
    });
    const analyst = await addMember(ctx, "analyst");
    expect((await listOrders(analyst.ctx)).total).toBeGreaterThan(0);
    await expectAppError(
      postReceipt(analyst.ctx, order.id, {
        lines: [receiveLine(order.lines[0].id, { receivedQuantity: "1", unitPrice: "1" })],
      }),
      "FORBIDDEN",
    );
    await expectAppError(
      updateProcurementSettings(analyst.ctx, { overReceiptTolerancePercent: "50" }),
      "FORBIDDEN",
    );
  });

  it("scopes orders to the user's warehouses", async () => {
    const kitchenOrder = await approvedOrder(
      [{ productId: flour, uomId: units.kg, quantity: "1", unitPrice: "1" }],
      kitchenWh,
    );
    const mainOrder = await approvedOrder(
      [{ productId: flour, uomId: units.kg, quantity: "1", unitPrice: "1" }],
      mainWh,
    );
    const scoped = await addMember(ctx, "branch_manager", {
      scopeType: "WAREHOUSE",
      warehouseId: kitchenWh,
    });
    const visible = await listOrders(scoped.ctx);
    expect(visible.items.every((o) => o.warehouse.id === kitchenWh)).toBe(true);
    expect((await getOrder(scoped.ctx, kitchenOrder.id)).id).toBe(kitchenOrder.id);
    await expectAppError(getOrder(scoped.ctx, mainOrder.id), "NOT_FOUND");
    await expectAppError(createOrder(scoped.ctx, { supplierId, warehouseId: mainWh }), "NOT_FOUND");
  });

  it("keeps other tenants out", async () => {
    const order = await approvedOrder([
      { productId: flour, uomId: units.kg, quantity: "1", unitPrice: "1" },
    ]);
    const { ctx: other } = await createTenant("procurement-other");
    await expectAppError(getOrder(other, order.id), "NOT_FOUND");
    await expectAppError(getSupplier(other, supplierId), "NOT_FOUND");
    await expectAppError(
      postReceipt(other, order.id, {
        lines: [receiveLine(order.lines[0].id, { receivedQuantity: "1", unitPrice: "1" })],
      }),
      "NOT_FOUND",
    );
    expect((await listOrders(other)).total).toBe(0);
    const leaked = await withTenantTx(other.organizationId, (tx) =>
      tx.purchaseOrder.count({ where: { organizationId: ctx.organizationId } }),
    );
    expect(leaked).toBe(0);
  });

  it("rejects edits of receipt lines", async () => {
    await expect(
      getDb()
        .$executeRaw`UPDATE "goods_receipt_lines" SET "accepted_quantity" = 0 WHERE "organization_id" = ${ctx.organizationId}::uuid`,
    ).rejects.toThrow();
  });
});
