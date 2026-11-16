import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ImportForm } from "@/components/inventory/forms";
import { MatchForm } from "@/components/nutrition/match-form";
import { StatTile } from "@/components/nutrition/engine-view";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { hasPermission } from "@/modules/access/authorize";
import { referenceCoverage, unmatchedProducts } from "@/modules/nutrition/product-reference";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { Tabs } from "../tabs";
import { confirmMatchesAction, importLinksAction } from "./actions";

const SOURCE_LABEL: Record<string, string> = {
  USDA_FDC: "USDA",
  OPEN_FOOD_FACTS: "Open Food Facts",
  WIKIDATA: "Wikidata",
  MANUAL: "Library",
};

/** Match products to library foods for their full nutrient profiles (ADR-136). */
export default async function MatchPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/nutrition/match">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "nutrition.view")) notFound();
  const manage = hasPermission(ctx.grants, "nutrition.manage");
  const [t, tc, locale, coverage, data] = await Promise.all([
    getTranslations("productReference"),
    getTranslations("catalog"),
    getLocale(),
    referenceCoverage(ctx),
    unmatchedProducts(ctx, sp),
  ]);
  const base = `/o/${orgSlug}/nutrition/match`;
  const pageHref = (page: number) => {
    const q = new URLSearchParams();
    if (data.filter.type !== "ALL") q.set("type", data.filter.type);
    if (data.filter.q) q.set("q", data.filter.q);
    q.set("page", String(page));
    return `${base}?${q}`;
  };
  return (
    <>
      <PageHeader title={t("matchTitle")} description={t("matchIntro")} />
      <Tabs orgSlug={orgSlug} current="match" />
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="reference-coverage">
          <StatTile label={t("coverageLinked")} value={coverage.linked} />
          <StatTile label={t("coverageUnlinked")} value={coverage.unlinked} />
        </div>
        <Card title={t("unlinkedTitle")}>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("filterType")}</span>
              <select name="type" defaultValue={data.filter.type} className={inputClass}>
                <option value="ALL">{t("allFoodTypes")}</option>
                {(["RAW_MATERIAL", "SEMI_FINISHED", "FINISHED_GOOD"] as const).map((k) => (
                  <option key={k} value={k}>
                    {tc(`types.${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("filterProduct")}</span>
              <input name="q" defaultValue={data.filter.q ?? ""} className={inputClass} />
            </label>
            <button type="submit" className={buttonClass("secondary")}>
              {t("show")}
            </button>
          </form>
          {manage ? (
            <MatchForm
              key={`${data.page}:${data.filter.type}:${data.filter.q ?? ""}`}
              empty={t("allLinked")}
              action={confirmMatchesAction.bind(null, orgSlug)}
              rows={data.items.map((i) => ({
                productId: i.product.id,
                sku: i.product.sku,
                name: (locale === "ar" && i.product.nameAr) || i.product.nameEn,
                type: tc(`types.${i.product.type}`),
                candidates: i.candidates.map((c) => ({
                  id: c.id,
                  label: `${(locale === "ar" && c.nameAr) || c.name} · ${SOURCE_LABEL[c.source]} ${c.sourceId} · ${
                    c.match === "BARCODE"
                      ? t("barcodeMatch")
                      : t("nameMatch", { score: Math.round(c.score * 100) })
                  } · ${t("nutrientCount", { count: c.nutrients })}`,
                })),
              }))}
            />
          ) : data.items.length === 0 ? (
            <EmptyState title={t("allLinked")} />
          ) : (
            <ul className="divide-border divide-y text-sm">
              {data.items.map((i) => (
                <li key={i.product.id} className="py-2">
                  <span className="ltr-value font-mono">{i.product.sku}</span> —{" "}
                  <bdi>{(locale === "ar" && i.product.nameAr) || i.product.nameEn}</bdi>
                </li>
              ))}
            </ul>
          )}
          {data.pageCount > 1 ? (
            <nav className="mt-4 flex items-center gap-3 text-sm" aria-label={t("pages")}>
              {data.page > 1 ? (
                <Link href={pageHref(data.page - 1)} className="text-primary hover:underline">
                  {t("previous")}
                </Link>
              ) : null}
              <span>{t("pageOf", { page: data.page, count: data.pageCount })}</span>
              {data.page < data.pageCount ? (
                <Link href={pageHref(data.page + 1)} className="text-primary hover:underline">
                  {t("next")}
                </Link>
              ) : null}
            </nav>
          ) : null}
        </Card>
        {manage ? (
          <ImportForm
            action={importLinksAction.bind(null, orgSlug)}
            title={t("uploadTitle")}
            hint={t("uploadHint")}
            templateHref={`/o/${orgSlug}/catalog/import/template?kind=links`}
          />
        ) : null}
      </div>
    </>
  );
}
