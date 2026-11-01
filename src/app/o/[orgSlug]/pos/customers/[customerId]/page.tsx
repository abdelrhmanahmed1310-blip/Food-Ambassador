import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { AdjustPointsForm, CustomerForm } from "@/components/pos/customer-forms";
import { Card, DescriptionList, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { getCustomer } from "@/modules/pos/customers";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { AppError } from "@/server/errors";
import { moneyFormatter } from "@/server/inventory-view";
import { adjustPointsAction, eraseCustomerAction, updateCustomerAction } from "../actions";

export default async function CustomerPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/customers/[customerId]">) {
  const { orgSlug, customerId } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "customers.view")) notFound();
  const c = await getCustomer(ctx, customerId).catch((e) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const [t, format, money] = await Promise.all([
    getTranslations(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency),
  ]);
  const manage = hasPermission(ctx.grants, "customers.manage");
  const when = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.timeZone });
  return (
    <>
      <PageHeader title={c.name} description={c.phone ?? undefined} />
      <div className="space-y-6">
        <Card title={t("customers.summary")}>
          <DescriptionList
            items={[
              { label: t("customers.phone"), value: <span className="ltr-value">{c.phone}</span> },
              { label: t("customers.email"), value: c.email ?? "—" },
              {
                label: t("customers.points"),
                value: (
                  <span className="ltr-value tabular-nums" data-testid="customer-points">
                    {c.pointsBalance}
                  </span>
                ),
              },
              {
                label: t("customers.consent"),
                value: c.consentAt
                  ? t("customers.consentSince", { date: when(c.consentAt) })
                  : t("customers.consentNo"),
              },
            ]}
          />
        </Card>
        <Card title={t("customers.orders")}>
          {c.orders.length === 0 ? (
            <p className="text-muted text-sm">{t("pos.noOrders")}</p>
          ) : (
            <Table label={t("customers.orders")}>
              <thead>
                <tr>
                  <Th>{t("pos.number")}</Th>
                  <Th>{t("pos.time")}</Th>
                  <Th>{t("pos.total")}</Th>
                  <Th>{t("pos.status")}</Th>
                </tr>
              </thead>
              <tbody>
                {c.orders.map((o) => (
                  <tr key={o.id}>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/pos/orders/${o.id}`}
                        className="text-primary hover:underline"
                      >
                        {o.number}
                      </Link>
                    </Td>
                    <Td>{when(o.orderedAt)}</Td>
                    <Td className="ltr-value tabular-nums">{money.money(o.grossAmount)}</Td>
                    <Td>{t(`pos.statuses.${o.status}`)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title={t("customers.pointsHistory")}>
          {c.entries.length === 0 ? (
            <p className="text-muted text-sm">{t("customers.noPoints")}</p>
          ) : (
            <Table label={t("customers.pointsHistory")}>
              <thead>
                <tr>
                  <Th>{t("pos.time")}</Th>
                  <Th>{t("customers.entryKind")}</Th>
                  <Th>{t("customers.points")}</Th>
                  <Th>{t("pos.reason")}</Th>
                </tr>
              </thead>
              <tbody>
                {c.entries.map((e) => (
                  <tr key={e.id}>
                    <Td>{when(e.createdAt)}</Td>
                    <Td>{t(`customers.entryKinds.${e.kind}`)}</Td>
                    <Td className="ltr-value tabular-nums">
                      {e.points > 0 ? `+${e.points}` : e.points}
                    </Td>
                    <Td>{e.reason ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {manage ? (
          <>
            <Card title={t("customers.edit")}>
              <CustomerForm
                action={updateCustomerAction.bind(null, orgSlug, c.id)}
                values={{ name: c.name, email: c.email, marketingConsent: c.marketingConsent }}
              />
            </Card>
            <Card title={t("customers.adjust")}>
              <AdjustPointsForm action={adjustPointsAction.bind(null, orgSlug, c.id)} />
            </Card>
            <Card title={t("customers.erase")}>
              <p className="text-muted mb-3 text-sm">{t("customers.eraseHint")}</p>
              <ConfirmActionButton
                action={eraseCustomerAction.bind(null, orgSlug, c.id)}
                label={t("customers.erase")}
                confirmMessage={t("customers.eraseConfirm")}
              />
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}
