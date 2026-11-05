import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import type { Decimal } from "@/lib/decimal";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { warehouseForecast } from "@/modules/forecasting/demand";
import { purchasingWarehouseOptions } from "@/modules/procurement/orders";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { productName, quantityFormatter } from "@/server/inventory-view";

/** Weekly demand as small bars, with the figures for screen readers. */
function Weeks({ weeks, label }: { weeks: Decimal[]; label: string }) {
  const max = weeks.reduce((a, w) => (w.gt(a) ? w.toNumber() : a), 0);
  return (
    <span role="img" aria-label={label} className="flex h-6 items-end gap-0.5" dir="ltr">
      {weeks.map((w, i) => (
        <span
          key={i}
          className="bg-primary w-2 rounded-sm"
          style={{ height: `${max > 0 ? Math.max(2, (w.toNumber() / max) * 24) : 2}px` }}
        />
      ))}
    </span>
  );
}

export default async function ForecastPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/purchasing/forecast">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "purchasing.view")) notFound();
  const [t, locale, fmt, warehouses] = await Promise.all([
    getTranslations(),
    getLocale(),
    quantityFormatter(),
    purchasingWarehouseOptions(ctx, "purchasing.view"),
  ]);
  const requested =
    typeof sp.warehouseId === "string" && isUuid(sp.warehouseId) ? sp.warehouseId : undefined;
  const warehouseId = warehouses.find((w) => w.id === requested)?.id ?? warehouses[0]?.id;
  const data = warehouseId ? await warehouseForecast(ctx, warehouseId) : null;
  const pct = (v: Decimal | null) =>
    v === null ? "—" : `${v.times(100).toDecimalPlaces(0).toFixed()}%`;

  return (
    <>
      <PageHeader title={t("forecast.title")} description={t("forecast.hint")} />
      {!data ? (
        <EmptyState title={t("warehouses.empty")} />
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <form method="get" className="flex gap-2">
              <label htmlFor="warehouseId" className="sr-only">
                {t("common.warehouse")}
              </label>
              <select
                id="warehouseId"
                name="warehouseId"
                defaultValue={data.warehouse.id}
                className={`${inputClass} sm:w-72`}
              >
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
            <a
              href={`/o/${orgSlug}/purchasing/forecast/export?warehouseId=${data.warehouse.id}`}
              className={buttonClass("secondary")}
            >
              {t("forecast.export")}
            </a>
            <Link
              href={`/o/${orgSlug}/purchasing/reorder?warehouseId=${data.warehouse.id}`}
              className={buttonClass("secondary")}
            >
              {t("forecast.toReorder")}
            </Link>
          </div>
          {data.rows.length === 0 ? (
            <EmptyState title={t("forecast.empty")} />
          ) : (
            <>
              <Table label={t("forecast.title")}>
                <thead>
                  <tr>
                    <Th>{t("forecast.product")}</Th>
                    <Th>{t("forecast.weeks")}</Th>
                    <Th>{t("forecast.average")}</Th>
                    <Th>{t("forecast.method")}</Th>
                    <Th>{t("forecast.error")}</Th>
                    <Th>{t("forecast.bias")}</Th>
                    <Th>{t("forecast.next7")}</Th>
                    <Th>{t("forecast.next28")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const unit = r.product.baseUom.code;
                    const q = (v: Decimal | null) =>
                      v === null ? "—" : `${fmt(v.toDecimalPlaces(3))} ${unit}`;
                    return (
                      <tr key={r.product.id}>
                        <Td>
                          {productName(r.product, locale)}
                          <span className="ltr-value text-muted block font-mono text-xs">
                            {r.product.sku}
                          </span>
                        </Td>
                        <Td>
                          <Weeks
                            weeks={r.weeks}
                            label={t("forecast.weeksLabel", {
                              values: r.weeks.map((w) => fmt(w.toDecimalPlaces(3))).join(", "),
                            })}
                          />
                        </Td>
                        <Td className="tabular-nums">
                          <span className="ltr-value whitespace-nowrap">{q(r.recentDaily)}</span>
                        </Td>
                        {r.result.status === "OK" ? (
                          <>
                            <Td>{t(`forecast.methods.${r.result.method}`)}</Td>
                            <Td className="tabular-nums">
                              {r.result.accuracy.wape === null ? (
                                <span className="text-muted">{t("forecast.noDemand")}</span>
                              ) : (
                                <span className="ltr-value">{pct(r.result.accuracy.wape)}</span>
                              )}
                            </Td>
                            <Td className="tabular-nums">
                              <span className="ltr-value">{pct(r.result.accuracy.bias)}</span>
                            </Td>
                          </>
                        ) : (
                          <>
                            <Td>
                              <Badge tone="warning">
                                {t("forecast.shortHistory", { days: r.historyDays })}
                              </Badge>
                            </Td>
                            <Td>—</Td>
                            <Td>—</Td>
                          </>
                        )}
                        <Td className="tabular-nums">
                          <span className="ltr-value font-medium whitespace-nowrap">
                            {q(r.next7)}
                          </span>
                        </Td>
                        <Td className="tabular-nums">
                          <span className="ltr-value whitespace-nowrap">{q(r.next28)}</span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <p className="text-muted text-sm">{t("forecast.explain")}</p>
            </>
          )}
        </div>
      )}
    </>
  );
}
