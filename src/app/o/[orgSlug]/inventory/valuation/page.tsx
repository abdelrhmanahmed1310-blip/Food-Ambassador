import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Pagination } from "@/components/ui/pagination";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { warehouseOptions } from "@/modules/inventory/queries";
import { canViewValuation, listValuations } from "@/modules/inventory/valuation-queries";
import { pageSchema } from "@/modules/shared/schemas";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter, productName, quantityFormatter } from "@/server/inventory-view";

export default async function ValuationPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/inventory/valuation">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canViewValuation(ctx)) notFound();
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const filters = {
    q: str(sp.q),
    warehouseId:
      str(sp.warehouseId) && isUuid(sp.warehouseId) ? (sp.warehouseId as string) : undefined,
    costMissing: sp.costMissing === "1" ? "1" : undefined,
  };
  const page = pageSchema.parse(sp.page);
  const [t, locale, fmt, money, result, warehouses] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
    listValuations(ctx, {
      q: filters.q,
      warehouseId: filters.warehouseId,
      costMissing: filters.costMissing === "1",
      page,
    }),
    warehouseOptions(ctx, "inventory.valuation.view"),
  ]);
  const base = `/o/${orgSlug}/inventory/valuation`;
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v) as Array<[string, string]>,
  ).toString();
  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader
        title={t("inventory.valuationTitle")}
        description={t("inventory.valuationHint", { currency: ctx.baseCurrency })}
        actions={
          <LinkButton href={`${base}/export${query ? `?${query}` : ""}`} variant="secondary">
            {t("common.export")}
          </LinkButton>
        }
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <Card>
          <p className="text-muted text-sm">{t("inventory.totalValue")}</p>
          <p
            className="ltr-value mt-1 text-2xl font-semibold tabular-nums"
            data-testid="total-value"
          >
            {money.money(result.totalValue)}
          </p>
        </Card>
        {result.costMissingCount > 0 ? (
          <Alert tone="info">
            <Link href={`${base}?costMissing=1`} className="hover:underline">
              {t("inventory.costMissingCount", { count: result.costMissingCount })}
            </Link>
            <span className="mt-1 block text-xs">{t("inventory.costMissingHint")}</span>
          </Alert>
        ) : null}
      </div>
      <form method="get" className="mb-4 grid gap-2 sm:grid-cols-4" role="search">
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
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              name="costMissing"
              value="1"
              defaultChecked={filters.costMissing === "1"}
            />
            {t("inventory.costMissingOnly")}
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            {t("common.apply")}
          </button>
        </div>
      </form>
      {result.total === 0 ? (
        <EmptyState title={filtered ? t("common.noResults") : t("inventory.emptyValuation")} />
      ) : (
        <Table label={t("inventory.valuationTitle")}>
          <thead>
            <tr>
              <Th>{t("inventory.product")}</Th>
              <Th>{t("common.warehouse")}</Th>
              <Th>{t("inventory.quantity")}</Th>
              <Th>{t("inventory.averageCost")}</Th>
              <Th>{t("inventory.value")}</Th>
              <Th>{t("inventory.actions")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((r) => {
              const canRevalue = hasPermission(ctx.grants, "inventory.valuation.revalue", {
                branchId: r.warehouse.branchId,
                warehouseId: r.warehouse.id,
              });
              return (
                <tr key={r.id}>
                  <Td>
                    {productName(r.product, locale)}
                    <span className="ltr-value text-muted block font-mono text-xs">
                      {r.product.sku}
                    </span>
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{r.warehouse.code}</span>
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value">
                      {fmt(r.quantity)} {r.product.baseUom}
                    </span>
                  </Td>
                  <Td className="tabular-nums">
                    {r.costMissing ? (
                      <Badge tone="warning">{t("inventory.costMissing")}</Badge>
                    ) : r.averageUnitCost ? (
                      <span className="ltr-value">
                        {money.unitCost(r.averageUnitCost)} / {r.product.baseUom}
                      </span>
                    ) : (
                      <span className="text-muted">{t("inventory.noAverage")}</span>
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    <span className="ltr-value">{money.money(r.totalValue)}</span>
                  </Td>
                  <Td>
                    {canRevalue ? (
                      <Link
                        href={`${base}/${r.warehouse.id}/${r.product.id}`}
                        className="text-primary text-sm hover:underline"
                      >
                        {t("inventory.revalue")}
                      </Link>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
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
