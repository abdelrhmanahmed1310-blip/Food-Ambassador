import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBranch, getBranch, updateBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  createBrand,
  createCompany,
  listCompanies,
  setBrandArchived,
  setCompanyArchived,
  setDefaultCompany,
  updateCompany,
} from "./companies";

/** Companies (legal entities) and brands (ADR-082). */

let ctx: TenantContext;
let other: TenantContext;
let manager: TenantContext;

beforeAll(async () => {
  ({ ctx } = await createTenant("ent", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  ({ ctx: other } = await createTenant("ent-other", {
    baseCurrency: "EGP",
    timeZone: "Africa/Cairo",
  }));
  ({ ctx: manager } = await addMember(ctx, "operations_manager"));
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("companies and brands (ADR-082)", () => {
  let ksa: string;
  let brand: string;

  it("every organization starts with a default company in its base currency", async () => {
    const [main] = await listCompanies(ctx);
    expect(main).toMatchObject({ code: "MAIN", isDefault: true, currency: "SAR" });
    const b = await createBranch(ctx, { code: "RUH", name: "Olaya", type: "RESTAURANT" });
    expect((await getDb().branch.findUniqueOrThrow({ where: { id: b.id } })).companyId).toBe(
      main.id,
    );
  });

  it("adds a legal entity and a brand; branches take them", async () => {
    ksa = (
      await createCompany(ctx, {
        code: "ksa-llc",
        name: "Burgers KSA",
        legalName: "Burgers Trading Company LLC",
        country: "sa",
        vatNumber: "399999999900003",
        crNumber: "1010010101",
      })
    ).id;
    await expectAppError(
      createCompany(ctx, { code: "KSA-LLC", name: "x", legalName: "x" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      createCompany(ctx, { code: "X", name: "x", legalName: "x", country: "SAU" }),
      "VALIDATION_FAILED",
    );
    brand = (await createBrand(ctx, { code: "brg", name: "Olaya Burgers", nameAr: "برجر العليا" }))
      .id;
    const b = await createBranch(ctx, {
      code: "JED",
      name: "Jeddah",
      type: "RESTAURANT",
      companyId: ksa,
      brandId: brand,
    });
    const view = await getBranch(ctx, b.id);
    expect(view.company.code).toBe("KSA-LLC");
    expect(view.brand?.name).toBe("Olaya Burgers");
    expect((await listCompanies(ctx)).find((c) => c.id === ksa)?._count.branches).toBe(1);
  });

  it("a branch stays with its company; another tenant's company or brand is refused", async () => {
    const jed = (
      await getDb().branch.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, code: "JED" },
      })
    ).id;
    const main = (await listCompanies(ctx)).find((c) => c.isDefault)!.id;
    await expectAppError(
      updateBranch(ctx, jed, { code: "JED", name: "Jeddah", type: "RESTAURANT", companyId: main }),
      "BUSINESS_RULE_VIOLATION",
    );
    // Same company, brand removed: fine.
    await updateBranch(ctx, jed, {
      code: "JED",
      name: "Jeddah",
      type: "RESTAURANT",
      companyId: ksa,
      brandId: "",
    });
    expect((await getBranch(ctx, jed)).brand).toBeNull();
    const foreign = (await listCompanies(other))[0].id;
    await expectAppError(
      createBranch(ctx, { code: "X1", name: "x", type: "OTHER", companyId: foreign }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("default and archive rules", async () => {
    const main = (await listCompanies(ctx)).find((c) => c.isDefault)!.id;
    await expectAppError(setCompanyArchived(ctx, main, true), "BUSINESS_RULE_VIOLATION"); // the default
    await expectAppError(setCompanyArchived(ctx, ksa, true), "BUSINESS_RULE_VIOLATION"); // has a branch
    await setDefaultCompany(ctx, ksa);
    const now = await listCompanies(ctx);
    expect(now.filter((c) => c.isDefault).map((c) => c.id)).toEqual([ksa]);
    await updateCompany(ctx, main, {
      code: "MAIN",
      name: "Holding",
      legalName: "Holding Co",
      country: "AE",
    });
    // An empty company can be archived; new branches then cannot use it.
    const spare = (
      await createCompany(ctx, { code: "SPARE", name: "Spare", legalName: "Spare Co" })
    ).id;
    await setCompanyArchived(ctx, spare, true);
    await expectAppError(
      createBranch(ctx, { code: "X2", name: "x", type: "OTHER", companyId: spare }),
      "BUSINESS_RULE_VIOLATION",
    );
    // Archiving a brand clears it from branches.
    const ruh = (
      await getDb().branch.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, code: "RUH" },
      })
    ).id;
    await updateBranch(ctx, ruh, {
      code: "RUH",
      name: "Olaya",
      type: "RESTAURANT",
      brandId: brand,
    });
    await setBrandArchived(ctx, brand, true);
    expect((await getBranch(ctx, ruh)).brand).toBeNull();
  });

  it("only settings managers change companies; organizations never mix", async () => {
    await expectAppError(
      createCompany(manager, { code: "Y", name: "y", legalName: "y" }),
      "FORBIDDEN",
    );
    await expectAppError(setDefaultCompany(other, ksa), "NOT_FOUND");
    await expectAppError(
      updateCompany(other, ksa, { code: "Z", name: "z", legalName: "z" }),
      "NOT_FOUND",
    );
    expect((await listCompanies(other)).map((c) => c.currency)).toEqual(["EGP"]);
  });
});
