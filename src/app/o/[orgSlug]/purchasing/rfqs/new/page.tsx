import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { RfqForm } from "@/components/procurement/rfq-forms";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { purchasingWarehouseOptions } from "@/modules/procurement/orders";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createRfqAction } from "../actions";

export default async function NewRfqPage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/rfqs/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "purchasing.manage")) notFound();
  const [t, warehouses] = await Promise.all([
    getTranslations(),
    purchasingWarehouseOptions(ctx, "purchasing.manage"),
  ]);
  return (
    <>
      <PageHeader title={t("rfqs.newTitle")} description={t("rfqs.hint")} />
      {warehouses.length === 0 ? (
        <EmptyState title={t("warehouses.empty")} />
      ) : (
        <Card>
          <RfqForm
            action={createRfqAction.bind(null, orgSlug)}
            warehouses={warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
          />
        </Card>
      )}
    </>
  );
}
