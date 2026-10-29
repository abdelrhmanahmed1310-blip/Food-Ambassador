import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ReceiptForm } from "@/components/procurement/forms";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getOrder, purchasingWarehouseOptions } from "@/modules/procurement/orders";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName } from "@/server/inventory-view";
import { postReceiptAction } from "../../../actions";

export default async function ReceivePage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/orders/[orderId]/receive">) {
  const { orgSlug, orderId } = await params;
  if (!isUuid(orderId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const order = await notFoundOnAppError(getOrder(ctx, orderId));
  if (!order.can.receive) notFound();
  const [t, locale, warehouses] = await Promise.all([
    getTranslations(),
    getLocale(),
    purchasingWarehouseOptions(ctx, "purchasing.receive"),
  ]);
  const locations = warehouses.find((w) => w.id === order.warehouseId)?.locations ?? [];
  const open = order.lines.filter((l) => l.openQuantityBase.gt(0));
  return (
    <>
      <PageHeader
        title={`${t("purchasing.receiveTitle")} — ${order.number}`}
        description={t("purchasing.receiveHint")}
      />
      {open.length === 0 ? (
        <EmptyState title={t("purchasing.nothingOpen")} />
      ) : (
        <Card>
          <ReceiptForm
            action={postReceiptAction.bind(null, orgSlug, order.id)}
            locations={locations.map((l) => ({ value: l.id, label: `${l.code} — ${l.name}` }))}
            lines={open.map((l) => ({
              id: l.id,
              label: productName(l.product, locale),
              sku: l.product.sku,
              unit: l.uom.code,
              openQuantity: l.openQuantityInUnit.toFixed(),
              unitPrice: l.unitPrice.toFixed(),
              lotTracking: l.product.lotTracking,
              needsTemperature: l.product.storageRequirement !== "AMBIENT",
            }))}
          />
        </Card>
      )}
    </>
  );
}
