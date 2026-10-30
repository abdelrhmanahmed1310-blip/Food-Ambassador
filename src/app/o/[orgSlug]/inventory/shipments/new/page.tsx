import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { NewShipmentForm } from "@/components/inventory/shipment-forms";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { warehouseOptions } from "@/modules/inventory/queries";
import { destinationOptions } from "@/modules/inventory/shipments";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createShipmentAction } from "../../actions";

export default async function NewShipmentPage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/shipments/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.transfer")) notFound();
  const [t, sources, destinations] = await Promise.all([
    getTranslations(),
    warehouseOptions(ctx, "inventory.transfer"),
    destinationOptions(ctx),
  ]);
  const option = (w: { id: string; code: string; name: string }) => ({
    value: w.id,
    label: `${w.code} — ${w.name}`,
  });
  return (
    <>
      <PageHeader title={t("shipments.newTitle")} description={t("shipments.newHint")} />
      {sources.length === 0 ? (
        <EmptyState title={t("shipments.noSources")} />
      ) : (
        <Card>
          <NewShipmentForm
            action={createShipmentAction.bind(null, orgSlug)}
            sources={sources.map(option)}
            destinations={destinations.map(option)}
          />
        </Card>
      )}
    </>
  );
}
