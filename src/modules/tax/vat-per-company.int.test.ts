import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addChargeLine, createInvoice, getInvoice } from "@/modules/invoices/service";
import { createCompany, listCompanies, updateCompany } from "@/modules/organizations/companies";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { createTenant, expectAppError } from "../../../test/support/factories";
import {
  addTaxRate,
  applyCountryPreset,
  getTaxSetup,
  loadTaxContextInTx,
  updateTaxSettings,
} from "./service";

/** VAT per company (ADR-084): a Saudi and an Egyptian company in one group. */

let ctx: TenantContext;
let saCompany: string;
let egCompany: string;
let egBranch: string;
let std: string;

const rateFor = (at: Parameters<typeof loadTaxContextInTx>[2]) =>
  withTenantTx(ctx.organizationId, async (tx) => {
    const tax = await loadTaxContextInTx(tx, ctx, at);
    const r = tax.resolve(null, "2026-11-01");
    return {
      registered: tax.registered,
      country: tax.country,
      rate: r && r.ok ? r.rate.toFixed() : null,
    };
  });

beforeAll(async () => {
  ({ ctx } = await createTenant("vat-co"));
  await applyCountryPreset(ctx, "SA");
  std = (await getTaxSetup(ctx)).codes.find((c) => c.code === "STD")!.id;
  await updateTaxSettings(ctx, {
    country: "SA",
    vatRegistered: "on",
    vatNumber: "300000000000003",
    pricesIncludeTax: "on",
    defaultSalesTaxCodeId: std,
    defaultPurchaseTaxCodeId: std,
  });
  saCompany = (await listCompanies(ctx)).find((c) => c.isDefault)!.id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("VAT per company (ADR-084)", () => {
  it("the default company follows the VAT settings page", async () => {
    const sa = (await listCompanies(ctx)).find((c) => c.id === saCompany)!;
    expect(sa).toMatchObject({ country: "SA", vatRegistered: true, vatNumber: "300000000000003" });
    // Its VAT fields are not edited on the companies page.
    await updateCompany(ctx, saCompany, {
      code: sa.code,
      name: sa.name,
      legalName: sa.legalName,
      country: "EG",
      vatNumber: "",
    });
    expect((await listCompanies(ctx)).find((c) => c.id === saCompany)).toMatchObject({
      country: "SA",
      vatRegistered: true,
      vatNumber: "300000000000003",
    });
  });

  it("a second country's preset adds its rates without changing the group's VAT country", async () => {
    await applyCountryPreset(ctx, "EG");
    const setup = await getTaxSetup(ctx);
    expect(setup.settings?.country).toBe("SA");
    const stdRates = setup.codes.find((c) => c.code === "STD")!.rates;
    expect(stdRates.filter((r) => r.country === "EG").map((r) => r.rate.toFixed())).toEqual([
      "0.14",
    ]);
    expect(stdRates.some((r) => r.country === "SA" && r.rate.toFixed() === "0.15")).toBe(true);
  });

  it("registering a company needs its country's rates and a valid number", async () => {
    const base = { code: "EGY", name: "Egypt", legalName: "Egypt Foods SAE", vatRegistered: "on" };
    await expectAppError(
      createCompany(ctx, { ...base, country: "AE", vatNumber: "100000000000003" }),
      "BUSINESS_RULE_VIOLATION",
    ); // no UAE rates yet
    await expectAppError(
      createCompany(ctx, { ...base, country: "EG", vatNumber: "12345" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(createCompany(ctx, { ...base, country: "EG" }), "BUSINESS_RULE_VIOLATION");
    egCompany = (await createCompany(ctx, { ...base, country: "EG", vatNumber: "100-200-300" })).id;
    expect((await listCompanies(ctx)).find((c) => c.id === egCompany)?.vatNumber).toBe("100200300");
    egBranch = (
      await createBranch(ctx, {
        code: "CAI",
        name: "Cairo",
        type: "RESTAURANT",
        companyId: egCompany,
      })
    ).id;
  });

  it("each company sells and buys at its own country's rate", async () => {
    expect(await rateFor({})).toEqual({ registered: true, country: "SA", rate: "0.15" });
    expect(await rateFor({ companyId: saCompany })).toMatchObject({ rate: "0.15" });
    expect(await rateFor({ companyId: egCompany })).toEqual({
      registered: true,
      country: "EG",
      rate: "0.14",
    });
    expect(await rateFor({ branchId: egBranch })).toMatchObject({ country: "EG", rate: "0.14" });

    const supplierId = (await createSupplier(ctx, { code: "NILE", name: "Nile Supplies" })).id;
    const invoice = await createInvoice(ctx, {
      supplierId,
      supplierInvoiceNo: "EG-1",
      invoiceDate: "2026-11-01",
      printedGross: "114",
      companyId: egCompany,
    });
    await addChargeLine(ctx, invoice.id, { description: "Delivery", netAmount: "100" });
    const view = await getInvoice(ctx, invoice.id);
    expect(view.lines[0].taxRate?.toFixed()).toBe("0.14");
    expect(view.lines[0].taxAmount.toFixed()).toBe("14");
  });

  it("an unregistered company charges no VAT, and a new rate is for one country", async () => {
    const free = (
      await createCompany(ctx, { code: "FREE", name: "Free", legalName: "Free Co", country: "EG" })
    ).id;
    expect(await rateFor({ companyId: free })).toEqual({
      registered: false,
      country: "EG",
      rate: null,
    });

    // A Saudi rate change does not reach the Egyptian company.
    await addTaxRate(ctx, std, { ratePercent: "16", effectiveFrom: "2026-10-01", country: "SA" });
    expect(await rateFor({ companyId: saCompany })).toMatchObject({ rate: "0.16" });
    expect(await rateFor({ companyId: egCompany })).toMatchObject({ rate: "0.14" });
  });
});
