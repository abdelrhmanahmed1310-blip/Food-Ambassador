import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { OpeningBalanceForm } from "@/components/inventory/forms";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listProductOptions, listUnits } from "@/modules/catalog/service";
import { warehouseOptions } from "@/modules/inventory/queries";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { placeOptions, productOptions, unitOptions } from "@/server/inventory-view";
import { openingBalanceAction } from "../../actions";

export default async function NewOpeningBalancePage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/inventory/opening/new">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
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
      <PageHeader
        title={t("inventory.newOpeningTitle")}
        description={t("inventory.newOpeningHint")}
        actions={
          <LinkButton href={`/o/${orgSlug}/catalog/import`} variant="secondary">
            {t("nav.import")}
          </LinkButton>
        }
      />
      {warehouses.length === 0 || products.length === 0 ? (
        <EmptyState
          title={warehouses.length === 0 ? t("warehouses.empty") : t("catalog.emptyProducts")}
        />
      ) : (
        <Card>
          <OpeningBalanceForm
            action={openingBalanceAction.bind(null, orgSlug)}
            options={{
              places: placeOptions(warehouses),
              products: productOptions(products, locale),
              units: unitOptions(units, locale),
              currency: ctx.baseCurrency,
            }}
            defaults={{ productId: typeof sp.productId === "string" ? sp.productId : "" }}
          />
        </Card>
      )}
    </>
  );
}
