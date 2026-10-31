import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ProductionStatusBadge } from "@/components/production/badges";
import { EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listProductionOrders } from "@/modules/production/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter, quantityFormatter } from "@/server/inventory-view";

const STATUSES = ["PLANNED", "COMPLETED", "REVERSED", "CANCELLED"] as const;

export default async function ProductionPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/production">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "production.view")) notFound();
  const status = STATUSES.find((s) => s === sp.status);
  const [t, locale, format, fmt, money, orders] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    quantityFormatter(),
    moneyFormatter(ctx.baseCurrency),
    listProductionOrders(ctx, { status }),
  ]);
  const base = `/o/${orgSlug}/production`;
  const manage = holdsAnyGrant(ctx.grants, "production.manage");
  return (
    <>
      <PageHeader
        title={t("production.title")}
        description={t("production.hint")}
        actions={
          <span className="flex flex-wrap gap-2">
            <Link href={`${base}/plan`} className={buttonClass("secondary")}>
              {t("production.plan")}
            </Link>
            {manage ? (
              <Link href={`${base}/new`} className={buttonClass("primary")}>
                {t("production.new")}
              </Link>
            ) : null}
          </span>
        }
      />
      <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label={t("common.status")}>
        {[undefined, ...STATUSES].map((s) => (
          <Link
            key={s ?? "all"}
            href={s ? `${base}?status=${s}` : base}
            aria-current={s === status ? "page" : undefined}
            className="border-border hover:bg-surface-muted aria-[current=page]:bg-surface-muted rounded-md border px-3 py-1"
          >
            {s ? t(`production.statuses.${s}`) : t("invoices.all")}
          </Link>
        ))}
      </nav>
      {orders.length === 0 ? (
        <EmptyState title={t("production.none")} />
      ) : (
        <Table label={t("production.title")}>
          <thead>
            <tr>
              <Th>{t("purchasing.number")}</Th>
              <Th>{t("production.recipe")}</Th>
              <Th>{t("production.warehouse")}</Th>
              <Th>{t("production.planned")}</Th>
              <Th>{t("production.produced")}</Th>
              <Th>{t("production.cost")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
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
                <Td>
                  <span className="ltr-value font-mono text-xs">{o.recipe.code}</span>{" "}
                  <bdi>{(locale === "ar" && o.recipe.nameAr) || o.recipe.name}</bdi>
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{o.warehouse.code}</span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">
                    {fmt(o.plannedQuantity)} {o.plannedUom.code}
                  </span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">
                    {o.producedQuantityBase
                      ? `${fmt(o.producedQuantityBase)} ${o.outputProduct.baseUom.code}`
                      : "—"}
                  </span>
                  {o.outputLot ? (
                    <span className="ltr-value text-muted block font-mono text-xs">
                      {o.outputLot.lotCode}
                    </span>
                  ) : null}
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">{o.cost ? money.money(o.cost) : "—"}</span>
                </Td>
                <Td>
                  <ProductionStatusBadge status={o.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
