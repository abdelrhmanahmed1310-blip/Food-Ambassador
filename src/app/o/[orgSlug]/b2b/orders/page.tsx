import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/styles";
import { hasPermission } from "@/modules/access/authorize";
import { listSalesOrders } from "@/modules/b2b/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

export default async function SalesOrdersPage({ params }: PageProps<"/o/[orgSlug]/b2b/orders">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "b2b.view")) notFound();
  const [t, locale, format, orders] = await Promise.all([
    getTranslations(),
    getLocale(),
    getFormatter(),
    listSalesOrders(ctx),
  ]);
  return (
    <>
      <PageHeader
        title={t("b2b.orders")}
        description={t("b2b.ordersHint")}
        actions={
          hasPermission(ctx.grants, "b2b.manage") ? (
            <Link href={`/o/${orgSlug}/b2b/orders/new`} className={buttonClass("primary")}>
              {t("b2b.newOrder")}
            </Link>
          ) : null
        }
      />
      {orders.length === 0 ? (
        <EmptyState title={t("b2b.noOrders")} />
      ) : (
        <Table label={t("b2b.orders")}>
          <thead>
            <tr>
              <Th>{t("purchasing.number")}</Th>
              <Th>{t("b2b.customer")}</Th>
              <Th>{t("b2b.shipFrom")}</Th>
              <Th>{t("common.date")}</Th>
              <Th>{t("common.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <Td>
                  <Link
                    href={`/o/${orgSlug}/b2b/orders/${o.id}`}
                    className="ltr-value text-primary font-mono text-xs hover:underline"
                  >
                    {o.number}
                  </Link>
                </Td>
                <Td>
                  <bdi>{(locale === "ar" && o.customer.nameAr) || o.customer.name}</bdi>
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{o.warehouse.code}</span>
                </Td>
                <Td>
                  {format.dateTime(o.createdAt, { dateStyle: "medium", timeZone: ctx.timeZone })}
                </Td>
                <Td>
                  <Badge
                    tone={
                      o.status === "DELIVERED"
                        ? "success"
                        : o.status === "CANCELLED"
                          ? "muted"
                          : "warning"
                    }
                  >
                    {t(`b2b.statuses.${o.status}`)}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
