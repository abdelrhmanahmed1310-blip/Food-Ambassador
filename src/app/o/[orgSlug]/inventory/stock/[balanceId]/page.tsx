import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { StatusChangeForm, TransferForm, WriteOffForm } from "@/components/inventory/forms";
import { ExpiryBadge, StatusBadge } from "@/components/inventory/stock-badges";
import { Alert, Card, DescriptionList, PageHeader } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { productEntryUnits } from "@/modules/catalog/service";
import { fefoSuggestions, getBalance, warehouseOptions } from "@/modules/inventory/queries";
import { STATUS_TRANSITIONS, STOCK_STATUSES, type StockStatus } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { placeOptions, productName, quantityFormatter } from "@/server/inventory-view";
import { statusChangeAction, transferAction, writeOffAction } from "../../actions";

export default async function StockLinePage({
  params,
}: PageProps<"/o/[orgSlug]/inventory/stock/[balanceId]">) {
  const { orgSlug, balanceId } = await params;
  if (!isUuid(balanceId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const row = await notFoundOnAppError(getBalance(ctx, balanceId));
  const [t, locale, fmt, units] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    productEntryUnits(ctx, row.product.id),
  ]);
  const target = { branchId: row.warehouse.branchId, warehouseId: row.warehouse.id };
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(ctx.grants, p, target);
  const unitOpts = units.map((u) => ({ value: u.id, label: u.code }));
  const bucket = {
    warehouseId: row.warehouse.id,
    locationId: row.location?.id ?? "",
    productId: row.product.id,
    lotId: row.lot?.id ?? "",
  };
  const usable =
    row.stockStatus === "AVAILABLE" && row.expiry !== "EXPIRED" && !row.lot?.recallHold;

  // FEFO: is there a usable lot of this product here that expires earlier?
  let earlier: { lot: string; date: string } | null = null;
  if (usable && row.lot) {
    const [first] = await fefoSuggestions(ctx, row.warehouse.id, row.product.id);
    if (
      first?.lot &&
      first.lot.id !== row.lot.id &&
      first.lot.expiresOn &&
      row.lot.expiresOn &&
      first.lot.expiresOn < row.lot.expiresOn
    ) {
      earlier = { lot: first.lot.lotCode, date: first.lot.expiresOn };
    }
  }
  const statusTargets = STOCK_STATUSES.filter((to) => {
    const permission = STATUS_TRANSITIONS[`${row.stockStatus}>${to}`];
    return (
      permission &&
      can(permission) &&
      !(to === "AVAILABLE" && (row.expiry === "EXPIRED" || row.lot?.recallHold))
    );
  }) as StockStatus[];
  let destinations: Array<{ value: string; label: string }> = [];
  if (usable && can("inventory.transfer")) {
    const here = `${row.warehouse.id}:${row.location?.id ?? ""}`;
    destinations = placeOptions(await warehouseOptions(ctx, "inventory.transfer")).filter(
      (o) => o.value !== here,
    );
  }
  // In-transit stock is moved only by its shipment (ADR-026).
  const canWriteOff = can("inventory.adjust") && row.stockStatus !== "IN_TRANSIT";

  return (
    <>
      <PageHeader
        title={productName(row.product, locale)}
        description={t("inventory.bucketTitle")}
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("catalog.sku"),
                value: <span className="ltr-value font-mono">{row.product.sku}</span>,
              },
              {
                label: t("common.warehouse"),
                value: `${row.warehouse.code} — ${row.warehouse.name}`,
              },
              { label: t("common.location"), value: row.location?.code ?? "—" },
              {
                label: t("inventory.lot"),
                value: <span className="ltr-value font-mono">{row.lot?.lotCode ?? "—"}</span>,
              },
              {
                label: t("inventory.expires"),
                value: <ExpiryBadge state={row.expiry} date={row.lot?.expiresOn ?? null} />,
              },
              { label: t("inventory.status"), value: <StatusBadge status={row.stockStatus} /> },
              {
                label: t("inventory.onHand"),
                value: (
                  <span className="ltr-value tabular-nums">
                    {fmt(row.onHand)} {row.product.baseUom}
                  </span>
                ),
              },
              {
                label: t("inventory.available"),
                value: (
                  <span className="ltr-value tabular-nums">
                    {fmt(row.available)} {row.product.baseUom}
                  </span>
                ),
              },
            ]}
          />
          <p className="mt-4 text-sm">
            <Link
              className="text-primary hover:underline"
              href={`/o/${orgSlug}/inventory/movements?productId=${row.product.id}&warehouseId=${row.warehouse.id}${row.lot ? `&lotId=${row.lot.id}` : ""}`}
            >
              {t("nav.movements")}
            </Link>
          </p>
        </Card>
        {row.expiry === "EXPIRED" ? (
          <Alert tone="error">{t("inventory.expiredWarning")}</Alert>
        ) : null}
        {earlier ? (
          <Alert tone="info">
            {t("inventory.fefoWarning", { lot: earlier.lot, date: earlier.date })}
          </Alert>
        ) : null}
        {destinations.length > 0 ? (
          <Card title={t("inventory.transfer")}>
            <TransferForm
              action={transferAction.bind(null, orgSlug)}
              bucket={bucket}
              units={unitOpts}
              destinations={destinations}
            />
          </Card>
        ) : null}
        {statusTargets.length > 0 ? (
          <Card title={t("inventory.changeStatus")}>
            <StatusChangeForm
              action={statusChangeAction.bind(null, orgSlug)}
              bucket={{ ...bucket, fromStatus: row.stockStatus }}
              units={unitOpts}
              targets={statusTargets}
            />
          </Card>
        ) : null}
        {canWriteOff ? (
          <Card title={t("inventory.writeOff")}>
            <WriteOffForm
              action={writeOffAction.bind(null, orgSlug)}
              bucket={{ ...bucket, stockStatus: row.stockStatus }}
              units={unitOpts}
            />
          </Card>
        ) : null}
        {destinations.length === 0 && statusTargets.length === 0 && !canWriteOff ? (
          <Alert tone="info">{t("inventory.noAccessToPost")}</Alert>
        ) : null}
      </div>
    </>
  );
}
