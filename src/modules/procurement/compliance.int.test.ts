import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { updateApprovalMatrix } from "@/modules/approvals/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { listNotifications } from "@/modules/notifications/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addSupplierBankAccount,
  addSupplierDocument,
  approveSupplier,
  archiveSupplierBankAccount,
  blockSupplier,
  revealSupplierBankAccount,
  supplierCompliance,
  unblockSupplier,
  updateSupplierDocument,
  verifySupplierBankAccount,
} from "./compliance";
import { addOrderLine, approveOrder, createOrder, submitOrder } from "./orders";
import { updateProcurementSettings } from "./settings";
import { createSupplier, listSuppliers } from "./suppliers";

/** Supplier approval, blocking, documents and bank accounts (ADR-091). */

let ctx: TenantContext; // owner
let buyer: TenantContext; // procurement
let finance: TenantContext; // finance: approves suppliers and verifies accounts
let analyst: TenantContext; // read-only
let warehouseId: string;
let flour: string;
let kg: string;

const IBAN = "SA03 8000 0000 6080 1016 7519";
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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

async function draftFor(as: TenantContext, supplierId: string) {
  const { id } = await createOrder(as, { supplierId, warehouseId });
  await addOrderLine(as, id, { productId: flour, uomId: kg, quantity: "10", unitPrice: "20" });
  return id;
}

let n = 0;
const supplierBy = async (as: TenantContext) =>
  (await createSupplier(as, { code: `S${++n}`, name: `Supplier ${n}` })).id;

beforeAll(async () => {
  ({ ctx } = await createTenant("compliance"));
  buyer = (await addMember(ctx, "procurement")).ctx;
  finance = (await addMember(ctx, "finance")).ctx;
  analyst = (await addMember(ctx, "analyst")).ctx;
  kg = (await listUnits(ctx)).find((u) => u.code === "kg")!.id;
  const branchId = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  warehouseId = (await createWarehouse(ctx, { branchId, code: "MAIN", name: "Main", type: "MAIN" }))
    .id;
  flour = (
    await createProduct(ctx, { sku: "FLOUR", nameEn: "Flour", type: "RAW_MATERIAL", baseUomId: kg })
  ).id;
  await updateProcurementSettings(ctx, { supplierApprovalRequired: "on" });
});

afterAll(async () => {
  await updateApprovalMatrix(ctx, "PURCHASE_ORDER", {});
});

describe("supplier approval (ADR-091)", () => {
  it("keeps the old behaviour while approval is not required", async () => {
    const { ctx: other } = await createTenant("compliance-off");
    const id = (await createSupplier(other, { code: "X1", name: "Open" })).id;
    expect((await supplierCompliance(other, id)).status).toBe("APPROVED");
  });

  it("holds a new supplier until someone else approves it", async () => {
    const supplierId = await supplierBy(buyer);
    expect((await supplierCompliance(buyer, supplierId)).status).toBe("PENDING_APPROVAL");
    // Approvers are told; the buyer, who added it, is not.
    expect((await listNotifications(finance)).items.map((x) => x.kind)).toContain(
      "SUPPLIER_APPROVAL_NEEDED",
    );
    expect((await listNotifications(buyer)).items.map((x) => x.kind)).not.toContain(
      "SUPPLIER_APPROVAL_NEEDED",
    );
    expect((await attentionItems(finance)).map((i) => i.key)).toContain("SUPPLIERS_TO_APPROVE");

    // An order can be prepared, not sent.
    const orderId = await draftFor(buyer, supplierId);
    await expectRule(submitOrder(buyer, orderId), "SUPPLIER_NOT_APPROVED");

    await expectAppError(approveSupplier(buyer, supplierId), "FORBIDDEN");
    await expectAppError(approveSupplier(analyst, supplierId), "FORBIDDEN");
    await approveSupplier(finance, supplierId);
    const after = await supplierCompliance(ctx, supplierId);
    expect(after.status).toBe("APPROVED");
    expect(after.approvedAt).not.toBeNull();
    expect((await submitOrder(buyer, orderId)).status).toBe("APPROVED");
    await expectRule(approveSupplier(finance, supplierId), "SUPPLIER_NOT_PENDING");
  });

  it("never lets the person who added a supplier approve it", async () => {
    const supplierId = await supplierBy(ctx);
    await expectRule(approveSupplier(ctx, supplierId), "SUPPLIER_SELF_APPROVAL");
    expect((await attentionItems(ctx)).map((i) => i.key)).not.toContain("SUPPLIERS_TO_APPROVE");
    // The database refuses it too.
    await expect(
      getDb().supplier.update({
        where: { id: supplierId },
        data: { status: "APPROVED", approvedAt: new Date(), approvedByUserId: ctx.userId },
      }),
    ).rejects.toThrow();
    await approveSupplier(finance, supplierId);
  });

  it("filters the list by approval state", async () => {
    const pending = await supplierBy(buyer);
    const list = await listSuppliers(ctx, { approval: "PENDING_APPROVAL" });
    expect(list.items.map((s) => s.id)).toContain(pending);
    expect(list.items.every((s) => s.status === "PENDING_APPROVAL")).toBe(true);
  });

  it("is invisible to other organizations", async () => {
    const supplierId = await supplierBy(buyer);
    const { ctx: other } = await createTenant("compliance-other");
    await expectAppError(approveSupplier(other, supplierId), "NOT_FOUND");
    await expectAppError(supplierCompliance(other, supplierId), "NOT_FOUND");
  });
});

describe("blocking (ADR-091)", () => {
  it("stops new orders and approvals until the block is lifted", async () => {
    const supplierId = await supplierBy(buyer);
    await approveSupplier(finance, supplierId);
    // Every order now needs head-office approval, so one can wait while the supplier is blocked.
    await updateApprovalMatrix(ctx, "PURCHASE_ORDER", { layer4: "0" });
    const waiting = await draftFor(buyer, supplierId);
    expect((await submitOrder(buyer, waiting)).status).toBe("PENDING_APPROVAL");

    await expectAppError(blockSupplier(finance, supplierId, { reason: " " }), "VALIDATION_FAILED");
    await blockSupplier(finance, supplierId, { reason: "Failed hygiene audit" });
    const blocked = await supplierCompliance(ctx, supplierId);
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.blockedReason).toBe("Failed hygiene audit");

    await expectRule(createOrder(buyer, { supplierId, warehouseId }), "SUPPLIER_BLOCKED");
    await expectRule(approveOrder(finance, waiting), "SUPPLIER_BLOCKED");

    await unblockSupplier(finance, supplierId);
    expect((await supplierCompliance(ctx, supplierId)).status).toBe("APPROVED");
    expect((await approveOrder(finance, waiting)).status).toBe("APPROVED");
    await updateApprovalMatrix(ctx, "PURCHASE_ORDER", {});
  });

  it("sends a never-approved supplier back to waiting when unblocked", async () => {
    const supplierId = await supplierBy(buyer);
    await blockSupplier(finance, supplierId, { reason: "Duplicate of S1" });
    await unblockSupplier(finance, supplierId);
    expect((await supplierCompliance(ctx, supplierId)).status).toBe("PENDING_APPROVAL");
  });
});

describe("documents with expiry (ADR-091)", () => {
  it("refuses orders while a required document is expired, and flags it", async () => {
    const supplierId = await supplierBy(buyer);
    await approveSupplier(finance, supplierId);
    await expectAppError(
      addSupplierDocument(buyer, supplierId, { type: "HALAL_CERTIFICATE", requiredToBuy: "on" }),
      "VALIDATION_FAILED", // a required document needs an expiry date
    );
    await expectAppError(
      addSupplierDocument(buyer, supplierId, { type: "OTHER" }),
      "VALIDATION_FAILED", // "Other" needs a title
    );
    const { id: docId } = await addSupplierDocument(buyer, supplierId, {
      type: "HALAL_CERTIFICATE",
      number: "H-1",
      expiresOn: day(-1),
      requiredToBuy: "on",
    });
    await addSupplierDocument(buyer, supplierId, {
      type: "INSURANCE",
      expiresOn: day(10),
    });
    const c = await supplierCompliance(analyst, supplierId);
    expect(c.documents.map((d) => d.state).sort()).toEqual(["EXPIRED", "EXPIRING"]);
    expect(c.expiredRequired).toBe(1);
    const keys = (await attentionItems(buyer)).map((i) => i.key);
    expect(keys).toContain("SUPPLIER_DOCUMENTS_EXPIRED");
    expect(keys).toContain("SUPPLIER_DOCUMENTS_EXPIRING");
    expect((await listSuppliers(ctx, { documents: "expired" })).items.map((s) => s.id)).toContain(
      supplierId,
    );

    // Drafting is fine; sending is not.
    const orderId = await draftFor(buyer, supplierId);
    await expectRule(submitOrder(buyer, orderId), "SUPPLIER_DOCUMENT_EXPIRED");
    await expectAppError(
      updateSupplierDocument(analyst, supplierId, docId, { type: "HALAL_CERTIFICATE" }),
      "FORBIDDEN",
    );
    await updateSupplierDocument(buyer, supplierId, docId, {
      type: "HALAL_CERTIFICATE",
      number: "H-2",
      issuedOn: day(0),
      expiresOn: day(365),
      requiredToBuy: "on",
    });
    expect((await submitOrder(buyer, orderId)).status).toBe("APPROVED");
  });
});

describe("bank accounts (ADR-091)", () => {
  it("validates, encrypts, masks and needs a second person to verify", async () => {
    const supplierId = await supplierBy(buyer);
    await expectRule(
      addSupplierBankAccount(buyer, supplierId, {
        bankName: "SNB",
        accountName: "Supplier Co",
        kind: "IBAN",
        account: "SA04 8000 0000 6080 1016 7519",
      }),
      "IBAN_CHECKSUM",
    );
    await expectRule(
      addSupplierBankAccount(buyer, supplierId, {
        bankName: "Bank of China",
        accountName: "Supplier Co",
        kind: "ACCOUNT_NUMBER",
        account: "6217 0000 1234",
      }),
      "SWIFT_REQUIRED",
    );
    await expectAppError(
      addSupplierBankAccount(analyst, supplierId, {
        bankName: "SNB",
        accountName: "Supplier Co",
        kind: "IBAN",
        account: IBAN,
      }),
      "FORBIDDEN",
    );
    const { id } = await addSupplierBankAccount(buyer, supplierId, {
      bankName: "SNB",
      accountName: "Supplier Co",
      kind: "IBAN",
      account: IBAN,
      currency: "EGP",
    });

    // Stored encrypted; only the last four in clear; never in the audit log.
    const row = await getDb().supplierBankAccount.findUniqueOrThrow({ where: { id } });
    expect(row.accountSealed).not.toContain("6080");
    expect(row.accountLast4).toBe("7519");
    const audit = await getDb().auditEvent.findMany({
      where: { organizationId: ctx.organizationId, entityId: supplierId },
    });
    expect(JSON.stringify(audit)).not.toContain("608010167519");

    // Approvers are told at once.
    expect((await listNotifications(finance)).items.map((x) => x.kind)).toContain(
      "SUPPLIER_BANK_ACCOUNT_ADDED",
    );
    expect((await attentionItems(finance)).map((i) => i.key)).toContain(
      "SUPPLIER_BANK_ACCOUNTS_TO_VERIFY",
    );

    // Masked for those who may see it; hidden from read-only users.
    const seen = await supplierCompliance(finance, supplierId);
    expect(seen.bankAccounts[0].masked).toBe("•••• 7519");
    expect(JSON.stringify(seen)).not.toContain("608010167519");
    expect((await supplierCompliance(analyst, supplierId)).bankAccounts).toEqual([]);

    // The full number for those who pay or maintain it, with an audit entry each time.
    expect((await revealSupplierBankAccount(buyer, supplierId, id)).account).toBe(
      "SA0380000000608010167519",
    );
    await expectAppError(revealSupplierBankAccount(analyst, supplierId, id), "FORBIDDEN");
    expect(
      await getDb().auditEvent.count({
        where: { organizationId: ctx.organizationId, action: "supplier.bank_account_revealed" },
      }),
    ).toBe(1);

    // Verification by someone else only.
    await expectAppError(verifySupplierBankAccount(buyer, supplierId, id), "FORBIDDEN");
    await verifySupplierBankAccount(finance, supplierId, id);
    await expectRule(verifySupplierBankAccount(finance, supplierId, id), "BANK_ACCOUNT_VERIFIED");
    expect((await supplierCompliance(ctx, supplierId)).bankAccounts[0].verifiedBy).not.toBeNull();

    // The account details never change in place.
    await expect(
      getDb().supplierBankAccount.update({ where: { id }, data: { accountLast4: "0000" } }),
    ).rejects.toThrow(/cannot change/);

    await archiveSupplierBankAccount(buyer, supplierId, id);
    expect((await supplierCompliance(ctx, supplierId)).bankAccounts).toEqual([]);
  });

  it("refuses verification by the person who added the account", async () => {
    const supplierId = await supplierBy(buyer);
    const { id } = await addSupplierBankAccount(finance, supplierId, {
      bankName: "Bank of China",
      accountName: "Supplier Co",
      kind: "ACCOUNT_NUMBER",
      account: "6217 0000 1234",
      swiftBic: "bkchcnbj",
    });
    await expectRule(
      verifySupplierBankAccount(finance, supplierId, id),
      "BANK_ACCOUNT_SELF_VERIFICATION",
    );
    await verifySupplierBankAccount(ctx, supplierId, id);
  });
});
