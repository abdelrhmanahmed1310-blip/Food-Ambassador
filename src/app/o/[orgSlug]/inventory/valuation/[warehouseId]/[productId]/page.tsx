import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { RevalueForm } from "@/components/inventory/forms";
import { Alert, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { getValuation } from "@/modules/inventory/valuation-queries";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter, productName, quantityFormatter } from "@/server/inventory-view";
import { revalueAction } from "../../../actions";

export default async function RevaluePage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/valuation/[warehouseId]/[productId]">) {
  const { orgSlug, warehouseId, productId } = await params;
  if (!isUuid(warehouseId) || !isUuid(productId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const v = await notFoundOnAppError(getValuation(ctx, warehouseId, productId));
  if (
    !hasPermission(ctx.grants, "inventory.valuation.revalue", {
      branchId: v.warehouse.branchId,
      warehouseId: v.warehouse.id,
    })
  )
    notFound();
  const [t, locale, fmt, money] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const name = productName(v.product, locale);
  return (
    <>
      <PageHeader
        title={t("inventory.revalueTitle")}
        description={t("inventory.revalueHint", {
          product: name,
          warehouse: `${v.warehouse.code} — ${v.warehouse.name}`,
        })}
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              { label: t("inventory.product"), value: `${v.product.sku} — ${name}` },
              {
                label: t("common.warehouse"),
                value: `${v.warehouse.code} — ${v.warehouse.name}`,
              },
              {
                label: t("inventory.quantity"),
                value: (
                  <span className="ltr-value tabular-nums">
                    {fmt(v.quantity)} {v.product.baseUom}
                  </span>
                ),
              },
              {
                label: t("inventory.averageCost"),
                value: v.costMissing
                  ? t("inventory.costMissing")
                  : v.averageUnitCost
                    ? `${money.unitCost(v.averageUnitCost)} / ${v.product.baseUom}`
                    : t("inventory.noAverage"),
              },
              {
                label: t("inventory.currentValue"),
                value: <span className="ltr-value tabular-nums">{money.money(v.totalValue)}</span>,
              },
            ]}
          />
        </Card>
        {v.costMissing ? <Alert tone="info">{t("inventory.costMissingHint")}</Alert> : null}
        <Card>
          <RevalueForm
            action={revalueAction.bind(null, orgSlug, v.warehouse.id, v.product.id)}
            unitHint={t("inventory.newUnitCostHint", {
              unit: v.product.baseUom,
              currency: ctx.baseCurrency,
            })}
          />
        </Card>
      </div>
    </>
  );
}
