import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { AdjustmentForm } from "@/components/inventory/forms";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listProductOptions, listUnits } from "@/modules/catalog/service";
import { warehouseOptions } from "@/modules/inventory/queries";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { placeOptions, productOptions, unitOptions } from "@/server/inventory-view";
import { adjustmentAction } from "../../actions";

export default async function NewAdjustmentPage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/adjustments/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.adjust")) notFound();
  const [t, locale, warehouses, products, units] = await Promise.all([
    getTranslations(),
    getLocale(),
    warehouseOptions(ctx, "inventory.adjust"),
    listProductOptions(ctx),
    listUnits(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("inventory.newAdjustmentTitle")} />
      {warehouses.length === 0 || products.length === 0 ? (
        <EmptyState
          title={warehouses.length === 0 ? t("warehouses.empty") : t("catalog.emptyProducts")}
        />
      ) : (
        <Card>
          <AdjustmentForm
            action={adjustmentAction.bind(null, orgSlug)}
            options={{
              places: placeOptions(warehouses),
              products: productOptions(products, locale),
              units: unitOptions(units, locale),
              currency: ctx.baseCurrency,
            }}
          />
        </Card>
      )}
    </>
  );
}
