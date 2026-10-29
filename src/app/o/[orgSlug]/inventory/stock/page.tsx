import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ExpiryBadge, StatusBadge } from "@/components/inventory/stock-badges";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listBalances, warehouseOptions } from "@/modules/inventory/queries";
import { STOCK_STATUSES, type StockStatus } from "@/modules/inventory/rules";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { productName, quantityFormatter } from "@/server/inventory-view";

export default async function StockPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/inventory/stock">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.view")) notFound();
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const filters = {
    q: str(sp.q),
    warehouseId:
      str(sp.warehouseId) && isUuid(sp.warehouseId) ? (sp.warehouseId as string) : undefined,
    productId: str(sp.productId) && isUuid(sp.productId) ? (sp.productId as string) : undefined,
    status: (STOCK_STATUSES as readonly string[]).includes(str(sp.status) ?? "")
      ? (sp.status as StockStatus)
      : undefined,
    expiry:
      sp.expiry === "expired" || sp.expiry === "expiring"
        ? (sp.expiry as "expired" | "expiring")
        : undefined,
  };
  const page = pageSchema.parse(sp.page);
  const [t, locale, fmt, result, warehouses] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    listBalances(ctx, { ...filters, page }),
    warehouseOptions(ctx),
  ]);
  const base = `/o/${orgSlug}/inventory/stock`;
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v) as Array<[string, string]>,
  ).toString();
  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader
        title={t("inventory.stockTitle")}
        actions={
          <>
            <LinkButton href={`${base}/export${query ? `?${query}` : ""}`} variant="secondary">
              {t("common.export")}
            </LinkButton>
            {holdsAnyGrant(ctx.grants, "inventory.adjust") ? (
              <LinkButton href={`/o/${orgSlug}/inventory/opening/new`}>
                {t("inventory.openingBalance")}
              </LinkButton>
            ) : null}
          </>
        }
      />
      <form method="get" className="mb-4 grid gap-2 sm:grid-cols-5" role="search">
        {filters.productId ? (
          <input type="hidden" name="productId" value={filters.productId} />
        ) : null}
        <label className="sr-only" htmlFor="q">
          {t("common.search")}
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={filters.q}
          placeholder={t("common.searchPlaceholder")}
          className={`${inputClass} sm:col-span-2`}
        />
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
        <label className="sr-only" htmlFor="status">
          {t("inventory.status")}
        </label>
        <select
          id="status"
          name="status"
          defaultValue={filters.status ?? ""}
          className={inputClass}
        >
          <option value="">{t("common.allStatuses")}</option>
          {STOCK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`inventory.statuses.${s}`)}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="expiry">
            {t("inventory.expiryFilter")}
          </label>
          <select
            id="expiry"
            name="expiry"
            defaultValue={filters.expiry ?? ""}
            className={inputClass}
          >
            <option value="">{t("inventory.expiryFilter")}</option>
            <option value="expired">{t("inventory.expiredOnly")}</option>
            <option value="expiring">{t("inventory.expiringOnly")}</option>
          </select>
          <button type="submit" className={buttonClass("secondary")}>
            {t("common.apply")}
          </button>
        </div>
      </form>
      {result.total === 0 ? (
        filtered ? (
          <EmptyState title={t("common.noResults")} />
        ) : (
          <EmptyState title={t("inventory.emptyStock")} hint={t("inventory.emptyStockHint")} />
        )
      ) : (
        <Table label={t("inventory.stockTitle")}>
          <thead>
            <tr>
              <Th>{t("inventory.product")}</Th>
              <Th>{t("common.warehouse")}</Th>
              <Th>{t("inventory.lot")}</Th>
              <Th>{t("inventory.expires")}</Th>
              <Th>{t("inventory.status")}</Th>
              <Th>{t("inventory.onHand")}</Th>
              <Th>{t("inventory.available")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link
                    href={`${base}/${r.id}`}
                    className="text-primary font-medium hover:underline"
                  >
                    {productName(r.product, locale)}
                  </Link>
                  <span className="ltr-value text-muted block font-mono text-xs">
                    {r.product.sku}
                  </span>
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">
                    {r.warehouse.code}
                    {r.location ? ` / ${r.location.code}` : ""}
                  </span>
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{r.lot?.lotCode ?? "—"}</span>
                </Td>
                <Td>
                  <ExpiryBadge state={r.expiry} date={r.lot?.expiresOn ?? null} />
                </Td>
                <Td>
                  <StatusBadge status={r.stockStatus} />
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">
                    {fmt(r.onHand)} {r.product.baseUom}
                  </span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">{fmt(r.available)}</span>
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
