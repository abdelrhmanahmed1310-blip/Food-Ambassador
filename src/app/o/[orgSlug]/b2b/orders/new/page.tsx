import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { SalesOrderForm } from "@/components/b2b/forms";
import { Card, PageHeader } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listCustomers } from "@/modules/b2b/service";
import { warehouseOptions } from "@/modules/inventory/queries";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createSalesOrderAction } from "../../actions";

export default async function NewSalesOrderPage({
  params,
}: PageProps<"/o/[orgSlug]/b2b/orders/new">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "b2b.manage")) notFound();
  const [t, locale, customers, warehouses] = await Promise.all([
    getTranslations(),
    getLocale(),
    listCustomers(ctx),
    warehouseOptions(ctx),
  ]);
  return (
    <>
      <PageHeader title={t("b2b.newOrder")} />
      <Card>
        <SalesOrderForm
          action={createSalesOrderAction.bind(null, orgSlug)}
          customers={customers
            .filter((c) => !c.archivedAt)
            .map((c) => ({
              value: c.id,
              label: `${c.code} — ${(locale === "ar" && c.nameAr) || c.name}`,
            }))}
          warehouses={warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
        />
      </Card>
    </>
  );
}
