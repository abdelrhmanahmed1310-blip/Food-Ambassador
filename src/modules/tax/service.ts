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
import type { Prisma } from "@/generated/prisma/client";
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
  // The country whose companies use the rate; the group's VAT country when not given (ADR-084).
  country: z
    .enum(TAX_COUNTRIES, { error: "invalidOption" })
    .optional()
    .or(z.literal("").transform(() => undefined)),
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
              organizationId_taxCodeId_country_effectiveFrom: {
                organizationId: ctx.organizationId,
                taxCodeId: code.id,
                country: preset.country,
                effectiveFrom: new Date(`${r.effectiveFrom}T00:00:00Z`),
              },
            },
            create: {
              organizationId: ctx.organizationId,
              taxCodeId: code.id,
              country: preset.country,
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
    // A second country's preset adds its rates for that country's companies (ADR-084);
    // the group's own VAT country stays as it is.
    if (existing?.country && existing.country !== preset.country) {
      await audit(tx, ctx, "preset_applied", { country: preset.country, source: preset.source });
      return { vatInForce: preset.vatInForce };
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
    // The default company follows the group's VAT registration (ADR-084).
    await tx.company.updateMany({
      where: { organizationId: ctx.organizationId, isDefault: true },
      data: {
        country: data.country,
        vatRegistered: data.vatRegistered,
        vatNumber: data.vatNumber,
      },
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
      const settings = await tx.taxSettings.findUnique({
        where: { organizationId: ctx.organizationId },
        select: { country: true },
      });
      await tx.taxRate.create({
        data: {
          organizationId: ctx.organizationId,
          taxCodeId: created.id,
          country: settings?.country ?? null,
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
      const country =
        parsed.data.country ??
        (
          await tx.taxSettings.findUnique({
            where: { organizationId: ctx.organizationId },
            select: { country: true },
          })
        )?.country ??
        null;
      await tx.taxRate.create({
        data: {
          organizationId: ctx.organizationId,
          taxCodeId: code.id,
          country,
          rate: fraction(parsed.data.ratePercent),
          effectiveFrom: new Date(`${parsed.data.effectiveFrom}T00:00:00Z`),
          source: parsed.data.source,
          createdByUserId: ctx.userId,
        },
      });
      await audit(tx, ctx, "rate_added", { code: code.code, ...parsed.data });
    });
  } catch (error) {
    if (isUniqueViolation(error, "tax_rates_organization_id_tax_code_id_country_effective_fro_key"))
      throw conflict("A rate already starts on this date", {
        reason: "duplicate",
        field: "effectiveFrom",
      });
    throw error;
  }
}

/**
 * VAT for a document of one company (ADR-084): its country's rates and its
 * registration. The company comes from `at` (company, branch or warehouse);
 * without it, the default company. Codes are shared by the group.
 */
export async function loadTaxContextInTx(
  tx: Tx,
  ctx: TenantContext,
  at: { companyId?: string | null; branchId?: string | null; warehouseId?: string | null } = {},
) {
  const settings = await tx.taxSettings.findUnique({
    where: { organizationId: ctx.organizationId },
  });
  const companyId =
    at.companyId ??
    (at.branchId
      ? (
          await tx.branch.findFirst({
            where: { organizationId: ctx.organizationId, id: at.branchId },
            select: { companyId: true },
          })
        )?.companyId
      : at.warehouseId
        ? (
            await tx.warehouse.findFirst({
              where: { organizationId: ctx.organizationId, id: at.warehouseId },
              select: { branch: { select: { companyId: true } } },
            })
          )?.branch.companyId
        : undefined);
  const company = await tx.company.findFirst({
    where: {
      organizationId: ctx.organizationId,
      ...(companyId ? { id: companyId } : { isDefault: true }),
    },
    select: { country: true, vatRegistered: true },
  });
  const country = company?.country ?? settings?.country ?? null;
  const registered = company ? company.vatRegistered : (settings?.vatRegistered ?? false);
  const codes = await tx.taxCode.findMany({
    where: { organizationId: ctx.organizationId },
    include: { rates: true },
  });
  // A rate counts for this company when it is its country's, or untagged (set before any VAT country).
  const ratesOf = (code: (typeof codes)[number]) =>
    code.rates.filter((r) => r.country === null || r.country === country);
  const byId = new Map(codes.map((c) => [c.id, c]));
  const byCode = new Map(codes.map((c) => [c.code, c]));
  const active = Boolean(registered && settings?.defaultSalesTaxCodeId);
  const rateFor = (code: (typeof codes)[number], date: string) => {
    const rate = rateOn(
      ratesOf(code).map((r) => ({
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
    registered,
    country,
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
    // Point-of-sale sales (ADR-059): paid orders by business date, less refunds
    // in the period they were paid out (each refund line keeps its order line's code and rate).
    const branchIds = scope.all ? null : scope.branchIds;
    const warehouseIds = scope.all ? null : scope.warehouseIds;
    const pos = await tx.$queryRaw<
      Array<{
        tax_code_id: string | null;
        tax_rate: Prisma.Decimal | null;
        lines: bigint;
        net: Prisma.Decimal;
        tax: Prisma.Decimal;
        gross: Prisma.Decimal;
      }>
    >`
      WITH sold AS (
        SELECT l.tax_code_id, l.tax_rate, l.net_amount AS net, l.tax_amount AS tax, l.gross_amount AS gross
        FROM pos_order_lines l JOIN pos_orders o ON o.id = l.order_id
        WHERE o.organization_id = ${ctx.organizationId}::uuid AND o.status = 'PAID'
          AND o.business_date BETWEEN ${period.from}::date AND ${period.to}::date
          AND (${branchIds}::uuid[] IS NULL OR o.branch_id = ANY(${branchIds}::uuid[])
               OR o.warehouse_id = ANY(${warehouseIds}::uuid[]))
      ), refunded AS (
        SELECT l.tax_code_id, l.tax_rate,
               -((x->>'gross')::numeric - (x->>'tax')::numeric) AS net,
               -(x->>'tax')::numeric AS tax, -(x->>'gross')::numeric AS gross
        FROM pos_refunds r
        JOIN pos_orders o ON o.id = r.order_id
        CROSS JOIN LATERAL jsonb_array_elements(r.lines) x
        JOIN pos_order_lines l ON l.id = (x->>'orderLineId')::uuid
        WHERE r.organization_id = ${ctx.organizationId}::uuid AND o.status = 'PAID'
          AND (r.created_at AT TIME ZONE ${ctx.timeZone})::date BETWEEN ${period.from}::date AND ${period.to}::date
          AND (${branchIds}::uuid[] IS NULL OR o.branch_id = ANY(${branchIds}::uuid[])
               OR o.warehouse_id = ANY(${warehouseIds}::uuid[]))
      )
      SELECT tax_code_id, tax_rate, COUNT(*) AS lines, SUM(net) AS net, SUM(tax) AS tax, SUM(gross) AS gross
      FROM (SELECT * FROM sold UNION ALL SELECT * FROM refunded) u
      GROUP BY tax_code_id, tax_rate`;
    const merged = new Map<
      string,
      {
        taxCodeId: string | null;
        rate: Decimal | null;
        lines: number;
        net: Decimal;
        tax: Decimal;
        gross: Decimal;
      }
    >();
    const add = (r: {
      taxCodeId: string | null;
      rate: { toString(): string } | null;
      lines: number;
      net: { toString(): string } | null;
      tax: { toString(): string } | null;
      gross: { toString(): string } | null;
    }) => {
      const key = `${r.taxCodeId ?? ""}|${r.rate === null ? "" : new Decimal(r.rate.toString()).toFixed()}`;
      const d = (v: { toString(): string } | null) => new Decimal(v?.toString() ?? 0);
      const m = merged.get(key);
      if (m) {
        m.lines += r.lines;
        m.net = m.net.plus(d(r.net));
        m.tax = m.tax.plus(d(r.tax));
        m.gross = m.gross.plus(d(r.gross));
      } else
        merged.set(key, {
          taxCodeId: r.taxCodeId,
          rate: r.rate === null ? null : d(r.rate),
          lines: r.lines,
          net: d(r.net),
          tax: d(r.tax),
          gross: d(r.gross),
        });
    };
    for (const r of rows)
      add({
        taxCodeId: r.taxCodeId,
        rate: r.taxRate,
        lines: r._count._all,
        net: r._sum.netAmount,
        tax: r._sum.taxAmount,
        gross: r._sum.grossAmount,
      });
    for (const r of pos)
      add({
        taxCodeId: r.tax_code_id,
        rate: r.tax_rate,
        lines: Number(r.lines),
        net: r.net,
        tax: r.tax,
        gross: r.gross,
      });
    const codes = await tx.taxCode.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, code: true, name: true, nameAr: true, category: true },
    });
    return [...merged.values()].map((r) => ({
      code: codes.find((c) => c.id === r.taxCodeId) ?? null,
      rate: r.rate,
      lines: r.lines,
      net: r.net,
      tax: r.tax,
      gross: r.gross,
    }));
  });
}
