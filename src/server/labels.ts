import "server-only";
import type { TenantContext } from "@/modules/tenancy/context";
import { listBrands, listCompanies } from "@/modules/organizations/companies";
import { getTranslations } from "next-intl/server";
import { timeZoneOptions } from "@/lib/reference-data";
import { BRANCH_TYPES, TEMPERATURE_ZONES, WAREHOUSE_TYPES } from "@/modules/sites/schemas";
import type { BranchFormLabels } from "@/components/sites/branch-form";

/** Translated labels/options for forms rendered by client components. */
/** Branch form labels and choices; `entity` adds company (new branches) and brand choices. */
export async function branchFormProps(
  submit: string,
  entity?: { ctx: TenantContext; withCompanies: boolean },
) {
  const t = await getTranslations();
  const labels: BranchFormLabels = {
    submit,
    pending: t("common.saving"),
    code: t("branches.code"),
    codeHint: t("branches.codeHint"),
    name: t("branches.name"),
    type: t("branches.type"),
    timeZone: t("branches.timeZone"),
    timeZoneHint: t("branches.timeZoneHint"),
    address: t("branches.address"),
    city: t("branches.city"),
    country: t("branches.country"),
    countryHint: t("branches.countryHint"),
    optional: t("common.optional"),
    company: t("branches.company"),
    brand: t("branches.brand"),
  };
  const [companies, brands] = entity
    ? await Promise.all([
        entity.withCompanies ? listCompanies(entity.ctx) : Promise.resolve([]),
        listBrands(entity.ctx),
      ])
    : [[], []];
  return {
    labels,
    types: BRANCH_TYPES.map((v) => ({ value: v, label: t(`branches.types.${v}`) })),
    timeZones: timeZoneOptions(),
    companies: companies.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}` })),
    brands: brands.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })),
  };
}

export async function warehouseOptions() {
  const t = await getTranslations();
  return {
    types: WAREHOUSE_TYPES.map((v) => ({ value: v, label: t(`warehouses.types.${v}`) })),
    zones: TEMPERATURE_ZONES.map((v) => ({ value: v, label: t(`warehouses.zones.${v}`) })),
  };
}
