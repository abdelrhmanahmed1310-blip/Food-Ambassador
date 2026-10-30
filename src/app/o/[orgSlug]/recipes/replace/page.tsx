import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { BulkReplaceForm } from "@/components/recipes/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { listProductOptions } from "@/modules/catalog/service";
import { recipesUsingProduct } from "@/modules/recipes/menu";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { productName } from "@/server/inventory-view";
import { bulkReplaceAction } from "../actions";

export default async function ReplaceIngredientPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/recipes/replace">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "recipes.manage")) notFound();
  const from = typeof sp.from === "string" && isUuid(sp.from) ? sp.from : undefined;
  const [t, locale, products] = await Promise.all([
    getTranslations(),
    getLocale(),
    listProductOptions(ctx),
  ]);
  const using = from ? await recipesUsingProduct(ctx, from) : [];
  const label = (p: (typeof products)[number]) =>
    `${p.sku} — ${productName(p, locale)} (${p.baseUom.code})`;
  return (
    <>
      <PageHeader title={t("recipes.replaceTitle")} description={t("recipes.replaceHint")} />
      <div className="space-y-6">
        <Card>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("recipes.replaceProduct")}</span>
              <select
                name="from"
                defaultValue={from ?? ""}
                required
                className="border-border bg-surface rounded-md border px-3 py-2"
              >
                <option value="">{t("common.select")}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {label(p)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
            >
              {t("recipes.findRecipes")}
            </button>
          </form>
        </Card>
        {from ? (
          <Card>
            {/* The form stays mounted after a replacement so its result message remains visible. */}
            {using.length === 0 ? (
              <p className="text-muted mb-4 text-sm">{t("recipes.notUsedAnywhere")}</p>
            ) : null}
            <BulkReplaceForm
              key={from}
              action={bulkReplaceAction.bind(null, orgSlug)}
              fromProductId={from}
              products={products
                .filter((p) => p.id !== from)
                .map((p) => ({ value: p.id, label: label(p) }))}
              recipes={using.map((r) => ({
                value: r.id,
                label: `${r.code} — ${(locale === "ar" && r.nameAr) || r.name}`,
                hint:
                  r.versions.length > 0 ? t("recipes.hasDraftSkip") : t(`recipes.types.${r.type}`),
              }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
