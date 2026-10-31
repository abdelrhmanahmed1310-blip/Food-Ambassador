import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { warehouseOptions } from "@/modules/inventory/queries";
import { productionPlan } from "@/modules/production/service";
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
  const [t, locale, fmt, plan] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    chosen ? productionPlan(ctx, chosen) : Promise.resolve(null),
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
          <button
            type="submit"
            className="border-border hover:bg-surface-muted rounded-md border px-3 py-2 text-sm"
          >
            {t("common.apply")}
          </button>
        </form>
        <Alert tone="info">{t("production.planNote")}</Alert>
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
                  {manage ? (
                    <Td>
                      {r.batches.gt(0) ? (
                        <Link
                          href={`/o/${orgSlug}/production/new?recipeId=${r.recipe.id}&warehouseId=${plan.warehouse.id}&quantity=${r.suggestedQuantity.toFixed()}`}
                          className="text-primary text-sm hover:underline"
                        >
                          {t("production.planIt")}
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
