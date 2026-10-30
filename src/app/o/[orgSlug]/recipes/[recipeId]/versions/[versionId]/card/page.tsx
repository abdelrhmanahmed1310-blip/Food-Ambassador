import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { PrintButton } from "@/components/ui/print-button";
import { isUuid } from "@/lib/uuid";
import { calculateVersionCost } from "@/modules/recipes/costs";
import { grossQuantity } from "@/modules/recipes/costing";
import { getVersion } from "@/modules/recipes/recipes";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, productName, quantityFormatter } from "@/server/inventory-view";

/** Printable recipe card; costs only for users who may see them and ask for them. */
export default async function RecipeCardPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/recipes/[recipeId]/versions/[versionId]/card">) {
  const { orgSlug, recipeId, versionId } = await params;
  if (!isUuid(versionId) || !isUuid(recipeId)) notFound();
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  const version = await notFoundOnAppError(getVersion(ctx, versionId));
  if (version.recipeId !== recipeId) notFound();
  const withCosts = version.can.costs && sp.costs === "1";
  const [t, locale, fmt, money, live] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
    withCosts ? calculateVersionCost(ctx, version.id, {}) : Promise.resolve(null),
  ]);
  const recipe = version.recipe;
  const base = `/o/${orgSlug}/recipes/${recipe.id}/versions/${version.id}/card`;
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <a
          href={`/o/${orgSlug}/recipes/${recipe.id}/versions/${version.id}`}
          className="text-primary text-sm hover:underline"
        >
          {t("common.back")}
        </a>
        <div className="flex items-center gap-3">
          {version.can.costs ? (
            <a
              href={withCosts ? base : `${base}?costs=1`}
              className="text-primary text-sm hover:underline"
            >
              {withCosts ? t("recipes.hideCosts") : t("recipes.showCosts")}
            </a>
          ) : null}
          <PrintButton label={t("recipes.print")} />
        </div>
      </div>
      <header className="border-border border-b pb-4">
        <p className="ltr-value text-muted font-mono text-sm">
          {recipe.code} · {t("recipes.versionNo", { no: version.versionNo })} ·{" "}
          {t(`recipes.statuses.${version.status}`)}
        </p>
        <h1 className="text-2xl font-semibold">
          {(locale === "ar" && recipe.nameAr) || recipe.name}
        </h1>
        <p className="mt-1 text-sm">
          {t("recipes.yield")}:{" "}
          <span className="ltr-value tabular-nums">
            {fmt(version.yieldQuantity)} {version.yieldUom.code}
          </span>
          {version.portions ? (
            <> · {t("recipes.portionsCount", { count: fmt(version.portions) })}</>
          ) : null}
        </p>
      </header>
      <section>
        <h2 className="mb-2 text-lg font-medium">{t("recipes.ingredients")}</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border border-b text-start">
              <th className="py-1 text-start font-medium">{t("recipes.ingredient")}</th>
              <th className="py-1 text-start font-medium">{t("recipes.netQuantity")}</th>
              <th className="py-1 text-start font-medium">{t("recipes.grossQuantity")}</th>
              {live ? <th className="py-1 text-start font-medium">{t("recipes.cost")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {version.ingredients.map((i) => {
              const line = live?.cost.lines.find((l) => l.ingredientId === i.id);
              return (
                <tr key={i.id} className="border-border border-b">
                  <td className="py-1">
                    {i.product
                      ? productName(i.product, locale)
                      : (locale === "ar" && i.subRecipe?.nameAr) || i.subRecipe?.name}
                    {i.note ? <span className="text-muted block text-xs">{i.note}</span> : null}
                  </td>
                  <td className="ltr-value py-1 tabular-nums">
                    {fmt(i.quantity)} {i.uom.code}
                  </td>
                  <td className="ltr-value py-1 tabular-nums">
                    {fmt(grossQuantity(i.quantity, i.wasteFraction))} {i.uom.code}
                  </td>
                  {live ? (
                    <td className="ltr-value py-1 tabular-nums">
                      {line?.cost ? money.money(line.cost) : t("recipes.missing.NO_COST")}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {live ? (
          <p className="mt-2 text-sm font-medium">
            {t("recipes.totalCost")}:{" "}
            <span className="ltr-value">{money.money(live.cost.totalCost)}</span>
            {live.cost.costPerPortion ? (
              <>
                {" "}
                · {t("recipes.costPerPortion")}:{" "}
                <span className="ltr-value">{money.money(live.cost.costPerPortion)}</span>
              </>
            ) : null}
            {live.cost.missingCount > 0 ? (
              <> · {t("recipes.missingCount", { count: live.cost.missingCount })}</>
            ) : null}
          </p>
        ) : null}
      </section>
      <section>
        <h2 className="mb-2 text-lg font-medium">{t("recipes.method")}</h2>
        <p className="text-sm whitespace-pre-line">{version.method ?? t("recipes.noMethod")}</p>
      </section>
      {version.note ? <p className="text-muted text-sm">{version.note}</p> : null}
    </article>
  );
}
