import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SupplierForm } from "@/components/procurement/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createSupplierAction } from "../actions";

export default async function NewSupplierPage({ params }: PageProps<"/o/[orgSlug]/suppliers/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "suppliers.manage")) notFound();
  const t = await getTranslations();
  return (
    <>
      <PageHeader title={t("suppliers.newTitle")} />
      <Card>
        <SupplierForm
          action={createSupplierAction.bind(null, orgSlug)}
          submitLabel={t("common.create")}
          idempotent
        />
      </Card>
    </>
  );
}
