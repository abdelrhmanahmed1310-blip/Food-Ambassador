import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ExpiryBadge } from "@/components/inventory/stock-badges";
import { Card, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass, inputClass } from "@/components/ui/styles";
import { isUuid } from "@/lib/uuid";
import { holdsAnyGrant } from "@/modules/access/authorize";
import {
  EXPIRY_WARNING_DAYS,
  inventoryDashboard,
  warehouseOptions,
} from "@/modules/inventory/queries";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { productName, quantityFormatter } from "@/server/inventory-view";

export default async function InventoryOverviewPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/inventory">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "inventory.view")) notFound();
  const warehouseId =
    typeof sp.warehouseId === "string" && isUuid(sp.warehouseId) ? sp.warehouseId : undefined;
  const [t, locale, format, fmt, data, warehouses] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    inventoryDashboard(ctx, { warehouseId }),
    warehouseOptions(ctx),
  ]);
  const base = `/o/${orgSlug}/inventory`;
  const q = warehouseId ? `&warehouseId=${warehouseId}` : "";
  const stats = [
    {
      label: t("inventory.productsInStock"),
      value: data.productsInStock,
      href: `${base}/stock?status=AVAILABLE${q}`,
    },
    {
      label: t("inventory.quarantined"),
      value: data.quarantinedBuckets,
      href: `${base}/stock?status=QUARANTINE${q}`,
    },
    {
      label: t("inventory.onHold"),
      value: data.onHoldBuckets,
      href: `${base}/stock?status=ON_HOLD${q}`,
    },
    {
      label: t("inventory.rejected"),
      value: data.rejectedBuckets,
      href: `${base}/stock?status=REJECTED${q}`,
    },
    { label: t("inventory.openCounts"), value: data.openCounts, href: `${base}/counts` },
  ];
  const expiryTable = (rows: typeof data.expired, empty: string) =>
    rows.length === 0 ? (
      <p className="text-muted text-sm">{empty}</p>
    ) : (
      <Table label={empty}>
        <thead>
          <tr>
            <Th>{t("inventory.product")}</Th>
            <Th>{t("inventory.lot")}</Th>
            <Th>{t("common.warehouse")}</Th>
            <Th>{t("inventory.expires")}</Th>
            <Th>{t("inventory.onHand")}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <Td>
                <Link href={`${base}/stock/${r.id}`} className="text-primary hover:underline">
                  {productName(r.product, locale)}
                </Link>
              </Td>
              <Td>
                <span className="ltr-value font-mono text-xs">{r.lot?.lotCode}</span>
              </Td>
              <Td>{r.warehouse.code}</Td>
              <Td>
                <ExpiryBadge state={r.expiry} date={r.lot?.expiresOn ?? null} />
              </Td>
              <Td className="tabular-nums">
                <span className="ltr-value">
                  {fmt(r.onHand)} {r.product.baseUom}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    );

  return (
    <>
      <PageHeader
        title={t("inventory.overviewTitle")}
        description={t("inventory.today", { date: data.today })}
        actions={
          <>
            {holdsAnyGrant(ctx.grants, "inventory.adjust") ? (
              <>
                <LinkButton href={`${base}/opening/new`} variant="secondary">
                  {t("inventory.openingBalance")}
                </LinkButton>
                <LinkButton href={`${base}/adjustments/new`} variant="secondary">
                  {t("inventory.adjustment")}
                </LinkButton>
              </>
            ) : null}
            <LinkButton href={`${base}/stock`}>{t("nav.stock")}</LinkButton>
          </>
        }
      />
      <form method="get" className="mb-4 flex gap-2">
        <label htmlFor="warehouseId" className="sr-only">
          {t("common.warehouse")}
        </label>
        <select
          id="warehouseId"
          name="warehouseId"
          defaultValue={warehouseId ?? ""}
          className={`${inputClass} sm:w-72`}
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
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {stats.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="border-border bg-surface hover:bg-surface-muted rounded-lg border p-4"
          >
            <p className="text-muted text-xs">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</p>
          </Link>
        ))}
      </div>
      <div className="mt-6 space-y-6">
        <Card title={t("inventory.expired")}>
          {expiryTable(data.expired, t("inventory.noneExpired"))}
        </Card>
        <Card title={t("inventory.expiring", { days: EXPIRY_WARNING_DAYS })}>
          {expiryTable(data.expiring, t("inventory.noneExpiring"))}
        </Card>
        <Card title={t("inventory.recentDocuments")}>
          {data.recentDocuments.length === 0 ? (
            <p className="text-muted text-sm">{t("inventory.noDocuments")}</p>
          ) : (
            <ul className="divide-border divide-y">
              {data.recentDocuments.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <Link
                    href={`${base}/documents/${d.id}`}
                    className="ltr-value text-primary font-mono hover:underline"
                  >
                    {d.number}
                  </Link>
                  <span>{t(`inventory.documentTypes.${d.type}`)}</span>
                  <span className="text-muted">
                    {format.dateTime(d.postedAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: ctx.timeZone,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
