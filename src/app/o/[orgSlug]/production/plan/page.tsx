import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { warehouseOptions } from "@/modules/inventory/queries";
import { PLAN_BASES, productionPlan, type PlanBasis } from "@/modules/production/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { quantityFormatter } from "@/server/inventory-view";

export default async function ProductionPlanPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/production/plan">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "production.view")) notFound();
  const warehouses = await warehouseOptions(ctx, "production.view");
  const chosen =
    typeof sp.warehouseId === "string" && isUuid(sp.warehouseId)
      ? sp.warehouseId
      : warehouses[0]?.id;
  // Forecast options (ADR-121); anything unexpected falls back to the defaults.
  const coverDays =
    typeof sp.coverDays === "string" &&
    /^\d{1,2}$/.test(sp.coverDays) &&
    Number(sp.coverDays) >= 1 &&
    Number(sp.coverDays) <= 14
      ? sp.coverDays
      : "2";
  const basis: PlanBasis = PLAN_BASES.includes(sp.basis as PlanBasis)
    ? (sp.basis as PlanBasis)
    : "KITCHEN";
  const [t, locale, fmt, plan] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    chosen ? productionPlan(ctx, chosen, { coverDays, basis }) : Promise.resolve(null),
  ]);
  const manage = holdsAnyGrant(ctx.grants, "production.manage");
  const q = (v: { toString(): string }, unit: string) => (
    <span className="ltr-value whitespace-nowrap">
      {fmt(v)} {unit}
    </span>
  );
  return (
    <>
      <PageHeader title={t("production.planTitle")} description={t("production.planHint")} />
      <div className="space-y-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("production.warehouse")}</span>
            <select
              name="warehouseId"
              defaultValue={chosen ?? ""}
              className="border-border bg-surface rounded-md border px-3 py-2"
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("production.coverDays")}</span>
            <input
              name="coverDays"
              type="number"
              min={1}
              max={14}
              defaultValue={coverDays}
              dir="ltr"
              className="border-border bg-surface w-24 rounded-md border px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("production.forecastBasis")}</span>
            <select
              name="basis"
              defaultValue={basis}
              className="border-border bg-surface rounded-md border px-3 py-2"
            >
              {PLAN_BASES.map((b) => (
                <option key={b} value={b}>
                  {t(`production.forecastBases.${b}`)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
          >
            {t("common.apply")}
          </button>
        </form>
        <Alert tone="info">{t("production.planNote")}</Alert>
        {plan ? (
          <p className="text-muted text-sm">
            {t(`production.forecastNote.${plan.options.basis}`, {
              days: plan.options.coverDays,
              level: `${Math.round(Number(plan.serviceLevel) * 100)}%`,
            })}
          </p>
        ) : null}
        {!plan || plan.rows.length === 0 ? (
          <EmptyState title={t("production.noRecipes")} />
        ) : (
          <Table label={t("production.planTitle")}>
            <thead>
              <tr>
                <Th>{t("production.recipe")}</Th>
                <Th>{t("production.requested")}</Th>
                <Th>{t("production.usable")}</Th>
                <Th>{t("production.alreadyPlanned")}</Th>
                <Th>{t("production.need")}</Th>
                <Th>{t("production.suggested")}</Th>
                <Th>{t("production.byForecast")}</Th>
                {manage ? <Th>{t("common.actions")}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {plan.rows.map((r) => (
                <tr key={r.recipe.id} data-testid={`plan-${r.recipe.code}`}>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{r.recipe.code}</span>{" "}
                    <bdi>{(locale === "ar" && r.recipe.nameAr) || r.recipe.name}</bdi>
                    <span className="ltr-value text-muted block font-mono text-xs">
                      {r.product.sku}
                    </span>
                  </Td>
                  <Td className="tabular-nums">{q(r.demand, r.product.unit)}</Td>
                  <Td className="tabular-nums">{q(r.usable, r.product.unit)}</Td>
                  <Td className="tabular-nums">{q(r.planned, r.product.unit)}</Td>
                  <Td className="font-medium tabular-nums">{q(r.need, r.product.unit)}</Td>
                  <Td className="tabular-nums">
                    {r.batches.gt(0) ? (
                      <>
                        {q(r.suggestedQuantity, r.yieldUnit)}
                        <span className="text-muted block text-xs">
                          {t("production.batches", { count: Number(r.batches.toFixed()) })}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    {r.forecast.status === "OK" ? (
                      <>
                        {r.forecast.batches.gt(0) ? (
                          <>
                            <span className="font-medium">
                              {q(r.forecast.suggestedQuantity, r.yieldUnit)}
                            </span>
                            <span className="text-muted block text-xs">
                              {t("production.batches", {
                                count: Number(r.forecast.batches.toFixed()),
                              })}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted">{t("production.forecastEnough")}</span>
                        )}
                        <span className="text-muted block text-xs">
                          {t("production.forecastDetail", {
                            demand: fmt(r.forecast.demand.toDecimalPlaces(3)),
                            safety: fmt(r.forecast.safety.toDecimalPlaces(3)),
                            stock: fmt(r.forecast.stock.toDecimalPlaces(3)),
                            unit: r.product.unit,
                          })}
                        </span>
                        <span className="text-muted block text-xs">
                          {t(`forecast.methods.${r.forecast.method}`)}
                        </span>
                      </>
                    ) : (
                      <Badge tone="muted">
                        {t("forecast.shortHistory", { days: r.forecast.historyDays })}
                      </Badge>
                    )}
                  </Td>
                  {manage ? (
                    <Td>
                      {r.batches.gt(0) ? (
                        <Link
                          href={`/o/${orgSlug}/production/new?recipeId=${r.recipe.id}&warehouseId=${plan.warehouse.id}&quantity=${r.suggestedQuantity.toFixed()}`}
                          className="text-primary block text-sm hover:underline"
                        >
                          {t("production.planIt")}
                        </Link>
                      ) : null}
                      {r.forecast.status === "OK" && r.forecast.batches.gt(0) ? (
                        <Link
                          href={`/o/${orgSlug}/production/new?recipeId=${r.recipe.id}&warehouseId=${plan.warehouse.id}&quantity=${r.forecast.suggestedQuantity.toFixed()}`}
                          className="text-primary block text-sm hover:underline"
                        >
                          {t("production.planForecast")}
                        </Link>
                      ) : null}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
