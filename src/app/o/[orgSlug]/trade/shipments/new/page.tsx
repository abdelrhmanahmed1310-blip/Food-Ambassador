import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ShipmentForm } from "@/components/trade/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { countryOptions } from "@/lib/countries";
import { canManageShipments, shipmentFormOptions } from "@/modules/trade/shipments";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createShipmentAction } from "../actions";

export default async function NewImportShipmentPage({
  params,
}: PageProps<"/o/[orgSlug]/trade/shipments/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canManageShipments(ctx)) notFound();
  const [t, locale, options] = await Promise.all([
    getTranslations(),
    getLocale(),
    shipmentFormOptions(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("trade.new")} description={t("trade.newHint")} />
      <Card>
        <ShipmentForm
          action={createShipmentAction.bind(null, orgSlug)}
          submitLabel={t("trade.create")}
          countries={countryOptions(locale)}
          suppliers={options.suppliers.map((s) => ({
            value: s.id,
            label: `${s.code} — ${s.name}`,
          }))}
          warehouses={options.warehouses.map((w) => ({
            value: w.id,
            label: `${w.code} — ${w.name}`,
          }))}
        />
      </Card>
    </>
  );
}
