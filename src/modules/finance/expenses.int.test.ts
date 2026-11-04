import { beforeAll, describe, expect, it } from "vitest";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  createCostCentre,
  createExpenseCategory,
  exportExpensesCsv,
  getExpense,
  listExpenses,
  recordExpense,
  reverseExpense,
  setSetupArchived,
} from "./expenses";

/** Cost centres, expense categories and operating expenses (ADR-109). */

let ctx: TenantContext;
let today: string;
let cairo: string;
let giza: string;
let rent: string;
let power: string;

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

beforeAll(async () => {
  ({ ctx } = await createTenant("expenses", { baseCurrency: "EGP" }));
  today = businessDate(ctx.timeZone);
  cairo = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  giza = (await createBranch(ctx, { code: "GIZ", name: "Giza", type: "RESTAURANT" })).id;
  rent = (await createExpenseCategory(ctx, { code: "rent", name: "Rent", group: "OCCUPANCY" })).id;
  power = (
    await createExpenseCategory(ctx, { code: "POWER", name: "Electricity", group: "UTILITIES" })
  ).id;
});

describe("operating expenses (ADR-109)", () => {
  it("records expenses at a branch in its company currency, with VAT and a supplier", async () => {
    await expectAppError(
      createExpenseCategory(ctx, { code: "RENT", name: "x", group: "OCCUPANCY" }),
      "CONFLICT",
    );
    const kitchen = (
      await createCostCentre(ctx, { code: "CAI-K", name: "Cairo kitchen", branchId: cairo })
    ).id;
    const supplierId = (await createSupplier(ctx, { code: "EEHC", name: "Electricity Co" })).id;
    const bill = await recordExpense(ctx, {
      branchId: cairo,
      categoryId: power,
      costCentreId: kitchen,
      supplierId,
      expenseDate: today,
      description: "Electricity October",
      reference: "INV-5531",
      netAmount: "1200",
      taxAmount: "168",
    });
    expect(bill.number).toMatch(/^EXP-/);
    const e = await getExpense(ctx, bill.id);
    expect([e.grossAmount.toString(), e.currency, e.status, e.canReverse]).toEqual([
      "1368",
      "EGP",
      "POSTED",
      true,
    ]);
    await recordExpense(ctx, {
      branchId: cairo,
      categoryId: rent,
      expenseDate: today,
      description: "Rent November",
      netAmount: "15000",
    });
    // A Cairo cost centre cannot carry a Giza expense; no future dates.
    await expectRule(
      recordExpense(ctx, {
        branchId: giza,
        categoryId: rent,
        costCentreId: kitchen,
        expenseDate: today,
        description: "x",
        netAmount: "1",
      }),
      "COST_CENTRE_OTHER_BRANCH",
    );
    await expectRule(
      recordExpense(ctx, {
        branchId: giza,
        categoryId: rent,
        expenseDate: addDays(today, 1),
        description: "x",
        netAmount: "1",
      }),
      "DATE_IN_FUTURE",
    );
    await expectAppError(
      recordExpense(ctx, {
        branchId: giza,
        categoryId: rent,
        expenseDate: today,
        description: "x",
        netAmount: "0",
      }),
      "VALIDATION_FAILED",
    );
    const list = await listExpenses(ctx, { from: today, to: today });
    expect(list.totals).toEqual([expect.objectContaining({ currency: "EGP" })]);
    expect(list.totals[0].net.toFixed(2)).toBe("16200.00");
    expect(list.totals[0].groups.map((g) => [g.group, g.net.toFixed(2)])).toEqual([
      ["OCCUPANCY", "15000.00"],
      ["UTILITIES", "1200.00"],
    ]);
  });

  it("is never edited: a mistake is reversed with a reason and leaves the totals", async () => {
    const wrong = await recordExpense(ctx, {
      branchId: giza,
      categoryId: power,
      expenseDate: today,
      description: "Entered twice",
      netAmount: "500",
    });
    await expect(
      getDb().expense.update({ where: { id: wrong.id }, data: { netAmount: "5" } }),
    ).rejects.toThrow();
    await expectAppError(reverseExpense(ctx, wrong.id, { reason: "" }), "VALIDATION_FAILED");
    await reverseExpense(ctx, wrong.id, { reason: "Duplicate of the Cairo bill" });
    await expectRule(reverseExpense(ctx, wrong.id, { reason: "again" }), "EXPENSE_REVERSED");
    const giz = await listExpenses(ctx, { branchId: giza });
    expect([giz.rows[0].status, giz.totals[0].net.toFixed(2)]).toEqual(["REVERSED", "0.00"]);
    const csv = await exportExpensesCsv(ctx, { from: today, to: today });
    expect(csv).toContain(
      ",CAI,POWER,UTILITIES,CAI-K,EEHC,Electricity October,INV-5531,1200.00,168.00,1368.00,EGP,POSTED",
    );
  });

  it("archived categories take no new expenses", async () => {
    const old = (await createExpenseCategory(ctx, { code: "OLD", name: "Old", group: "OTHER" })).id;
    await setSetupArchived(ctx, "CATEGORY", old, true);
    await expectAppError(
      recordExpense(ctx, {
        branchId: cairo,
        categoryId: old,
        expenseDate: today,
        description: "x",
        netAmount: "1",
      }),
      "NOT_FOUND",
    );
  });

  it("branch managers record at their branch only; others are refused or see nothing", async () => {
    const manager = await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: giza });
    await recordExpense(manager.ctx, {
      branchId: giza,
      categoryId: power,
      expenseDate: today,
      description: "Giza water",
      netAmount: "90",
    });
    await expectAppError(
      recordExpense(manager.ctx, {
        branchId: cairo,
        categoryId: power,
        expenseDate: today,
        description: "x",
        netAmount: "1",
      }),
      "NOT_FOUND",
    );
    expect((await listExpenses(manager.ctx)).rows.every((r) => r.branch.code === "GIZ")).toBe(true);
    await expectAppError(
      createExpenseCategory(manager.ctx, { code: "X", name: "x", group: "OTHER" }),
      "FORBIDDEN",
    );
    const analyst = await addMember(ctx, "analyst");
    expect((await listExpenses(analyst.ctx)).rows.length).toBeGreaterThan(0);
    await expectAppError(
      recordExpense(analyst.ctx, {
        branchId: cairo,
        categoryId: power,
        expenseDate: today,
        description: "x",
        netAmount: "1",
      }),
      "FORBIDDEN",
    );
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(listExpenses(cashier.ctx), "FORBIDDEN");
    const { ctx: other } = await createTenant("expenses-other");
    await expectAppError(
      recordExpense(other, {
        branchId: cairo,
        categoryId: power,
        expenseDate: today,
        description: "x",
        netAmount: "1",
      }),
      "NOT_FOUND",
    );
  });
});
