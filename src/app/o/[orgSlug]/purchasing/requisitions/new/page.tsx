import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { RequisitionForm } from "@/components/procurement/forms";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { purchasingWarehouseOptions } from "@/modules/procurement/orders";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createRequisitionAction } from "../../actions";

export default async function NewRequisitionPage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/requisitions/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "purchasing.request")) notFound();
  const [t, warehouses] = await Promise.all([
    getTranslations(),
    purchasingWarehouseOptions(ctx, "purchasing.request"),
  ]);
  return (
    <>
      <PageHeader title={t("requisitions.newTitle")} description={t("requisitions.hint")} />
      {warehouses.length === 0 ? (
        <EmptyState title={t("warehouses.empty")} />
      ) : (
        <Card>
          <RequisitionForm
            action={createRequisitionAction.bind(null, orgSlug)}
            warehouses={warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
          />
        </Card>
      )}
    </>
  );
}
