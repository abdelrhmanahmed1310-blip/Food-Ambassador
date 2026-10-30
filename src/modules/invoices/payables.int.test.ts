import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { Decimal } from "@/lib/decimal";
import { createSupplier } from "@/modules/procurement/suppliers";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  exportPayablesDocumentsCsv,
  exportPayablesJournalCsv,
  updateAccountingSettings,
} from "./accounting";
import {
  allocateSettlement,
  getSettlement,
  openInvoicesOf,
  recordCreditNote,
  recordPayment,
  supplierBalances,
  supplierStatement,
  voidSettlement,
} from "./payables";
import {
  addChargeLine,
  cancelInvoice,
  createInvoice,
  getInvoice,
  inputVatSummary,
  postInvoice,
} from "./service";

let ctx: TenantContext;
let supplierId: string;
let otherSupplierId: string;
let codes: Record<string, string>;
let invoiceNo = 0;

/** A posted invoice of one charge: `net` + 15 % VAT. */
async function postedInvoice(supplier: string, invoiceDate: string, net: string, dueDate?: string) {
  const gross = new Decimal(net).times("1.15").toFixed();
  const { id, number } = await createInvoice(ctx, {
    supplierId: supplier,
    supplierInvoiceNo: `INV-${++invoiceNo}`,
    invoiceDate,
    dueDate,
    printedGross: gross,
  });
  await addChargeLine(ctx, id, { description: "Goods", netAmount: net });
  await postInvoice(ctx, id);
  return { id, number };
}

const open = async (invoiceId: string) => (await getInvoice(ctx, invoiceId)).open.toFixed();

beforeAll(async () => {
  ({ ctx } = await createTenant("payables"));
  supplierId = (
    await createSupplier(ctx, { code: "MILL", name: "Mill Co", paymentTermsDays: "30" })
  ).id;
  otherSupplierId = (await createSupplier(ctx, { code: "DAIRY", name: "Dairy" })).id;
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
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("supplier payables", () => {
  it("applies payments explicitly and oldest first, keeps the rest on account and ages what is open", async () => {
    const a = await postedInvoice(supplierId, "2026-07-01", "100"); // 115, due 07-31
    const b = await postedInvoice(supplierId, "2026-09-15", "200"); // 230, due 10-15
    const c = await postedInvoice(supplierId, "2026-10-20", "100"); // 115, due 11-19

    const p1 = await recordPayment(ctx, {
      supplierId,
      date: "2026-10-01",
      amount: "50",
      method: "BANK_TRANSFER",
      reference: "TRF-1",
      allocations: [{ invoiceId: b.id, amount: "50" }],
    });
    expect(p1.number).toMatch(/^PAY-2026-\d{6}$/);
    expect(await open(b.id)).toBe("180");
    expect((await getInvoice(ctx, b.id)).paymentStatus).toBe("PARTLY_PAID");

    // 400 oldest first: a (115), b (180), c (105 of 115); nothing left over.
    await recordPayment(ctx, {
      supplierId,
      date: "2026-10-25",
      amount: "400",
      method: "CASH",
      autoAllocate: "on",
    });
    expect([await open(a.id), await open(b.id), await open(c.id)]).toEqual(["0", "0", "10"]);
    expect((await getInvoice(ctx, a.id)).paymentStatus).toBe("PAID");

    // A payment not applied to an invoice stays on account.
    const over = await recordPayment(ctx, {
      supplierId,
      date: "2026-10-28",
      amount: "30",
      method: "CHEQUE",
    });
    expect((await getSettlement(ctx, over.id)).unapplied.toFixed()).toBe("30");

    const on = await supplierBalances(ctx, "2026-10-31");
    const mill = on.rows.find((r) => r.supplier.id === supplierId)!;
    expect([
      mill.invoiced.toFixed(),
      mill.settled.toFixed(),
      mill.balance.toFixed(),
      mill.unapplied.toFixed(),
    ]).toEqual(["460", "480", "-20", "30"]);
    expect(mill.aging.CURRENT.toFixed()).toBe("10");

    // On 1 October (after the first 50): a is 62 days overdue, b not yet due.
    const sept = await supplierBalances(ctx, "2026-10-01");
    const early = sept.rows.find((r) => r.supplier.id === supplierId)!;
    expect(early.balance.toFixed()).toBe("295");
    expect(early.aging.D61_90.toFixed()).toBe("115");
    expect(early.aging.D1_30.toFixed()).toBe("0");
    expect(early.aging.CURRENT.toFixed()).toBe("180");

    const st = await supplierStatement(ctx, supplierId, { from: "2026-09-01", to: "2026-10-31" });
    expect(st.opening.toFixed()).toBe("115");
    expect(st.lines.map((l) => [l.kind, l.balance.toFixed()])).toEqual([
      ["INVOICE", "345"],
      ["PAYMENT", "295"],
      ["INVOICE", "410"],
      ["PAYMENT", "10"],
      ["PAYMENT", "-20"],
    ]);
    expect(st.closing.toFixed()).toBe("-20");
    expect(st.open.map((i) => i.id)).toEqual([c.id]);
    expect(st.unapplied.map((s) => s.unapplied.toFixed())).toEqual(["30"]);

    // Part of the cheque goes to c, no more than c has open.
    await expectAppError(
      allocateSettlement(ctx, over.id, { allocations: [{ invoiceId: c.id, amount: "15" }] }),
      "BUSINESS_RULE_VIOLATION",
    );
    await allocateSettlement(ctx, over.id, { allocations: [{ invoiceId: c.id, amount: "10" }] });
    expect(await open(c.id)).toBe("0");
    await expectAppError(
      allocateSettlement(ctx, over.id, { allocations: [{ invoiceId: c.id, amount: "5" }] }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await getSettlement(ctx, over.id)).unapplied.toFixed()).toBe("20");
    // Nothing is open to apply the rest to; another supplier's invoice is refused.
    await expectAppError(
      allocateSettlement(ctx, over.id, { autoAllocate: "on" }),
      "BUSINESS_RULE_VIOLATION",
    );
    const dairy = await postedInvoice(otherSupplierId, "2026-10-01", "10");
    await expectAppError(
      recordPayment(ctx, {
        supplierId,
        date: "2026-10-29",
        amount: "5",
        method: "CASH",
        allocations: [{ invoiceId: dairy.id, amount: "5" }],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    // More decimals than the riyal has.
    await expectAppError(
      recordPayment(ctx, { supplierId, date: "2026-10-29", amount: "5.005", method: "CASH" }),
      "BUSINESS_RULE_VIOLATION",
    );

    // A paid invoice cannot be cancelled until its payment is voided.
    await expectAppError(cancelInvoice(ctx, a.id, { reason: "x" }), "BUSINESS_RULE_VIOLATION");
    const finance = (await addMember(ctx, "finance")).ctx;
    const p2 = (await getInvoice(ctx, a.id)).allocations[0].settlement.id;
    await voidSettlement(finance, p2, { reason: "Bounced" });
    await expectAppError(
      voidSettlement(finance, p2, { reason: "again" }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect(await open(a.id)).toBe("115");
    expect(await open(b.id)).toBe("180");
    expect((await getSettlement(ctx, p2)).names.voidedBy).toBeTruthy();
  });

  it("records credit notes with VAT that reduce the balance and input VAT", async () => {
    const inv = await postedInvoice(supplierId, "2026-11-02", "1000"); // 1150
    const cn = await recordCreditNote(ctx, {
      supplierId,
      supplierDocumentNo: "CN-77",
      date: "2026-11-05",
      netAmount: "100",
      note: "Short delivery of 10 kg",
      allocations: [{ invoiceId: inv.id, amount: "115" }],
    });
    expect(cn.number).toMatch(/^SCN-2026-\d{6}$/);
    const s = await getSettlement(ctx, cn.id);
    expect([
      s.netAmount?.toFixed(),
      s.taxAmount.toFixed(),
      s.amount.toFixed(),
      s.taxRate?.toFixed(),
    ]).toEqual(["100", "15", "115", "0.15"]);
    expect(await open(inv.id)).toBe("1035");
    await expectAppError(
      recordCreditNote(ctx, {
        supplierId,
        supplierDocumentNo: "CN-77",
        date: "2026-11-06",
        netAmount: "1",
        note: "dup",
      }),
      "CONFLICT",
    );
    // A zero-rated credit note.
    await recordCreditNote(ctx, {
      supplierId,
      supplierDocumentNo: "CN-78",
      date: "2026-11-06",
      netAmount: "20",
      taxCodeId: codes.ZERO,
      note: "Returned crates",
    });
    const vat = await inputVatSummary(ctx, { from: "2026-11-01", to: "2026-11-30" });
    const std = vat.rows.find((r) => r.code?.code === "STD")!;
    expect([std.tax.toFixed(), std.lines, std.credits]).toEqual(["135", 1, 1]);
    expect(vat.rows.find((r) => r.code?.code === "ZERO")?.net.toFixed()).toBe("-20");
    // Idempotent retry returns the same credit note.
    const key = "credit-note-retry-0001";
    const once = await recordCreditNote(ctx, {
      supplierId,
      supplierDocumentNo: "CN-79",
      date: "2026-11-07",
      netAmount: "1",
      note: "x",
      idempotencyKey: key,
    });
    const twice = await recordCreditNote(ctx, {
      supplierId,
      supplierDocumentNo: "CN-79",
      date: "2026-11-07",
      netAmount: "1",
      note: "x",
      idempotencyKey: key,
    });
    expect(twice.id).toBe(once.id);
    expect((await openInvoicesOf(ctx, supplierId)).map((i) => i.id)).toContain(inv.id);
  });

  it("exports documents and a balanced journal with the organization's accounts", async () => {
    const period = { from: "2026-11-01", to: "2026-11-30" };
    const docs = parseCsv((await exportPayablesDocumentsCsv(ctx, period)).replace(/^﻿/, ""));
    expect(docs[0].slice(0, 3)).toEqual(["document_type", "number", "date"]);
    const invoiceRow = docs.find((r) => r[0] === "INVOICE")!;
    expect(invoiceRow.slice(8, 13)).toEqual(["STD", "0.15", "1000.00", "150.00", "1150.00"]);
    expect(docs.filter((r) => r[0] === "CREDIT_NOTE")).toHaveLength(3);

    await expectAppError(exportPayablesJournalCsv(ctx, period), "BUSINESS_RULE_VIOLATION");
    await expectAppError(
      updateAccountingSettings(ctx, { payablesAccount: "=CMD()" }),
      "VALIDATION_FAILED",
    );
    await updateAccountingSettings(ctx, {
      payablesAccount: "2100",
      purchasesAccount: "5100",
      inputVatAccount: "1410",
      paymentsAccount: "1010",
    });
    const journal = parseCsv((await exportPayablesJournalCsv(ctx, period)).replace(/^﻿/, ""));
    const body = journal.slice(1).filter((r) => r.length > 1);
    const sum = (col: number) =>
      body.reduce((a, r) => a.plus(r[col] || "0"), new Decimal(0)).toFixed();
    expect(sum(6)).toBe(sum(7));
    const inv = body.filter((r) => r[2] === "INVOICE");
    expect(inv.map((r) => [r[5], r[6], r[7]])).toEqual([
      ["5100", "1000.00", ""],
      ["1410", "150.00", ""],
      ["2100", "", "1150.00"],
    ]);
    await expectAppError(
      exportPayablesJournalCsv(ctx, { from: "2026-12-01", to: "2026-11-01" }),
      "VALIDATION_FAILED",
    );
  });

  it("is limited by permission and tenant, and a settlement cannot be edited", async () => {
    const ops = (await addMember(ctx, "operations_manager")).ctx;
    const procurement = (await addMember(ctx, "procurement")).ctx;
    for (const who of [ops, procurement])
      await expectAppError(
        recordPayment(who, { supplierId, date: "2026-11-10", amount: "1", method: "CASH" }),
        "FORBIDDEN",
      );
    expect((await supplierBalances(procurement, "2026-11-30")).rows.length).toBeGreaterThan(0);
    await expectAppError(updateAccountingSettings(procurement, {}), "FORBIDDEN");

    const other = await createTenant("payables-other");
    const pay = await recordPayment(ctx, {
      supplierId,
      date: "2026-11-10",
      amount: "1",
      method: "CASH",
    });
    await expectAppError(getSettlement(other.ctx, pay.id), "NOT_FOUND");
    await expectAppError(voidSettlement(other.ctx, pay.id, { reason: "x" }), "NOT_FOUND");
    await expectAppError(
      recordPayment(other.ctx, { supplierId, date: "2026-11-10", amount: "1", method: "CASH" }),
      "NOT_FOUND",
    );
    expect((await supplierBalances(other.ctx, "2026-11-30")).rows).toEqual([]);

    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.supplierSettlement.update({ where: { id: pay.id }, data: { amount: "1000" } }),
      ),
    ).rejects.toThrow();
  });
});
