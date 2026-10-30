import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { TargetForm } from "@/components/recipes/forms";
import { FoodCostBadge } from "@/components/recipes/status-badge";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { costWarehouseOptions } from "@/modules/recipes/costs";
import { COST_POLICIES } from "@/modules/recipes/costing";
import { foodCostReport } from "@/modules/recipes/menu";
import type { FoodCostStatus } from "@/modules/recipes/pricing";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { updateRecipeSettingsAction } from "../actions";

const ORDER: FoodCostStatus[] = ["ABOVE_TARGET", "INCOMPLETE", "NO_PRICE", "NO_TARGET", "OK"];

export default async function FoodCostPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/recipes/food-cost">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "recipes.costs.view")) notFound();
  const policy = COST_POLICIES.find((p) => p === sp.policy) ?? "AVERAGE";
  const warehouseId =
    typeof sp.warehouseId === "string" && isUuid(sp.warehouseId) ? sp.warehouseId : undefined;
  const [t, locale, money, report, warehouses] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
    foodCostReport(ctx, { policy, warehouseId }),
    costWarehouseOptions(ctx),
  ]);
  const pct = (f: { times(n: number): { toFixed(dp: number): string } }) =>
    `${f.times(100).toFixed(1)} %`;
  const rows = [...report.rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const counts = ORDER.map((s) => [s, report.rows.filter((r) => r.status === s).length] as const);
  return (
    <>
      <PageHeader title={t("recipes.foodCostTitle")} description={t("recipes.foodCostHint")} />
      <div className="space-y-6">
        <Card>
          <div className="flex flex-wrap items-end justify-between gap-6">
            <form method="get" className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t("recipes.policy")}</span>
                <select
                  name="policy"
                  defaultValue={policy}
                  className="border-border bg-surface rounded-md border px-3 py-2"
                >
                  {COST_POLICIES.map((p) => (
                    <option key={p} value={p}>
                      {t(`recipes.policies.${p}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">{t("recipes.averageFrom")}</span>
                <select
                  name="warehouseId"
                  defaultValue={warehouseId ?? ""}
                  className="border-border bg-surface rounded-md border px-3 py-2"
                >
                  <option value="">{t("recipes.wholeOrganization")}</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
              >
                {t("recipes.recalculate")}
              </button>
            </form>
            {hasPermission(ctx.grants, "recipes.manage") ? (
              <div className="min-w-64">
                <TargetForm
                  action={updateRecipeSettingsAction.bind(null, orgSlug)}
                  label={t("recipes.orgTarget")}
                  hint={t("recipes.orgTargetHint")}
                  defaultValue={
                    report.orgTarget ? report.orgTarget.times(100).toFixed() : undefined
                  }
                />
              </div>
            ) : (
              <p className="text-sm">
                {t("recipes.orgTarget")}:{" "}
                {report.orgTarget ? pct(report.orgTarget) : t("recipes.noTarget")}
              </p>
            )}
          </div>
          <ul className="mt-4 flex flex-wrap gap-3 text-sm" aria-label={t("common.status")}>
            {counts.map(([s, n]) => (
              <li key={s} className="flex items-center gap-2">
                <FoodCostBadge status={s} />{" "}
                <span className="tabular-nums" data-testid={`count-${s}`}>
                  {n}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        {rows.length === 0 ? (
          <EmptyState title={t("recipes.noActiveDishes")} />
        ) : (
          <Table label={t("recipes.foodCostTitle")}>
            <thead>
              <tr>
                <Th>{t("recipes.title")}</Th>
                <Th>{t("recipes.costPerPortion")}</Th>
                <Th>{t("recipes.sellingPrice")}</Th>
                <Th>{t("recipes.foodCostPercent")}</Th>
                <Th>{t("recipes.target")}</Th>
                <Th>{t("recipes.margin")}</Th>
                <Th>{t("recipes.priceForTarget")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.recipe.id} data-testid={`dish-${r.recipe.code}`}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/recipes/${r.recipe.id}/versions/${r.version.id}`}
                      className="text-primary hover:underline"
                    >
                      <span className="ltr-value font-mono text-xs">{r.recipe.code}</span>
                    </Link>
                    <span className="block">
                      {(locale === "ar" && r.recipe.nameAr) || r.recipe.name}
                    </span>
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value whitespace-nowrap">
                      {money.money(r.costPerPortion)}
                    </span>
                    {r.missingCount > 0 ? (
                      <span className="text-muted block text-xs">
                        {t("recipes.missingCount", { count: r.missingCount })}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value whitespace-nowrap">
                      {r.price ? money.money(r.price.entered) : "—"}
                    </span>
                    {r.price?.includesTax ? (
                      <span className="text-muted block text-xs">
                        {r.price.net
                          ? t("tax.netOfVat", { amount: money.money(r.price.net) })
                          : t("tax.noRateForPrice")}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value">{r.fraction ? pct(r.fraction) : "—"}</span>
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value">{r.target ? pct(r.target) : "—"}</span>
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value whitespace-nowrap">
                      {r.margin ? money.money(r.margin) : "—"}
                    </span>
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value whitespace-nowrap">
                      {r.suggested ? money.money(r.suggested) : "—"}
                    </span>
                  </Td>
                  <Td>
                    <FoodCostBadge status={r.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
