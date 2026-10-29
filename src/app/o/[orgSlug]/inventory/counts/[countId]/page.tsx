import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { AddCountLineForm, CountSheetForm } from "@/components/inventory/forms";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/primitives";
import { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { listProductOptions } from "@/modules/catalog/service";
import { getCount } from "@/modules/inventory/counts";
import { warehouseOptions } from "@/modules/inventory/queries";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { productName, productOptions, quantityFormatter } from "@/server/inventory-view";
import {
  addCountLineAction,
  cancelCountAction,
  postCountAction,
  recordCountsAction,
  submitCountAction,
} from "../../actions";

export default async function CountPage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/counts/[countId]">) {
  const { orgSlug, countId } = await params;
  if (!isUuid(countId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const count = await notFoundOnAppError(getCount(ctx, countId));
  const [t, locale, fmt] = await Promise.all([getTranslations(), getLocale(), quantityFormatter()]);
  const target = { branchId: count.warehouse.branchId, warehouseId: count.warehouse.id };
  const canCount = hasPermission(ctx.grants, "inventory.count", target);
  const canApprove = hasPermission(ctx.grants, "inventory.count.approve", target);
  const open = count.status === "OPEN";
  const lines = count.lines.map((l) => ({
    id: l.id,
    label: `${l.product.sku} — ${productName(l.product, locale)}`,
    lot: l.lot?.lotCode ?? "—",
    location: l.location?.code ?? "—",
    unit: l.product.baseUom.code,
    system: fmt(l.expectedQuantity),
    counted: l.countedQuantity === null ? null : l.countedQuantity.toString(),
    difference:
      l.countedQuantity === null
        ? null
        : fmt(new Decimal(l.countedQuantity.toString()).minus(l.expectedQuantity.toString())),
  }));
  let addForm = null;
  if (open && canCount) {
    const [products, warehouses] = await Promise.all([
      listProductOptions(ctx),
      warehouseOptions(ctx, "inventory.count"),
    ]);
    const wh = warehouses.find((w) => w.id === count.warehouse.id);
    const locations = count.locationId
      ? []
      : (wh?.locations ?? []).map((l) => ({ value: l.id, label: `${l.code} — ${l.name}` }));
    addForm = (
      <AddCountLineForm
        action={addCountLineAction.bind(null, orgSlug, countId)}
        products={productOptions(products, locale)}
        locations={locations}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={count.number}
        description={`${count.warehouse.code} — ${count.warehouse.name}${count.location ? ` / ${count.location.code}` : ""}`}
        actions={
          <Badge tone={count.status === "POSTED" ? "success" : "neutral"}>
            {t(`inventory.countStatuses.${count.status}`)}
          </Badge>
        }
      />
      <div className="space-y-6">
        <p className="text-muted text-sm">{t("inventory.countHint")}</p>
        {count.status === "POSTED" ? (
          <Alert tone="success">
            {count.document ? (
              <>
                {t("inventory.countPosted", { number: "" })}{" "}
                <Link
                  className="ltr-value font-mono underline"
                  href={`/o/${orgSlug}/inventory/documents/${count.document.id}`}
                >
                  {count.document.number}
                </Link>
              </>
            ) : (
              t("inventory.countPostedNoDiff")
            )}
          </Alert>
        ) : null}
        {lines.length === 0 ? (
          <Alert tone="info">{t("inventory.countEmpty")}</Alert>
        ) : (
          <CountSheetForm
            action={recordCountsAction.bind(null, orgSlug, countId)}
            lines={lines}
            editable={open && canCount}
          />
        )}
        {addForm ? <Card title={t("inventory.addItem")}>{addForm}</Card> : null}
        <div className="flex flex-wrap gap-3">
          {open && canCount && lines.length > 0 ? (
            <ConfirmActionButton
              action={submitCountAction.bind(null, orgSlug, countId)}
              label={t("inventory.submitCount")}
              variant="primary"
            />
          ) : null}
          {count.status === "SUBMITTED" && canApprove ? (
            <ConfirmActionButton
              action={postCountAction.bind(null, orgSlug, countId)}
              label={t("inventory.postCount")}
              variant="primary"
              confirmMessage={t("inventory.confirmPostCount")}
            />
          ) : null}
          {(open || count.status === "SUBMITTED") && canCount ? (
            <ConfirmActionButton
              action={cancelCountAction.bind(null, orgSlug, countId)}
              label={t("inventory.cancelCount")}
              confirmMessage={t("inventory.confirmCancelCount")}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
