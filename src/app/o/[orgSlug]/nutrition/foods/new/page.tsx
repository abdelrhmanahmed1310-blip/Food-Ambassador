import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";
import { Alert, Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listCategories, listNutrients } from "@/modules/nutrition/engine/foods";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createFoodAction } from "../../actions";
import { Tabs } from "../../tabs";

/**
 * A food of the organization's own (source MANUAL), e.g. from a verified
 * packaging label. Empty fields stay missing; "NA" marks not applicable.
 */
export default async function NewFoodPage({
  params,
}: PageProps<"/o/[orgSlug]/nutrition/foods/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "nutrition.manage")) notFound();
  const [t, locale, nutrients, categories] = await Promise.all([
    getTranslations("nutritionEngine"),
    getLocale(),
    listNutrients(ctx),
    listCategories(ctx),
  ]);
  const fields = nutrients.filter((n) => n.code && (n.isCore || n.custom));
  return (
    <>
      <PageHeader title={t("newFood")} description={t("newFoodIntro")} />
      <Tabs orgSlug={orgSlug} current="foods" />
      <Card>
        <ActionForm
          action={createFoodAction.bind(null, orgSlug)}
          submitLabel={t("createFood")}
          idempotent
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField name="name" label={t("nameEn")} required dir="auto" />
            <TextField name="nameAr" label={t("nameAr")} dir="rtl" />
            <TextField name="brand" label={t("brand")} dir="auto" />
            <TextField name="barcode" label={t("barcode")} inputMode="numeric" dir="ltr" />
            <SelectField
              name="categoryId"
              label={t("category")}
              placeholder="—"
              options={categories.map((c) => ({
                value: c.id,
                label: (locale === "ar" && c.nameAr) || c.name,
              }))}
            />
            <SelectField
              name="basis"
              label={t("basis")}
              defaultValue="PER_100G"
              options={[
                { value: "PER_100G", label: t("per100g") },
                { value: "PER_100ML", label: t("per100ml") },
              ]}
            />
            <TextField name="reference" label={t("reference")} hint={t("referenceHint")} />
            <TextField
              name="ingredientsText"
              label={t("ingredientsDeclared")}
              dir="auto"
              hint={t("notTranslated")}
            />
          </div>
          <Alert tone="info">{t("valuesEntryNote")}</Alert>
          <div className="grid gap-4 sm:grid-cols-3">
            {fields.map((n) => (
              <TextField
                key={n.id}
                name={`v.${n.code}`}
                label={`${(locale === "ar" && n.nameAr) || n.name} (${n.unit})`}
                inputMode="decimal"
                dir="ltr"
                errorKeys={[`values.${n.code}`]}
              />
            ))}
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
