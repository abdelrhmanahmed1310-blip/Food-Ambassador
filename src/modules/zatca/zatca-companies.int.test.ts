import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createCompany, listCompanies } from "@/modules/organizations/companies";
import { createRegister, getOrder, openShift, submitOrder } from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { applyCountryPreset, getTaxSetup, updateTaxSettings } from "@/modules/tax/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { createTenant, expectAppError } from "../../../test/support/factories";
import { getZatcaSetup, prepareDevice, prepareOfficeUnit, updateZatcaSettings } from "./service";
import { decodeTlv } from "./tlv";

/** ZATCA per company (ADR-085): two Saudi companies of one group sell under their own VAT numbers. */

let ctx: TenantContext;
let mainCo: string;
let jedCo: string;
let egCo: string;
let ruhTill: string;
let jedTill: string;
let burger: string;

const address = (legalName: string) => ({
  legalName,
  street: "King Fahd Road",
  building: "1234",
  district: "Olaya",
  city: "Riyadh",
  postalCode: "12211",
  businessCategory: "Restaurants",
  environment: "DEVELOPER_PORTAL",
});

async function till(code: string, companyId?: string) {
  const branchId = (
    await createBranch(ctx, {
      code,
      name: code,
      type: "RESTAURANT",
      timeZone: "Asia/Riyadh",
      ...(companyId ? { companyId } : {}),
    })
  ).id;
  const warehouseId = (
    await createWarehouse(ctx, {
      branchId,
      code: `${code}-K`,
      name: "Kitchen",
      type: "KITCHEN_STORE",
    })
  ).id;
  return { branchId, warehouseId };
}

const sale = (registerId: string) =>
  submitOrder(ctx, {
    orderId: randomUUID(),
    registerId,
    channel: "DINE_IN",
    lines: [{ itemId: burger, quantity: "1", optionIds: [] }],
    payments: [{ method: "CASH", amount: "115" }],
  });

beforeAll(async () => {
  ({ ctx } = await createTenant("zatca-co", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  await applyCountryPreset(ctx, "SA");
  await applyCountryPreset(ctx, "EG");
  const std = (await getTaxSetup(ctx)).codes.find((c) => c.code === "STD")!.id;
  await updateTaxSettings(ctx, {
    country: "SA",
    vatRegistered: "on",
    pricesIncludeTax: "on",
    vatNumber: "310122393500003",
    defaultSalesTaxCodeId: std,
    defaultPurchaseTaxCodeId: std,
  });
  mainCo = (await listCompanies(ctx)).find((c) => c.isDefault)!.id;
  jedCo = (
    await createCompany(ctx, {
      code: "JED",
      name: "Jeddah Foods",
      legalName: "Jeddah Foods LLC",
      crNumber: "4030000000",
      country: "SA",
      vatNumber: "300000000000003",
      vatRegistered: "on",
    })
  ).id;
  egCo = (
    await createCompany(ctx, {
      code: "EGY",
      name: "Egypt",
      legalName: "Egypt Foods SAE",
      country: "EG",
      vatNumber: "100200300",
      vatRegistered: "on",
    })
  ).id;

  const ruh = await till("RUH");
  const jed = await till("JED", jedCo);
  const patty = (
    await createProduct(ctx, {
      sku: "PATTY",
      nameEn: "Patty",
      type: "FINISHED_GOOD",
      baseUomId: units.each,
    })
  ).id;
  for (const w of [ruh.warehouseId, jed.warehouseId])
    await postOpeningBalance(ctx, {
      warehouseId: w,
      productId: patty,
      quantity: "50",
      uomId: units.each,
      unitCost: "10",
    });
  const cat = (await createMenuCategory(ctx, { name: "Mains" })).id;
  burger = (
    await createMenuItem(ctx, {
      code: "BURGER",
      name: "Burger",
      categoryId: cat,
      kind: "ITEM",
      productId: patty,
    })
  ).id;
  await addMenuItemPrice(ctx, burger, {
    channel: "DINE_IN",
    price: "115",
    effectiveFrom: businessDate(ctx.timeZone),
  });
  ruhTill = (
    await createRegister(ctx, {
      branchId: ruh.branchId,
      warehouseId: ruh.warehouseId,
      code: "RUH1",
      name: "Till",
    })
  ).id;
  jedTill = (
    await createRegister(ctx, {
      branchId: jed.branchId,
      warehouseId: jed.warehouseId,
      code: "JED1",
      name: "Till",
    })
  ).id;
  await openShift(ctx, ruhTill, { openingFloat: "0" });
  await openShift(ctx, jedTill, { openingFloat: "0" });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("ZATCA per company (ADR-085)", () => {
  it("each company has its own seller details and sees only its own registers", async () => {
    await updateZatcaSettings(ctx, address("Main Holding Co"));
    await updateZatcaSettings(ctx, { ...address("Jeddah Foods LLC"), companyId: jedCo });
    const main = await getZatcaSetup(ctx);
    const jed = await getZatcaSetup(ctx, jedCo);
    expect(main.company.id).toBe(mainCo);
    expect(main.settings?.legalName).toBe("Main Holding Co");
    expect(main.registers.map((r) => r.code)).toEqual(["RUH1"]);
    expect(jed.settings?.legalName).toBe("Jeddah Foods LLC");
    expect(jed.vatNumber).toBe("300000000000003");
    expect(jed.registers.map((r) => r.code)).toEqual(["JED1"]);
    expect(main.companies.map((c) => c.id)).toEqual(expect.arrayContaining([mainCo, jedCo]));
    // Another organization's company is not reachable.
    const other = (await createTenant("zatca-co-other", { baseCurrency: "SAR" })).ctx;
    await expectAppError(getZatcaSetup(other, jedCo), "NOT_FOUND");
    await expectAppError(
      updateZatcaSettings(other, { ...address("x"), companyId: jedCo }),
      "NOT_FOUND",
    );
  });

  it("receipts carry the selling company's VAT number and name", async () => {
    const jedQr = decodeTlv((await getOrder(ctx, (await sale(jedTill)).id)).eInvoice!.qr);
    expect(jedQr.get(1)?.toString()).toBe("Jeddah Foods LLC");
    expect(jedQr.get(2)?.toString()).toBe("300000000000003");
    const ruhOrder = await getOrder(ctx, (await sale(ruhTill)).id);
    expect(decodeTlv(ruhOrder.eInvoice!.qr).get(2)?.toString()).toBe("310122393500003");
    expect(ruhOrder.vatNumber).toBe("310122393500003");
  });

  it("units sign for their company: the register's branch's, and one office unit per company", async () => {
    const pos = await getDb().zatcaDevice.findUniqueOrThrow({
      where: { id: (await prepareDevice(ctx, jedTill)).id },
    });
    expect(pos.companyId).toBe(jedCo);
    const der = (csr: string) =>
      Buffer.from(
        Buffer.from(csr, "base64")
          .toString()
          .replace(/-----[^-]+-----|\n/g, ""),
        "base64",
      ).toString("latin1");
    expect(der(pos.csr)).toContain("300000000000003");

    const mainOffice = await getDb().zatcaDevice.findUniqueOrThrow({
      where: { id: (await prepareOfficeUnit(ctx)).id },
    });
    const jedOffice = await getDb().zatcaDevice.findUniqueOrThrow({
      where: { id: (await prepareOfficeUnit(ctx, jedCo)).id },
    });
    expect([mainOffice.companyId, mainOffice.commonName]).toEqual([mainCo, "EGS-OFFICE"]);
    expect([jedOffice.companyId, jedOffice.commonName]).toEqual([jedCo, "EGS-OFFICE-JED"]);
    expect(der(jedOffice.csr)).toContain("300000000000003");
    expect(der(mainOffice.csr)).toContain("310122393500003");
    expect((await getZatcaSetup(ctx, jedCo)).office?.id).toBe(jedOffice.id);
    // Preparing again remakes the same company's unit, never a second one.
    expect((await prepareOfficeUnit(ctx, jedCo)).id).toBe(jedOffice.id);

    // A company not registered in Saudi Arabia cannot have a ZATCA unit.
    await updateZatcaSettings(ctx, { ...address("Egypt Foods SAE"), companyId: egCo });
    await expectAppError(prepareOfficeUnit(ctx, egCo), "BUSINESS_RULE_VIOLATION");

    // The database keeps a unit with its company.
    await expect(
      getDb().zatcaDevice.update({ where: { id: jedOffice.id }, data: { companyId: mainCo } }),
    ).rejects.toThrow();
  });
});
