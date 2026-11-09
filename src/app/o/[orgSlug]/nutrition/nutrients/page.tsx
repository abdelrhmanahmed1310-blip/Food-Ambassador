import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";
import { Badge, Card, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listNutrients } from "@/modules/nutrition/engine/foods";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createNutrientAction } from "../actions";
import { Tabs } from "../tabs";

const GROUPS = [
  "ENERGY",
  "PROXIMATES",
  "CARBOHYDRATES",
  "LIPIDS",
  "MINERALS",
  "VITAMINS",
  "AMINO_ACIDS",
  "OTHER",
] as const;
const UNITS = ["g", "mg", "µg", "kcal", "kJ", "IU"] as const;

/** The nutrient dictionary: shared (mapped to USDA) and the organization's own (ADR-132). */
export default async function NutrientsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/nutrition/nutrients">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "nutrition.view")) notFound();
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const group = typeof sp.group === "string" ? sp.group : undefined;
  const [t, locale, nutrients] = await Promise.all([
    getTranslations("nutritionEngine"),
    getLocale(),
    listNutrients(ctx, { q, group }),
  ]);
  return (
    <>
      <PageHeader title={t("nutrientsTitle")} description={t("nutrientsIntro")} />
      <Tabs orgSlug={orgSlug} current="nutrients" />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("filters.q")}</span>
            <input
              name="q"
              defaultValue={q}
              dir="auto"
              className="border-border bg-surface rounded-md border px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("group")}</span>
            <select
              name="group"
              defaultValue={group ?? ""}
              className="border-border bg-surface rounded-md border px-3 py-2"
            >
              <option value="">{t("all")}</option>
              {GROUPS.map((g) => (
                <option key={g} value={g}>
                  {t(`groups.${g}`)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
          >
            {t("search")}
          </button>
        </form>
        <Table label={t("nutrientsTitle")}>
          <thead>
            <tr>
              <Th>{t("nutrient")}</Th>
              <Th>{t("code")}</Th>
              <Th>{t("unit")}</Th>
              <Th>{t("group")}</Th>
              <Th>{t("usdaMapping")}</Th>
              <Th>{t("valuesStored")}</Th>
            </tr>
          </thead>
          <tbody>
            {nutrients.map((n) => (
              <tr key={n.id} data-testid="nutrient-row">
                <Td>
                  {(locale === "ar" && n.nameAr) || n.name}
                  {locale === "ar" && !n.nameAr ? (
                    <span className="text-muted ms-1 text-xs">({t("noArabicName")})</span>
                  ) : null}
                  {n.isCore ? <Badge tone="success">{t("core")}</Badge> : null}
                  {n.custom ? <Badge tone="warning">{t("custom")}</Badge> : null}
                </Td>
                <Td className="ltr-value font-mono text-xs">{n.code ?? "—"}</Td>
                <Td className="ltr-value">{n.unit}</Td>
                <Td className="text-xs">{t(`groups.${n.group as "OTHER"}`)}</Td>
                <Td className="ltr-value font-mono text-xs">
                  {n.usdaNutrientId
                    ? `#${n.usdaNutrientId}${n.usdaNumber ? ` / ${n.usdaNumber}` : ""}`
                    : "—"}
                </Td>
                <Td className="ltr-value tabular-nums">{n.valueCount}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-muted text-xs">{t("arabicReviewNote")}</p>
        {hasPermission(ctx.grants, "nutrition.manage") ? (
          <Card title={t("customNutrient")}>
            <ActionForm
              action={createNutrientAction.bind(null, orgSlug)}
              submitLabel={t("add")}
              className="grid gap-3 sm:grid-cols-3"
            >
              <TextField name="code" label={t("code")} hint={t("codeHint")} required dir="ltr" />
              <TextField name="name" label={t("nameEn")} required />
              <TextField name="nameAr" label={t("nameAr")} dir="rtl" />
              <SelectField
                name="unit"
                label={t("unit")}
                required
                options={UNITS.map((u) => ({ value: u, label: u }))}
                placeholder="—"
              />
              <SelectField
                name="group"
                label={t("group")}
                defaultValue="OTHER"
                options={GROUPS.map((g) => ({ value: g, label: t(`groups.${g}`) }))}
              />
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </>
  );
}
