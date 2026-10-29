import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { OrderHeaderForm } from "@/components/procurement/forms";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { purchasingWarehouseOptions } from "@/modules/procurement/orders";
import { supplierOptions } from "@/modules/procurement/suppliers";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createOrderAction } from "../../actions";

export default async function NewOrderPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/orders/new">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (
    !holdsAnyGrant(ctx.grants, "purchasing.manage") ||
    !hasPermission(ctx.grants, "suppliers.view")
  )
    notFound();
  const [t, locale, suppliers, warehouses] = await Promise.all([
    getTranslations(),
    getLocale(),
    supplierOptions(ctx),
    purchasingWarehouseOptions(ctx, "purchasing.manage"),
  ]);
  const supplierId =
    typeof sp.supplierId === "string" && isUuid(sp.supplierId) ? sp.supplierId : undefined;
  return (
    <>
      <PageHeader
        title={t("purchasing.newOrderTitle")}
        description={t("purchasing.newOrderHint")}
      />
      {suppliers.length === 0 ? (
        <EmptyState
          title={t("suppliers.empty")}
          hint={t("suppliers.emptyHint")}
          action={
            hasPermission(ctx.grants, "suppliers.manage") ? (
              <LinkButton href={`/o/${orgSlug}/suppliers/new`}>{t("suppliers.new")}</LinkButton>
            ) : undefined
          }
        />
      ) : warehouses.length === 0 ? (
        <EmptyState title={t("warehouses.empty")} />
      ) : (
        <Card>
          <OrderHeaderForm
            action={createOrderAction.bind(null, orgSlug)}
            suppliers={suppliers.map((s) => ({
              value: s.id,
              label: `${s.code} — ${(locale === "ar" && s.nameAr) || s.name}`,
            }))}
            warehouses={warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
            submitLabel={t("common.create")}
            defaults={{
              supplierId,
              warehouseId: warehouses.length === 1 ? warehouses[0].id : undefined,
            }}
            idempotent
          />
        </Card>
      )}
    </>
  );
}
