import { beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/decimal";
import { attentionItems } from "@/modules/analytics/attention";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { recordCreditNote } from "@/modules/invoices/payables";
import { reverseDocument } from "@/modules/inventory/operations";
import { reconcileBalances } from "@/modules/inventory/queries";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { addOrderLine, createOrder, getOrder, submitOrder } from "./orders";
import { postReceipt, reverseReceipt } from "./receipts";
import {
  addSupplierReturnLine,
  cancelSupplierReturn,
  createSupplierReturn,
  getSupplierReturn,
  linkReturnCreditNote,
  listSupplierReturns,
  postSupplierReturn,
  removeSupplierReturnLine,
  reverseSupplierReturn,
} from "./returns";
import { createSupplier } from "./suppliers";

/** Supplier returns (ADR-094). */

let ctx: TenantContext; // owner
let buyer: TenantContext; // procurement: receives and returns
let finance: TenantContext; // links credit notes
let warehouseId: string;
let supplierId: string;
let otherSupplier: string;
let flour: string;
let beans: string;
let units: Record<string, string>;
let receiptId: string;
let keys = 0;
const key = () => `return-test-${Date.now()}-${++keys}`;

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

async function onHand(productId: string) {
  const rows = await getDb().stockBalance.findMany({
    where: { organizationId: ctx.organizationId, productId, warehouseId },
  });
  return rows.reduce((s, r) => s.plus(r.onHandQuantity.toString()), new Decimal(0)).toFixed();
}

/** Receipt of 10 kg flour at 100 and 5 kg beans (lot B-1) at 50. */
async function received() {
  const { id } = await createOrder(buyer, { supplierId, warehouseId });
  await addOrderLine(buyer, id, {
    productId: flour,
    uomId: units.kg,
    quantity: "10",
    unitPrice: "100",
  });
  await addOrderLine(buyer, id, {
    productId: beans,
    uomId: units.kg,
    quantity: "5",
    unitPrice: "50",
  });
  await submitOrder(buyer, id);
  const order = await getOrder(buyer, id);
  const receipt = await postReceipt(buyer, id, {
    lines: [
      { purchaseOrderLineId: order.lines[0].id, receivedQuantity: "10", unitPrice: "100" },
      {
        purchaseOrderLineId: order.lines[1].id,
        receivedQuantity: "5",
        unitPrice: "50",
        lotCode: "B-1",
      },
    ],
  });
  return receipt.id;
}

const lineOf = async (returnId: string, productId: string) =>
  (await getSupplierReturn(buyer, returnId)).returnable.find((r) => r.productId === productId)!;

beforeAll(async () => {
  ({ ctx } = await createTenant("returns"));
  buyer = (await addMember(ctx, "procurement")).ctx;
  finance = (await addMember(ctx, "finance")).ctx;
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
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
  beans = (
    await createProduct(ctx, {
      sku: "BEANS",
      nameEn: "Beans",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
      lotTracking: "LOT",
    })
  ).id;
  supplierId = (await createSupplier(ctx, { code: "NILE", name: "Nile" })).id;
  otherSupplier = (await createSupplier(ctx, { code: "DELTA", name: "Delta" })).id;
  receiptId = await received();
});

describe("supplier returns (ADR-094)", () => {
  it("takes accepted goods back out of stock through the ledger", async () => {
    const { id } = await createSupplierReturn(buyer, {
      receiptId,
      reason: "QUALITY",
      note: "Flour infested",
      idempotencyKey: key(),
    });
    const flourLine = await lineOf(id, flour);
    const beansLine = await lineOf(id, beans);
    expect(flourLine.remaining.toFixed()).toBe("10");

    await addSupplierReturnLine(buyer, id, {
      receiptLineId: flourLine.id,
      quantity: "4",
      fromStatus: "AVAILABLE",
    });
    await expectAppError(
      addSupplierReturnLine(buyer, id, {
        receiptLineId: flourLine.id,
        quantity: "1",
        fromStatus: "AVAILABLE",
      }),
      "CONFLICT",
    );
    await expectRule(
      addSupplierReturnLine(buyer, id, {
        receiptLineId: beansLine.id,
        quantity: "6",
        fromStatus: "AVAILABLE",
      }),
      "RETURN_EXCEEDS_RECEIVED",
    );
    // From quarantine, but the beans are available: posting finds no stock there.
    const wrong = await addSupplierReturnLine(buyer, id, {
      receiptLineId: beansLine.id,
      quantity: "5",
      fromStatus: "QUARANTINE",
    });
    await expectRule(postSupplierReturn(buyer, id), "INSUFFICIENT_STOCK");
    await removeSupplierReturnLine(buyer, id, wrong.id);
    await addSupplierReturnLine(buyer, id, {
      receiptLineId: beansLine.id,
      quantity: "5",
      fromStatus: "AVAILABLE",
    });

    await postSupplierReturn(buyer, id);
    expect(await onHand(flour)).toBe("6");
    expect(await onHand(beans)).toBe("0");
    const view = await getSupplierReturn(finance, id);
    expect(view.ret.status).toBe("POSTED");
    expect(view.ret.totalAmount.toFixed()).toBe("650"); // 4 × 100 + 5 × 50
    expect(view.documents.map((d) => d.type)).toEqual(["SUPPLIER_RETURN"]);
    const entries = await getDb().inventoryLedgerEntry.findMany({
      where: { organizationId: ctx.organizationId, documentId: view.ret.inventoryDocumentId! },
    });
    expect(entries.map((e) => e.movementType)).toEqual([
      "RETURN_TO_SUPPLIER",
      "RETURN_TO_SUPPLIER",
    ]);
    expect(entries.find((e) => e.productId === beans)!.lotId).not.toBeNull();
    expect((await reconcileBalances(ctx)).length).toBe(0);

    // Lines cannot change once posted, here or in the database.
    await expectRule(removeSupplierReturnLine(buyer, id, view.lines[0].id), "RETURN_STATUS");
    await expect(
      getDb().supplierReturnLine.update({
        where: { id: view.lines[0].id },
        data: { quantity: "1" },
      }),
    ).rejects.toThrow(/cannot change/);

    // Only what is left can be returned again; the receipt cannot be undone; the ledger page cannot reverse it.
    const { id: second } = await createSupplierReturn(buyer, {
      receiptId,
      reason: "OTHER",
      idempotencyKey: key(),
    });
    const left = await lineOf(second, flour);
    expect(left.remaining.toFixed()).toBe("6");
    expect(
      (await getSupplierReturn(buyer, second)).returnable.some((r) => r.productId === beans),
    ).toBe(false);
    await expectRule(
      reverseReceipt(ctx, receiptId, { reasonCode: "ENTERED_IN_ERROR" }),
      "RECEIPT_HAS_RETURNS",
    );
    await expectRule(
      reverseDocument(ctx, view.ret.inventoryDocumentId!, { reasonCode: "ENTERED_IN_ERROR" }),
      "SUPPLIER_RETURN_REVERSE_IN_PURCHASING",
    );
    await expectAppError(cancelSupplierReturn(buyer, second, { reason: " " }), "VALIDATION_FAILED");
    await cancelSupplierReturn(buyer, second, { reason: "Duplicate" });

    // The credit note closes it: same supplier and currency, by someone who manages invoices.
    expect((await attentionItems(finance)).map((i) => i.key)).toContain(
      "SUPPLIER_RETURNS_AWAITING_CREDIT",
    );
    const other = await recordCreditNote(ctx, {
      supplierId: otherSupplier,
      supplierDocumentNo: "X-1",
      date: "2026-11-05",
      netAmount: "650",
      note: "Other supplier",
      idempotencyKey: key(),
    });
    const credit = await recordCreditNote(ctx, {
      supplierId,
      supplierDocumentNo: "CN-9",
      date: "2026-11-05",
      netAmount: "650",
      note: "Return RTS",
      idempotencyKey: key(),
    });
    await expectAppError(linkReturnCreditNote(buyer, id, { creditNoteId: credit.id }), "FORBIDDEN");
    await expectRule(
      linkReturnCreditNote(finance, id, { creditNoteId: other.id }),
      "CREDIT_NOTE_MISMATCH",
    );
    await linkReturnCreditNote(finance, id, { creditNoteId: credit.id });
    const done = await getSupplierReturn(buyer, id);
    expect(done.ret.status).toBe("CREDITED");
    expect(done.creditNote?.number).toBe(credit.number);
    await expectRule(reverseSupplierReturn(buyer, id, { reason: "x" }), "RETURN_STATUS");
    expect(
      (await listSupplierReturns(buyer, { status: "CREDITED" })).items.map((r) => r.id),
    ).toContain(id);
  });

  it("puts the goods back when the supplier refuses them", async () => {
    const rid = await received();
    const { id } = await createSupplierReturn(buyer, {
      receiptId: rid,
      reason: "DAMAGED",
      idempotencyKey: key(),
    });
    const flourLine = (await getSupplierReturn(buyer, id)).returnable.find(
      (r) => r.productId === flour && r.receipt.id === rid,
    )!;
    await addSupplierReturnLine(buyer, id, {
      receiptLineId: flourLine.id,
      quantity: "3",
      fromStatus: "AVAILABLE",
    });
    const before = await onHand(flour);
    await postSupplierReturn(buyer, id);
    expect(new Decimal(await onHand(flour)).toFixed()).toBe(new Decimal(before).minus(3).toFixed());
    await reverseSupplierReturn(buyer, id, { reason: "Supplier refused: not damaged" });
    expect(await onHand(flour)).toBe(before);
    const view = await getSupplierReturn(buyer, id);
    expect(view.ret.status).toBe("REVERSED");
    expect(view.documents.map((d) => d.type).sort()).toEqual(["REVERSAL", "SUPPLIER_RETURN"]);
    // The quantity is returnable again.
    const { id: again } = await createSupplierReturn(buyer, {
      receiptId: rid,
      reason: "DAMAGED",
      idempotencyKey: key(),
    });
    expect(
      (await getSupplierReturn(buyer, again)).returnable
        .find((r) => r.id === flourLine.id)!
        .remaining.toFixed(),
    ).toBe("10");
    expect((await reconcileBalances(ctx)).length).toBe(0);
  });

  it("is invisible to other organizations", async () => {
    const { id } = await createSupplierReturn(buyer, {
      receiptId,
      reason: "OTHER",
      idempotencyKey: key(),
    });
    const { ctx: other } = await createTenant("returns-other");
    await expectAppError(getSupplierReturn(other, id), "NOT_FOUND");
    expect((await listSupplierReturns(other)).total).toBe(0);
  });
});
