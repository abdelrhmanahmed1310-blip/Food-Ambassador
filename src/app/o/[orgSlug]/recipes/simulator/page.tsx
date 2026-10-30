import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { FoodCostBadge } from "@/components/recipes/status-badge";
import { Alert, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { listProductOptions } from "@/modules/catalog/service";
import { COST_POLICIES } from "@/modules/recipes/costing";
import { simulatePrice } from "@/modules/recipes/menu";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, productName } from "@/server/inventory-view";
import { DECIMAL_PATTERN } from "@/lib/decimal";

export default async function SimulatorPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/recipes/simulator">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "recipes.costs.view")) notFound();
  const productId =
    typeof sp.productId === "string" && isUuid(sp.productId) ? sp.productId : undefined;
  const unitCost =
    typeof sp.unitCost === "string" && DECIMAL_PATTERN.test(sp.unitCost.trim())
      ? sp.unitCost.trim()
      : undefined;
  const policy = COST_POLICIES.find((p) => p === sp.policy) ?? "AVERAGE";
  const [t, locale, money, products] = await Promise.all([
    getTranslations(),
    getLocale(),
    moneyFormatter(ctx.baseCurrency),
    listProductOptions(ctx),
  ]);
  const result =
    productId && unitCost
      ? await notFoundOnAppError(simulatePrice(ctx, { productId, unitCost }, { policy }))
      : null;
  const pct = (f: { times(n: number): { toFixed(dp: number): string } } | null) =>
    f ? `${f.times(100).toFixed(1)} %` : "—";
  return (
    <>
      <PageHeader title={t("recipes.simulatorTitle")} description={t("recipes.simulatorHint")} />
      <div className="space-y-6">
        <Card>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("recipes.ingredient")}</span>
              <select
                name="productId"
                defaultValue={productId ?? ""}
                required
                className="border-border bg-surface rounded-md border px-3 py-2"
              >
                <option value="">{t("common.select")}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {productName(p, locale)} ({p.baseUom.code})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">
                {t("recipes.newUnitCost", { currency: ctx.baseCurrency })}
              </span>
              <input
                name="unitCost"
                defaultValue={unitCost}
                inputMode="decimal"
                dir="ltr"
                required
                className="border-border bg-surface rounded-md border px-3 py-2"
              />
            </label>
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
            <button
              type="submit"
              className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
            >
              {t("recipes.simulate")}
            </button>
          </form>
        </Card>
        {result ? (
          <>
            <Alert tone="info">
              {t("recipes.simulationNote", {
                product: `${result.product.sku} — ${productName(result.product, locale)}`,
                cost: `${money.unitCost(result.unitCost)} / ${result.product.baseUom}`,
              })}
            </Alert>
            {result.rows.length === 0 ? (
              <EmptyState title={t("recipes.noDishesUse")} />
            ) : (
              <Table label={t("recipes.simulatorTitle")}>
                <thead>
                  <tr>
                    <Th>{t("recipes.title")}</Th>
                    <Th>{t("recipes.costNow")}</Th>
                    <Th>{t("recipes.costSimulated")}</Th>
                    <Th>{t("recipes.change")}</Th>
                    <Th>{t("recipes.foodCostPercent")}</Th>
                    <Th>{t("recipes.priceForTarget")}</Th>
                    <Th>{t("common.status")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.recipe.id} data-testid={`sim-${r.recipe.code}`}>
                      <Td>
                        <Link
                          href={`/o/${orgSlug}/recipes/${r.recipe.id}`}
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
                          {money.money(r.before.costPerPortion)}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {money.money(r.after.costPerPortion)}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {r.change.gt(0) ? "+" : ""}
                          {money.money(r.change)}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {pct(r.before.fraction)} → {pct(r.after.fraction)}
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span className="ltr-value whitespace-nowrap">
                          {r.after.suggested ? money.money(r.after.suggested) : "—"}
                        </span>
                      </Td>
                      <Td>
                        <FoodCostBadge status={r.after.status} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
