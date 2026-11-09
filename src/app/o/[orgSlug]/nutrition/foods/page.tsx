import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ActionForm } from "@/components/forms/fields";
import { Pagination } from "@/components/ui/pagination";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { hasPermission } from "@/modules/access/authorize";
import { listCategories, offPreview, searchFoods } from "@/modules/nutrition/engine/foods";
import { USDA_DATA_TYPES } from "@/modules/nutrition/engine/providers";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { quantityFormatter } from "@/server/inventory-view";
import { importOffAction, importUsdaAction } from "../actions";
import { Tabs } from "../tabs";

const str = (v: string | string[] | undefined) =>
  typeof v === "string" ? v.slice(0, 200) : undefined;

/** Food search across the library and USDA FoodData Central (ADR-132). */
export default async function FoodsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/nutrition/foods">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "nutrition.view")) notFound();
  const query = {
    q: str(sp.q),
    mode: str(sp.mode),
    source: str(sp.source),
    dataType: str(sp.dataType),
    categoryId: str(sp.categoryId),
    verified: str(sp.verified),
    sort: str(sp.sort),
    page: str(sp.page),
  };
  const [t, locale, fmt, r, categories] = await Promise.all([
    getTranslations("nutritionEngine"),
    getLocale(),
    quantityFormatter(),
    searchFoods(ctx, query),
    listCategories(ctx),
  ]);
  // A barcode the library does not know: ask Open Food Facts too (crowd-sourced, a lead only).
  const off =
    query.q && /^\d{6,14}$/.test(query.q.trim()) && r.local.total === 0
      ? await offPreview(ctx, query.q.trim())
      : null;
  const base = `/o/${orgSlug}/nutrition/foods`;
  const manage = hasPermission(ctx.grants, "nutrition.manage");
  const select = (
    name: string,
    value: string | undefined,
    options: Array<[string, string]>,
    all?: string,
  ) => (
    <label className="text-sm">
      <span className="mb-1 block font-medium">{t(`filters.${name}`)}</span>
      <select
        name={name}
        defaultValue={value ?? ""}
        className="border-border bg-surface rounded-md border px-3 py-2"
      >
        {all ? <option value="">{all}</option> : null}
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
  const pageCount = Math.max(1, Math.ceil(r.local.total / r.pageSize));
  return (
    <>
      <PageHeader
        title={t("foodsTitle")}
        description={t("foodsIntro")}
        actions={
          manage ? (
            <Link href={`${base}/new`} className={buttonClass("primary")}>
              {t("newFood")}
            </Link>
          ) : null
        }
      />
      <Tabs orgSlug={orgSlug} current="foods" />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3" role="search">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("filters.q")}</span>
            <input
              name="q"
              defaultValue={query.q}
              dir="auto"
              placeholder={t("searchPlaceholder")}
              className="border-border bg-surface w-72 rounded-md border px-3 py-2"
            />
          </label>
          {select("mode", r.mode, [
            ["HYBRID", t("modes.HYBRID")],
            ["LOCAL", t("modes.LOCAL")],
            ["USDA", t("modes.USDA")],
          ])}
          {select(
            "source",
            query.source,
            (["USDA_FDC", "OPEN_FOOD_FACTS", "WIKIDATA", "MANUAL"] as const).map((s) => [
              s,
              t(`sources.${s}`),
            ]),
            t("all"),
          )}
          {select(
            "dataType",
            query.dataType,
            USDA_DATA_TYPES.map((d) => [d, d]),
            t("all"),
          )}
          {select(
            "categoryId",
            query.categoryId,
            categories.map((c) => [c.id, (locale === "ar" && c.nameAr) || c.name]),
            t("all"),
          )}
          {select(
            "verified",
            query.verified,
            [
              ["true", t("verified")],
              ["false", t("unverified")],
            ],
            t("all"),
          )}
          {select(
            "sort",
            query.sort,
            (["relevance", "name", "updated", "energy"] as const).map((s) => [s, t(`sorts.${s}`)]),
          )}
          <button type="submit" className={buttonClass("secondary")}>
            {t("search")}
          </button>
        </form>

        {r.mode !== "USDA" ? (
          <Card title={t("libraryResults", { count: r.local.total })}>
            {r.local.items.length === 0 ? (
              <EmptyState title={t("noFoods")} />
            ) : (
              <Table label={t("libraryResults", { count: r.local.total })}>
                <thead>
                  <tr>
                    <Th>{t("name")}</Th>
                    <Th>{t("source")}</Th>
                    <Th>{t("category")}</Th>
                    <Th>{t("energy")}</Th>
                    <Th>{t("status")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.local.items.map((f) => (
                    <tr key={f.id} data-testid="food-row">
                      <Td>
                        <Link href={`${base}/${f.id}`} className="text-primary hover:underline">
                          <bdi>{(locale === "ar" && f.nameAr) || f.name}</bdi>
                        </Link>
                        {f.brand ? (
                          <span className="text-muted block text-xs">
                            <bdi>{f.brand}</bdi>
                          </span>
                        ) : null}
                      </Td>
                      <Td className="text-xs">
                        {t(`sources.${f.source as "MANUAL"}`)}
                        <span className="ltr-value text-muted block font-mono">
                          {f.sourceId}
                          {f.dataType ? ` · ${f.dataType}` : ""}
                        </span>
                      </Td>
                      <Td className="text-xs">
                        <bdi>{(locale === "ar" && f.categoryAr) || f.category || "—"}</bdi>
                      </Td>
                      <Td className="ltr-value tabular-nums">
                        {f.energyKcal ? (
                          `${fmt(f.energyKcal)} kcal`
                        ) : (
                          <span className="text-warning">{t("values.MISSING")}</span>
                        )}
                      </Td>
                      <Td className="space-x-1 rtl:space-x-reverse">
                        {f.verified ? (
                          <Badge tone="success">{t("verified")}</Badge>
                        ) : (
                          <Badge tone="muted">{t("unverified")}</Badge>
                        )}
                        {f.stale ? <Badge tone="warning">{t("stale")}</Badge> : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <Pagination
              basePath={base}
              params={{ ...query, page: undefined }}
              page={r.page}
              pageCount={pageCount}
              total={r.local.total}
            />
          </Card>
        ) : null}

        {off ? (
          <Card title={t("offTitle")}>
            {off.status !== "OK" || !off.product ? (
              <Alert tone="info">{t(`offStatus.${off.status}`)}</Alert>
            ) : (
              <div className="space-y-3 text-sm" data-testid="off-result">
                <p>
                  <bdi className="font-medium">
                    {(locale === "ar" && off.product.nameAr) || off.product.name}
                  </bdi>
                  {off.product.brand ? (
                    <span className="text-muted">
                      {" · "}
                      <bdi>{off.product.brand}</bdi>
                    </span>
                  ) : null}
                  <span className="ltr-value text-muted font-mono"> · {off.product.barcode}</span>
                </p>
                <p className="ltr-value">
                  {off.product.values.energyKcal
                    ? `${fmt(off.product.values.energyKcal)} kcal`
                    : "—"}
                  {off.product.basis
                    ? ` / ${off.product.basis === "PER_100ML" ? "100 ml" : "100 g"}`
                    : ""}
                </p>
                <Alert tone="info">{t("offNote")}</Alert>
                {manage ? (
                  <ActionForm
                    action={importOffAction.bind(null, orgSlug)}
                    submitLabel={t("import")}
                    submitVariant="secondary"
                    className="inline-flex flex-col items-start gap-1"
                  >
                    <input type="hidden" name="barcode" value={off.product.barcode} />
                  </ActionForm>
                ) : null}
                <p className="text-muted text-xs">{t("offAttribution")}</p>
              </div>
            )}
          </Card>
        ) : null}

        {r.mode !== "LOCAL" ? (
          <Card title={t("usdaResults")}>
            {r.external.status === "SKIPPED" ? (
              <p className="text-muted text-sm">{t("usdaNeedsQuery")}</p>
            ) : r.external.status !== "OK" ? (
              <Alert tone="info">{t(`external.${r.external.status}`)}</Alert>
            ) : r.external.items.length === 0 ? (
              <EmptyState title={t("noUsdaFoods")} />
            ) : (
              <Table label={t("usdaResults")}>
                <thead>
                  <tr>
                    <Th>{t("name")}</Th>
                    <Th>{t("source")}</Th>
                    <Th>{t("energy")}</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {r.external.items.map((f) => (
                    <tr key={f.fdcId} data-testid="usda-row">
                      <Td>
                        <bdi>{f.name}</bdi>
                        {f.brand ? (
                          <span className="text-muted block text-xs">
                            <bdi>{f.brand}</bdi>
                          </span>
                        ) : null}
                      </Td>
                      <Td className="ltr-value font-mono text-xs">
                        FDC {f.fdcId}
                        {f.dataType ? ` · ${f.dataType}` : ""}
                      </Td>
                      <Td className="ltr-value tabular-nums">
                        {f.energyKcal ? (
                          `${fmt(f.energyKcal)} kcal`
                        ) : (
                          <span className="text-warning">{t("values.MISSING")}</span>
                        )}
                      </Td>
                      <Td>
                        {manage ? (
                          <ActionForm
                            action={importUsdaAction.bind(null, orgSlug)}
                            submitLabel={t("import")}
                            submitVariant="secondary"
                            className="inline-flex flex-col items-start gap-1"
                          >
                            <input type="hidden" name="fdcIds" value={f.fdcId} />
                          </ActionForm>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <p className="text-muted mt-3 text-xs">{t("usdaAttribution")}</p>
          </Card>
        ) : null}
      </div>
    </>
  );
}
