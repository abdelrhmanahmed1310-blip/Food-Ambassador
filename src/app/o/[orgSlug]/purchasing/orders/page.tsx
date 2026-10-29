import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { OrderStatusBadge } from "@/components/procurement/badges";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { listOrders, purchasingWarehouseOptions } from "@/modules/procurement/orders";
import { PO_STATUSES, type PoStatus } from "@/modules/procurement/rules";
import { supplierOptions } from "@/modules/procurement/suppliers";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";

export default async function OrdersPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/orders">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "purchasing.view")) notFound();
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const id = (v: unknown) => (isUuid(str(v)) ? (v as string) : undefined);
  const filters = {
    q: str(sp.q),
    status: (PO_STATUSES as readonly string[]).includes(str(sp.status) ?? "")
      ? (sp.status as PoStatus)
      : undefined,
    supplierId: id(sp.supplierId),
    warehouseId: id(sp.warehouseId),
  };
  const page = pageSchema.parse(sp.page);
  const canSeeSuppliers = hasPermission(ctx.grants, "suppliers.view");
  const [t, locale, format, money, result, suppliers, warehouses] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency),
    listOrders(ctx, { ...filters, page }),
    canSeeSuppliers ? supplierOptions(ctx) : Promise.resolve([]),
    purchasingWarehouseOptions(ctx, "purchasing.view"),
  ]);
  const base = `/o/${orgSlug}/purchasing/orders`;
  return (
    <>
      <PageHeader
        title={t("purchasing.ordersTitle")}
        actions={
          holdsAnyGrant(ctx.grants, "purchasing.manage") ? (
            <LinkButton href={`${base}/new`}>{t("purchasing.newOrder")}</LinkButton>
          ) : undefined
        }
      />
      <form method="get" className="mb-4 grid gap-2 sm:grid-cols-5" role="search">
        <label className="sr-only" htmlFor="q">
          {t("common.search")}
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={filters.q}
          placeholder={t("common.searchPlaceholder")}
          className={inputClass}
        />
        <label className="sr-only" htmlFor="status">
          {t("common.status")}
        </label>
        <select
          id="status"
          name="status"
          defaultValue={filters.status ?? ""}
          className={inputClass}
        >
          <option value="">{t("common.allStatuses")}</option>
          {PO_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`purchasing.statuses.${s}`)}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="supplierId">
          {t("purchasing.supplier")}
        </label>
        <select
          id="supplierId"
          name="supplierId"
          defaultValue={filters.supplierId ?? ""}
          className={inputClass}
        >
          <option value="">{t("purchasing.allSuppliers")}</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} — {(locale === "ar" && s.nameAr) || s.name}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="warehouseId">
          {t("common.warehouse")}
        </label>
        <select
          id="warehouseId"
          name="warehouseId"
          defaultValue={filters.warehouseId ?? ""}
          className={inputClass}
        >
          <option value="">{t("common.allWarehouses")}</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} — {w.name}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonClass("secondary")}>
          {t("common.apply")}
        </button>
      </form>
      {result.total === 0 ? (
        <EmptyState
          title={
            Object.values(filters).some(Boolean) ? t("common.noResults") : t("purchasing.noOrders")
          }
        />
      ) : (
        <Table label={t("purchasing.ordersTitle")}>
          <thead>
            <tr>
              <Th>{t("purchasing.number")}</Th>
              <Th>{t("purchasing.supplier")}</Th>
              <Th>{t("purchasing.deliverTo")}</Th>
              <Th>{t("purchasing.expectedOn")}</Th>
              <Th>{t("common.status")}</Th>
              <Th>{t("purchasing.total")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((o) => (
              <tr key={o.id}>
                <Td>
                  <Link
                    href={`${base}/${o.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {o.number}
                  </Link>
                  <span className="text-muted block text-xs">
                    {format.dateTime(o.createdAt, { dateStyle: "medium", timeZone: ctx.timeZone })}
                  </span>
                </Td>
                <Td>{(locale === "ar" && o.supplier.nameAr) || o.supplier.name}</Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{o.warehouse.code}</span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">
                    {o.expectedOn?.toISOString().slice(0, 10) ?? "—"}
                  </span>
                </Td>
                <Td>
                  <OrderStatusBadge status={o.status} />
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value whitespace-nowrap">{money.money(o.totalAmount)}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Pagination
        basePath={base}
        params={filters}
        page={result.page}
        pageCount={result.pageCount}
        total={result.total}
      />
    </>
  );
}
