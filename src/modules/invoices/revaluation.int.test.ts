import { beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { Decimal } from "@/lib/decimal";
import { setExchangeRate } from "@/modules/fx/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createSupplier } from "@/modules/procurement/suppliers";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { exportPayablesJournalCsv, updateAccountingSettings } from "./accounting";
import { recordPayment } from "./payables";
import {
  cancelRevaluation,
  getRevaluation,
  postRevaluation,
  previewRevaluation,
} from "./revaluation";
import { addChargeLine, createInvoice, postInvoice } from "./service";

let ctx: TenantContext;
let today: string;
let supplierId: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("revaluation")); // EGP
  today = businessDate(ctx.timeZone);
  await setExchangeRate(ctx, { currency: "USD", rateDate: addDays(today, -3), rate: "48.5" });
  await setExchangeRate(ctx, { currency: "USD", rateDate: addDays(today, -1), rate: "49" });
  await setExchangeRate(ctx, { currency: "USD", rateDate: today, rate: "50" });
  supplierId = (await createSupplier(ctx, { code: "US1", name: "US Supplier", currency: "USD" }))
    .id;
  // A local supplier: never revalued.
  const local = (await createSupplier(ctx, { code: "EG1", name: "Local" })).id;
  for (const [sup, no, amount, date] of [
    [supplierId, "U-1", "100", addDays(today, -3)],
    [local, "E-1", "500", addDays(today, -3)],
  ] as const) {
    const inv = await createInvoice(ctx, {
      supplierId: sup,
      supplierInvoiceNo: no,
      invoiceDate: date,
      printedGross: amount,
    });
    await addChargeLine(ctx, inv.id, { description: "Goods", netAmount: amount });
    await postInvoice(ctx, inv.id);
  }
  // Partly paid at 49: 60 USD stay open, booked at 48.5 = 2,910 EGP.
  await recordPayment(ctx, {
    supplierId,
    date: addDays(today, -1),
    amount: "40",
    method: "BANK_TRANSFER",
    autoAllocate: "on",
  });
});

describe("period-end exchange revaluation (ADR-052)", () => {
  it("values open foreign balances at the closing rate", async () => {
    const p = await previewRevaluation(ctx, today);
    expect(p.lines).toHaveLength(1); // the EGP supplier is not revalued
    expect(p.lines[0]).toMatchObject({ currency: "USD" });
    expect(p.lines[0].openAmount.toFixed()).toBe("60");
    expect(p.lines[0].bookedBase.toFixed()).toBe("2910");
    expect(p.lines[0].revaluedBase.toFixed()).toBe("3000");
    expect(p.total.toFixed()).toBe("90"); // a loss: the payable grew
    // Before the invoice nothing was open.
    expect((await previewRevaluation(ctx, addDays(today, -20))).lines).toHaveLength(0);
    await expectAppError(
      postRevaluation(ctx, { asOf: addDays(today, -20) }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("is stored once per date, fixed, cancellable, and only by rate managers", async () => {
    await expectAppError(
      postRevaluation(ctx, { asOf: addDays(today, 1) }),
      "BUSINESS_RULE_VIOLATION",
    );
    const procurement = (await addMember(ctx, "procurement")).ctx;
    await expectAppError(postRevaluation(procurement, { asOf: today }), "FORBIDDEN");
    const rev = await postRevaluation(ctx, { asOf: today });
    expect(rev.number).toMatch(/^REV-/);
    await expectAppError(postRevaluation(ctx, { asOf: today }), "CONFLICT");
    const stored = await getRevaluation(ctx, rev.id);
    expect(stored.totalDifferenceBase.toFixed()).toBe("90");
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.fxRevaluation.update({ where: { id: rev.id }, data: { totalDifferenceBase: "0" } }),
      ),
    ).rejects.toThrow();
    await cancelRevaluation(ctx, rev.id, { reason: "Wrong closing rate" });
    await expectAppError(
      cancelRevaluation(ctx, rev.id, { reason: "again" }),
      "BUSINESS_RULE_VIOLATION",
    );
    const again = await postRevaluation(ctx, { asOf: today });
    expect(again.id).not.toBe(rev.id);
    const other = (await createTenant("revaluation-other")).ctx;
    await expectAppError(getRevaluation(other, again.id), "NOT_FOUND");
  });

  it("posts the difference on the date and reverses it the next day in the journal", async () => {
    await updateAccountingSettings(ctx, {
      payablesAccount: "2100",
      purchasesAccount: "5100",
      paymentsAccount: "1010",
      fxDifferenceAccount: "7900",
    });
    const rows = parseCsv(
      (await exportPayablesJournalCsv(ctx, { from: today, to: addDays(today, 1) })).replace(
        /^﻿/,
        "",
      ),
    )
      .slice(1)
      .filter((r) => r.length > 1);
    const pick = (type: string) =>
      rows.filter((r) => r[2] === type).map((r) => [r[1], r[5], r[6], r[7]]);
    expect(pick("FX_REVALUATION")).toEqual([
      [today, "7900", "90.00", ""],
      [today, "2100", "", "90.00"],
    ]);
    expect(pick("FX_REVALUATION_REVERSAL")).toEqual([
      [addDays(today, 1), "2100", "90.00", ""],
      [addDays(today, 1), "7900", "", "90.00"],
    ]);
    const sum = (c: number) => rows.reduce((a, r) => a.plus(r[c] || "0"), new Decimal(0)).toFixed();
    expect(sum(6)).toBe(sum(7));
    // Cancelled revaluations are not exported.
    expect(
      await getDb().fxRevaluation.count({
        where: { organizationId: ctx.organizationId, cancelledAt: null },
      }),
    ).toBe(1);
  });
});
