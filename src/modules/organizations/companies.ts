import "server-only";
import { z } from "zod";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import { PRESETS, TAX_COUNTRIES, type TaxCountry } from "@/modules/tax/presets";
import { vatNumberProblem } from "@/modules/tax/rules";
import { optionalText, requiredText, uuidSchema } from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import { businessRuleViolation, notFound, validationFailed } from "@/server/errors";

/**
 * The enterprise layer (DECISIONS.md ADR-082): the organization is the group;
 * companies are its legal entities (registrations, country); brands group
 * branches commercially. Every branch belongs to one company and may carry a
 * brand. Each company has its own VAT registration and uses its country's
 * rates (ADR-084); the default company's registration is the one on the VAT
 * settings page. Currency is still the group's base currency.
 */

const code = z
  .string()
  .trim()
  .min(1, { error: "required" })
  .max(20, { error: "tooLong" })
  .regex(/^[A-Za-z0-9._-]+$/, { error: "invalid" })
  .transform((v) => v.toUpperCase());
const country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^([A-Z]{2})?$/, { error: "invalidCountry" })
  .optional()
  .transform((v) => v || null);
const registration = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: "tooLong" })
    .regex(/^[A-Za-z0-9 -]*$/, { error: "invalid" })
    .optional()
    .transform((v) => v || null);

const companySchema = z.object({
  code,
  name: requiredText(120),
  legalName: requiredText(200),
  country,
  vatNumber: registration(20),
  crNumber: registration(20),
  vatRegistered: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
});
type CompanyInput = z.infer<typeof companySchema>;

/**
 * A registered company needs a VAT country with rates set up and a valid
 * number. The default company's VAT fields belong to the VAT settings page
 * and are not changed here.
 */
async function vatFields(tx: Tx, ctx: TenantContext, input: CompanyInput, isDefault: boolean) {
  const { country, vatRegistered, vatNumber: rawNumber, ...rest } = input;
  if (isDefault) return rest;
  const vatNumber = rawNumber ? rawNumber.replace(/[\s-]/g, "") : null;
  if (vatRegistered) {
    if (
      !country ||
      !(TAX_COUNTRIES as readonly string[]).includes(country) ||
      !PRESETS[country as TaxCountry].vatInForce
    )
      throw businessRuleViolation("NO_VAT_IN_COUNTRY", "There is no VAT in force in this country", {
        field: "country",
      });
    if (!vatNumber)
      throw businessRuleViolation("VAT_NUMBER_REQUIRED", "Enter the VAT registration number", {
        field: "vatNumber",
      });
    if (vatNumberProblem(country as TaxCountry, vatNumber))
      throw businessRuleViolation(
        "INVALID_VAT_NUMBER",
        "The VAT number does not have the expected format",
        { field: "vatNumber" },
      );
    const rates = await tx.taxRate.count({
      where: { organizationId: ctx.organizationId, country },
    });
    if (rates === 0)
      throw businessRuleViolation(
        "NO_VAT_RATES_FOR_COUNTRY",
        "Apply this country's VAT preset on the VAT settings page first",
        { field: "vatRegistered" },
      );
  }
  return { ...rest, country, vatNumber, vatRegistered };
}

const brandSchema = z.object({ code, name: requiredText(120), nameAr: optionalText(120) });

function taken(error: unknown, rule: string) {
  if (isUniqueViolation(error))
    return businessRuleViolation(rule, "This code is already used", { field: "code" });
  return error;
}

export async function listCompanies(ctx: TenantContext, includeArchived = false) {
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.company.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: { _count: { select: { branches: { where: { archivedAt: null } } } } },
      orderBy: [{ isDefault: "desc" }, { code: "asc" }],
    }),
  );
}

export async function listBrands(ctx: TenantContext, includeArchived = false) {
  return withTenantTx(ctx.organizationId, (tx) =>
    tx.brand.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: { _count: { select: { branches: { where: { archivedAt: null } } } } },
      orderBy: { code: "asc" },
    }),
  );
}

async function loadCompany(tx: Tx, ctx: TenantContext, id: string) {
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) throw notFound("Company");
  const c = await tx.company.findFirst({
    where: { organizationId: ctx.organizationId, id: parsed.data },
  });
  if (!c) throw notFound("Company");
  return c;
}

export async function createCompany(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = companySchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const data = await vatFields(tx, ctx, parsed.data, false);
      const c = await tx.company.create({
        data: { organizationId: ctx.organizationId, ...data, currency: ctx.baseCurrency },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "company.created",
        entityType: "company",
        entityId: c.id,
        changes: parsed.data,
      });
      return c;
    });
  } catch (error) {
    throw taken(error, "COMPANY_CODE_TAKEN");
  }
}

export async function updateCompany(ctx: TenantContext, id: string, rawInput: unknown) {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = companySchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const c = await loadCompany(tx, ctx, id);
      const data = await vatFields(tx, ctx, parsed.data, c.isDefault);
      await tx.company.update({ where: { id: c.id }, data });
      await recordAudit(tx, actorOf(ctx), {
        action: "company.updated",
        entityType: "company",
        entityId: c.id,
        changes: parsed.data,
      });
    });
  } catch (error) {
    throw taken(error, "COMPANY_CODE_TAKEN");
  }
}

/** The company new branches join when none is chosen. */
export async function setDefaultCompany(ctx: TenantContext, id: string) {
  assertPermission(ctx.grants, "org.settings.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCompany(tx, ctx, id);
    if (c.archivedAt) throw businessRuleViolation("COMPANY_ARCHIVED", "This company is archived");
    await tx.company.updateMany({
      where: { organizationId: ctx.organizationId, isDefault: true },
      data: { isDefault: false },
    });
    await tx.company.update({ where: { id: c.id }, data: { isDefault: true } });
    await recordAudit(tx, actorOf(ctx), {
      action: "company.made_default",
      entityType: "company",
      entityId: c.id,
      changes: {},
    });
  });
}

/** Archive a company with no active branches (never the default); or restore it. */
export async function setCompanyArchived(ctx: TenantContext, id: string, archived: boolean) {
  assertPermission(ctx.grants, "org.settings.manage");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const c = await loadCompany(tx, ctx, id);
    if (archived) {
      if (c.isDefault)
        throw businessRuleViolation("COMPANY_DEFAULT", "Make another company the default first");
      const branches = await tx.branch.count({
        where: { organizationId: ctx.organizationId, companyId: c.id, archivedAt: null },
      });
      if (branches > 0)
        throw businessRuleViolation("COMPANY_IN_USE", "Archive or move its branches first");
    }
    await tx.company.update({
      where: { id: c.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "company.archived" : "company.restored",
      entityType: "company",
      entityId: c.id,
      changes: {},
    });
  });
}

export async function createBrand(ctx: TenantContext, rawInput: unknown) {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = brandSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const b = await tx.brand.create({
        data: {
          organizationId: ctx.organizationId,
          ...parsed.data,
          nameAr: parsed.data.nameAr ?? null,
        },
      });
      await recordAudit(tx, actorOf(ctx), {
        action: "brand.created",
        entityType: "brand",
        entityId: b.id,
        changes: parsed.data,
      });
      return b;
    });
  } catch (error) {
    throw taken(error, "BRAND_CODE_TAKEN");
  }
}

/** Archiving a brand clears it from its branches (a brand is only a label). */
export async function setBrandArchived(ctx: TenantContext, id: string, archived: boolean) {
  assertPermission(ctx.grants, "org.settings.manage");
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) throw notFound("Brand");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const b = await tx.brand.findFirst({
      where: { organizationId: ctx.organizationId, id: parsed.data },
    });
    if (!b) throw notFound("Brand");
    if (archived)
      await tx.branch.updateMany({
        where: { organizationId: ctx.organizationId, brandId: b.id },
        data: { brandId: null },
      });
    await tx.brand.update({
      where: { id: b.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: archived ? "brand.archived" : "brand.restored",
      entityType: "brand",
      entityId: b.id,
      changes: {},
    });
  });
}
