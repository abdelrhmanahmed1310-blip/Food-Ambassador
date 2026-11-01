import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { CustomerForm, LoyaltySettingsForm } from "@/components/pos/customer-forms";
import { Badge, Card, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/pagination";
import { hasPermission } from "@/modules/access/authorize";
import { listCustomers, loyaltySettings } from "@/modules/pos/customers";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createCustomerAction, loyaltySettingsAction } from "./actions";

/** Customers and the loyalty programme (ADR-068). */
export default async function CustomersPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/pos/customers">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "customers.view")) notFound();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const [t, format, list, loyalty] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listCustomers(ctx, { q, page: sp.page }),
    loyaltySettings(ctx),
  ]);
  const base = `/o/${orgSlug}/pos/customers`;
  return (
    <>
      <PageHeader title={t("customers.title")} description={t("customers.intro")} />
      <div className="space-y-6">
        <form method="get" className="flex flex-wrap items-end gap-3" role="search">
          <label className="text-sm">
            <span className="mb-1 block font-medium">{t("common.search")}</span>
            <input
              name="q"
              defaultValue={q}
              className="border-border bg-surface rounded-md border px-3 py-2"
            />
          </label>
          <button type="submit" className="border-border rounded-md border px-3 py-2 text-sm">
            {t("common.search")}
          </button>
        </form>
        <Card title={t("customers.list")}>
          {list.rows.length === 0 ? (
            <p className="text-muted text-sm">{t("customers.none")}</p>
          ) : (
            <Table label={t("customers.list")}>
              <thead>
                <tr>
                  <Th>{t("customers.name")}</Th>
                  <Th>{t("customers.phone")}</Th>
                  <Th>{t("customers.points")}</Th>
                  <Th>{t("customers.consent")}</Th>
                  <Th>{t("customers.since")}</Th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <Link href={`${base}/${c.id}`} className="text-primary hover:underline">
                        <bdi>{c.name}</bdi>
                      </Link>
                    </Td>
                    <Td className="ltr-value">{c.phone}</Td>
                    <Td className="ltr-value tabular-nums">{c.pointsBalance}</Td>
                    <Td>
                      {c.marketingConsent ? (
                        <Badge tone="success">{t("customers.consentYes")}</Badge>
                      ) : (
                        <Badge tone="neutral">{t("customers.consentNo")}</Badge>
                      )}
                    </Td>
                    <Td>
                      {format.dateTime(c.createdAt, {
                        dateStyle: "medium",
                        timeZone: ctx.timeZone,
                      })}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <Pagination
            basePath={base}
            params={{ q }}
            page={list.page}
            pageCount={list.pages}
            total={list.total}
          />
        </Card>
        {hasPermission(ctx.grants, "customers.manage") ? (
          <Card title={t("customers.add")}>
            <CustomerForm action={createCustomerAction.bind(null, orgSlug)} />
          </Card>
        ) : null}
        {hasPermission(ctx.grants, "org.settings.manage") ? (
          <Card title={t("customers.loyalty")}>
            <p className="text-muted mb-4 text-sm">{t("customers.loyaltyIntro")}</p>
            <LoyaltySettingsForm
              action={loyaltySettingsAction.bind(null, orgSlug)}
              values={{
                enabled: loyalty?.enabled ?? false,
                earnRate: loyalty?.earnRate.toFixed() ?? "1",
                pointValue: loyalty?.pointValue.toFixed() ?? "0.05",
                minRedeemPoints: String(loyalty?.minRedeemPoints ?? 0),
              }}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
