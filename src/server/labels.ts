import "server-only";
import { getTranslations } from "next-intl/server";
import { timeZoneOptions } from "@/lib/reference-data";
import { BRANCH_TYPES, TEMPERATURE_ZONES, WAREHOUSE_TYPES } from "@/modules/sites/schemas";
import type { BranchFormLabels } from "@/components/sites/branch-form";

/** Translated labels/options for forms rendered by client components. */
export async function branchFormProps(submit: string) {
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
  };
  return {
    labels,
    types: BRANCH_TYPES.map((v) => ({ value: v, label: t(`branches.types.${v}`) })),
    timeZones: timeZoneOptions(),
  };
}

export async function warehouseOptions() {
  const t = await getTranslations();
  return {
    types: WAREHOUSE_TYPES.map((v) => ({ value: v, label: t(`warehouses.types.${v}`) })),
    zones: TEMPERATURE_ZONES.map((v) => ({ value: v, label: t(`warehouses.zones.${v}`) })),
  };
}
