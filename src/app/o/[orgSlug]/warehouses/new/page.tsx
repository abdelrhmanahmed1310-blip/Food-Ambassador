import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { WarehouseForm } from "@/components/sites/warehouse-forms";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listBranchOptions } from "@/modules/sites/branches";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { warehouseOptions } from "@/server/labels";
import { createWarehouseAction } from "../actions";

export default async function NewWarehousePage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/warehouses/new">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "warehouses.manage")) notFound();
  const [t, branches, { types }] = await Promise.all([
    getTranslations(),
    listBranchOptions(ctx, "warehouses.manage"),
    warehouseOptions(),
  ]);
  const preselected =
    typeof sp.branchId === "string" && isUuid(sp.branchId) ? sp.branchId : undefined;
  return (
    <>
      <PageHeader title={t("warehouses.newTitle")} />
      {branches.length === 0 ? (
        <EmptyState title={t("warehouses.noBranches")} />
      ) : (
        <Card>
          <WarehouseForm
            action={createWarehouseAction.bind(null, orgSlug)}
            idempotent
            labels={{
              submit: t("common.create"),
              pending: t("common.saving"),
              code: t("warehouses.code"),
              name: t("warehouses.name"),
              type: t("warehouses.type"),
              branch: t("warehouses.branch"),
            }}
            types={types}
            branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
            defaults={{ branchId: preselected }}
          />
        </Card>
      )}
    </>
  );
}
