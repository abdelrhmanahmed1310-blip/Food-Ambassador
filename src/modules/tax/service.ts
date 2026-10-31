import "server-only";
import { z } from "zod";
import { Decimal, decimalString, toDecimal } from "@/lib/decimal";
import { isCalendarDate } from "@/lib/dates";
import {
  accessibleScope,
  assertPermission,
  hasPermission,
  holdsAnyGrant,
} from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import {
  codeSchema,
  optionalText,
  optionalUuidSchema,
  requiredText,
} from "@/modules/shared/schemas";
import type { TenantContext } from "@/modules/tenancy/context";
import { isUniqueViolation } from "@/server/db/errors";
import { withTenantTx, type Tx } from "@/server/db/transactions";
import {
  businessRuleViolation,
  conflict,
  forbidden,
  notFound,
  validationFailed,
} from "@/server/errors";
import { PRESETS, TAX_COUNTRIES, type TaxCountry } from "./presets";
import { rateOn, vatNumberProblem } from "./rules";

/**
 * VAT setup (DECISIONS.md ADR-037): one country per organization, its tax
 * codes with dated rates, VAT number, whether selling prices include VAT,
 * and default sales/purchase codes. Changing it needs `org.settings.manage`.
 */

const dec = (v: { toString(): string }) => new Decimal(v.toString());
const dateField = z
  .string({ error: "required" })
  .trim()
  .refine(isCalendarDate, { error: "invalidDate" });
const percentField = decimalString({ maxScale: 4, min: "0", max: "99.9999" });
const fraction = (percent: string) => toDecimal(percent).dividedBy(100).toFixed();

const settingsSchema = z.object({
  country: z.enum(TAX_COUNTRIES, { error: "invalidOption" }),
  vatRegistered: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  vatNumber: optionalText(30),
  pricesIncludeTax: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
  defaultSalesTaxCodeId: optionalUuidSchema,
  defaultPurchaseTaxCodeId: optionalUuidSchema,
});

const taxCodeSchema = z.object({
  code: codeSchema,
  name: requiredText(80),
  nameAr: optionalText(80),
  category: z.enum(["STANDARD", "ZERO_RATED", "EXEMPT", "OUT_OF_SCOPE"], {
    error: "invalidOption",
  }),
  ratePercent: percentField,
  effectiveFrom: dateField,
});

const rateSchema = z.object({
  ratePercent: percentField,
  effectiveFrom: dateField,
  source: optionalText(200),
});

const PRESET_CODES = [
  { code: "STD", category: "STANDARD", name: "Standard rate", nameAr: "النسبة الأساسية" },
  { code: "ZERO", category: "ZERO_RATED", name: "Zero-rated", nameAr: "خاضع بنسبة صفر" },
  { code: "EXEMPT", category: "EXEMPT", name: "Exempt", nameAr: "معفى" },
  { code: "OOS", category: "OUT_OF_SCOPE", name: "Out of scope", nameAr: "خارج النطاق" },
] as const;

function requireManage(ctx: TenantContext) {
  assertPermission(ctx.grants, "org.settings.manage");
}

async function audit(tx: Tx, ctx: TenantContext, action: string, changes: Record<string, unknown>) {
  await recordAudit(tx, actorOf(ctx), {
    action: `tax.${action}`,
    entityType: "organization",
    entityId: ctx.organizationId,
    changes,
  });
}

export async function getTaxSetup(ctx: TenantContext) {
  // VAT settings page, and the dish VAT code picker for recipe editors.
  if (
    !hasPermission(ctx.grants, "org.settings.manage") &&
    !hasPermission(ctx.grants, "recipes.manage")
  )
    throw forbidden();
  return withTenantTx(ctx.organizationId, async (tx) => {
    const [settings, codes] = [
      await tx.taxSettings.findUnique({ where: { organizationId: ctx.organizationId } }),
      await tx.taxCode.findMany({
        where: { organizationId: ctx.organizationId },
        include: { rates: { orderBy: { effectiveFrom: "desc" } } },
        orderBy: { code: "asc" },
      }),
    ];
    return { settings, codes };
  });
}

/** Create the country's standard codes and rates (idempotent; existing codes get missing rates only). */
export async function applyCountryPreset(ctx: TenantContext, country: string) {
  requireManage(ctx);
  if (!(TAX_COUNTRIES as readonly string[]).includes(country))
    throw businessRuleViolation("UNKNOWN_TAX_COUNTRY", "Unsupported country", { field: "country" });
  const preset = PRESETS[country as TaxCountry];
  return withTenantTx(ctx.organizationId, async (tx) => {
    const existing = await tx.taxSettings.findUnique({
      where: { organizationId: ctx.organizationId },
    });
    let standardId: string | null = null;
    if (preset.vatInForce) {
      const first = preset.standard[0].effectiveFrom;
      for (const def of PRESET_CODES) {
        const code =
          (await tx.taxCode.findFirst({
            where: { organizationId: ctx.organizationId, code: def.code },
          })) ??
          (await tx.taxCode.create({
            data: {
              organizationId: ctx.organizationId,
              code: def.code,
              name: def.name,
              nameAr: def.nameAr,
              category: def.category,
            },
          }));
        const rates =
          def.category === "STANDARD" ? preset.standard : [{ rate: "0", effectiveFrom: first }];
        for (const r of rates)
          await tx.taxRate.upsert({
            where: {
              organizationId_taxCodeId_effectiveFrom: {
                organizationId: ctx.organizationId,
                taxCodeId: code.id,
                effectiveFrom: new Date(`${r.effectiveFrom}T00:00:00Z`),
              },
            },
            create: {
              organizationId: ctx.organizationId,
              taxCodeId: code.id,
              rate: r.rate,
              effectiveFrom: new Date(`${r.effectiveFrom}T00:00:00Z`),
              source: preset.source,
              createdByUserId: ctx.userId,
            },
            update: {},
          });
        if (def.category === "STANDARD") standardId = code.id;
      }
    }
    await tx.taxSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: {
        organizationId: ctx.organizationId,
        country: preset.country,
        pricesIncludeTax: preset.pricesIncludeTaxDefault,
        defaultSalesTaxCodeId: standardId,
        defaultPurchaseTaxCodeId: standardId,
        presetAppliedAt: new Date(),
      },
      update: {
        country: preset.country,
        defaultSalesTaxCodeId: existing?.defaultSalesTaxCodeId ?? standardId,
        defaultPurchaseTaxCodeId: existing?.defaultPurchaseTaxCodeId ?? standardId,
        presetAppliedAt: new Date(),
        ...(preset.vatInForce ? {} : { vatRegistered: false }),
      },
    });
    await audit(tx, ctx, "preset_applied", { country: preset.country, source: preset.source });
    return { vatInForce: preset.vatInForce };
  });
}

export async function updateTaxSettings(ctx: TenantContext, rawInput: unknown) {
  requireManage(ctx);
  const parsed = settingsSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const input = parsed.data;
  if (input.vatRegistered) {
    if (!PRESETS[input.country].vatInForce)
      throw businessRuleViolation("NO_VAT_IN_COUNTRY", "There is no VAT in force in this country", {
        field: "vatRegistered",
      });
    if (!input.vatNumber)
      throw businessRuleViolation("VAT_NUMBER_REQUIRED", "Enter the VAT registration number", {
        field: "vatNumber",
      });
    if (vatNumberProblem(input.country, input.vatNumber))
      throw businessRuleViolation(
        "INVALID_VAT_NUMBER",
        "The VAT number does not have the expected format",
        { field: "vatNumber" },
      );
    if (!input.defaultSalesTaxCodeId)
      throw businessRuleViolation(
        "DEFAULT_TAX_CODE_REQUIRED",
        "Choose the default sales tax code",
        { field: "defaultSalesTaxCodeId" },
      );
  }
  await withTenantTx(ctx.organizationId, async (tx) => {
    for (const id of [input.defaultSalesTaxCodeId, input.defaultPurchaseTaxCodeId].filter(
      Boolean,
    )) {
      const code = await tx.taxCode.findFirst({
        where: { organizationId: ctx.organizationId, id: id as string, archivedAt: null },
      });
      if (!code) throw notFound("Tax code");
    }
    const data = {
      country: input.country,
      vatRegistered: input.vatRegistered,
      vatNumber: input.vatNumber ? input.vatNumber.replace(/[\s-]/g, "") : null,
      pricesIncludeTax: input.pricesIncludeTax,
      defaultSalesTaxCodeId: input.defaultSalesTaxCodeId ?? null,
      defaultPurchaseTaxCodeId: input.defaultPurchaseTaxCodeId ?? null,
    };
    await tx.taxSettings.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ...data },
      update: data,
    });
    await audit(tx, ctx, "settings_updated", data);
  });
}

export async function createTaxCode(ctx: TenantContext, rawInput: unknown) {
  requireManage(ctx);
  const parsed = taxCodeSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  const { ratePercent, effectiveFrom, ...code } = parsed.data;
  try {
    return await withTenantTx(ctx.organizationId, async (tx) => {
      const created = await tx.taxCode.create({
        data: { organizationId: ctx.organizationId, ...code },
        select: { id: true },
      });
      await tx.taxRate.create({
        data: {
          organizationId: ctx.organizationId,
          taxCodeId: created.id,
          rate: fraction(ratePercent),
          effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`),
          createdByUserId: ctx.userId,
        },
      });
      await audit(tx, ctx, "code_created", { ...code, ratePercent, effectiveFrom });
      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error, "tax_codes_organization_id_code_key"))
      throw conflict("A tax code with this code exists", { reason: "duplicate", field: "code" });
    throw error;
  }
}

/** A new rate from a date, e.g. when the law changes. Past sales keep the rate they used. */
export async function addTaxRate(ctx: TenantContext, taxCodeId: string, rawInput: unknown) {
  requireManage(ctx);
  const parsed = rateSchema.safeParse(rawInput);
  if (!parsed.success) throw validationFailed(parsed.error);
  try {
    await withTenantTx(ctx.organizationId, async (tx) => {
      const code = await tx.taxCode.findFirst({
        where: { organizationId: ctx.organizationId, id: taxCodeId },
      });
      if (!code) throw notFound("Tax code");
      if (code.category !== "STANDARD" && !toDecimal(parsed.data.ratePercent).isZero())
        throw businessRuleViolation(
          "NON_STANDARD_RATE_MUST_BE_ZERO",
          "Zero-rated, exempt and out-of-scope codes have a 0 % rate",
          {
            field: "ratePercent",
          },
        );
      await tx.taxRate.create({
        data: {
          organizationId: ctx.organizationId,
          taxCodeId: code.id,
          rate: fraction(parsed.data.ratePercent),
          effectiveFrom: new Date(`${parsed.data.effectiveFrom}T00:00:00Z`),
          source: parsed.data.source,
          createdByUserId: ctx.userId,
        },
      });
      await audit(tx, ctx, "rate_added", { code: code.code, ...parsed.data });
    });
  } catch (error) {
    if (isUniqueViolation(error, "tax_rates_organization_id_tax_code_id_effective_from_key"))
      throw conflict("A rate already starts on this date", {
        reason: "duplicate",
        field: "effectiveFrom",
      });
    throw error;
  }
}

/** Organization tax context for other modules: which code and rate apply to a sale. */
export async function loadTaxContextInTx(tx: Tx, ctx: TenantContext) {
  const settings = await tx.taxSettings.findUnique({
    where: { organizationId: ctx.organizationId },
  });
  const codes = await tx.taxCode.findMany({
    where: { organizationId: ctx.organizationId },
    include: { rates: true },
  });
  const byId = new Map(codes.map((c) => [c.id, c]));
  const byCode = new Map(codes.map((c) => [c.code, c]));
  const active = Boolean(settings?.vatRegistered && settings.defaultSalesTaxCodeId);
  const rateFor = (code: (typeof codes)[number], date: string) => {
    const rate = rateOn(
      code.rates.map((r) => ({
        rate: dec(r.rate),
        effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
      })),
      date,
    );
    if (rate === null)
      return { ok: false as const, problem: "noTaxRate" as const, code: code.code };
    return { ok: true as const, codeId: code.id, code: code.code, category: code.category, rate };
  };
  return {
    active,
    registered: settings?.vatRegistered ?? false,
    pricesIncludeTax: settings?.pricesIncludeTax ?? false,
    byCode,
    /**
     * Code and rate on a supplier invoice dated `date`: VAT the supplier
     * charged, whether or not it can be reclaimed. Null when no purchase VAT
     * code is set up (e.g. a country without VAT).
     */
    resolvePurchase(codeId: string | null | undefined, date: string) {
      const code = byId.get(codeId ?? settings?.defaultPurchaseTaxCodeId ?? "");
      if (!code)
        return codeId ? { ok: false as const, problem: "noTaxCode" as const, code: "" } : null;
      return rateFor(code, date);
    },
    /** Code and rate for a sale on `date`; null when VAT does not apply (not registered). */
    resolve(codeId: string | null | undefined, date: string) {
      if (!active) return null;
      const code = byId.get(codeId ?? (settings?.defaultSalesTaxCodeId as string));
      if (!code) return { ok: false as const, problem: "noTaxCode" as const, code: "" };
      return rateFor(code, date);
    },
  };
}

/** Output VAT from imported sales by tax code over a period (input VAT comes with supplier invoices). */
export async function vatSummary(ctx: TenantContext, period: { from: string; to: string }) {
  if (!holdsAnyGrant(ctx.grants, "sales.view")) throw forbidden();
  const scope = accessibleScope(ctx.grants, "sales.view");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const rows = await tx.salesLine.groupBy({
      by: ["taxCodeId", "taxRate"],
      where: {
        organizationId: ctx.organizationId,
        active: true,
        soldOn: {
          gte: new Date(`${period.from}T00:00:00Z`),
          lte: new Date(`${period.to}T00:00:00Z`),
        },
        ...(scope.all
          ? {}
          : {
              salesImport: {
                warehouse: {
                  OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.warehouseIds } }],
                },
              },
            }),
      },
      _sum: { netAmount: true, taxAmount: true, grossAmount: true },
      _count: { _all: true },
    });
    const codes = await tx.taxCode.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, code: true, name: true, nameAr: true, category: true },
    });
    return rows.map((r) => ({
      code: codes.find((c) => c.id === r.taxCodeId) ?? null,
      rate: r.taxRate,
      lines: r._count._all,
      net: r._sum.netAmount,
      tax: r._sum.taxAmount,
      gross: r._sum.grossAmount,
    }));
  });
}
