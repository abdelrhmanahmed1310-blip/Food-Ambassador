import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { PayoutImportForm } from "@/components/pos/payout-forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { listDeliveryPayouts, payoutConnectors } from "@/modules/delivery/payouts";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { importPayoutAction } from "./actions";

/** Delivery platform payouts: import a statement and reconcile it (ADR-075). */
export default async function DeliveryPayoutsPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/delivery/payouts">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const manage = hasPermission(ctx.grants, "payments.manage");
  if (!manage && !hasPermission(ctx.grants, "invoices.view")) notFound();
  const [t, format, money, payouts, connectors] = await Promise.all([
    getTranslations(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency).then((f) => f.money),
    listDeliveryPayouts(ctx),
    manage ? payoutConnectors(ctx) : Promise.resolve([]),
  ]);
  const day = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" });
  return (
    <>
      <PageHeader title={t("delivery.payouts.title")} description={t("delivery.payouts.intro")} />
      <div className="space-y-6">
        {manage ? (
          <Card title={t("delivery.payouts.importTitle")}>
            {connectors.length === 0 ? (
              <p className="text-muted text-sm">{t("delivery.payouts.noConnectors")}</p>
            ) : (
              <div className="space-y-3">
                <a
                  href={`/o/${orgSlug}/pos/delivery/payouts/template`}
                  className="text-primary inline-block text-sm font-medium hover:underline"
                >
                  {t("import.template")}
                </a>
                <PayoutImportForm
                  action={importPayoutAction.bind(null, orgSlug)}
                  connectors={connectors.map((c) => ({ value: c.id, label: c.name }))}
                />
              </div>
            )}
          </Card>
        ) : null}
        <Card title={t("delivery.payouts.list")}>
          {payouts.length === 0 ? (
            <EmptyState title={t("delivery.payouts.none")} />
          ) : (
            <Table label={t("delivery.payouts.list")}>
              <thead>
                <tr>
                  <Th>{t("delivery.payouts.reference")}</Th>
                  <Th>{t("delivery.payouts.connector")}</Th>
                  <Th>{t("delivery.payouts.period")}</Th>
                  <Th>{t("delivery.payouts.gross")}</Th>
                  <Th>{t("delivery.payouts.net")}</Th>
                  <Th>{t("delivery.payouts.status")}</Th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      <Link
                        href={`/o/${orgSlug}/pos/delivery/payouts/${p.id}`}
                        className="text-primary ltr-value font-mono hover:underline"
                      >
                        {p.reference}
                      </Link>
                    </Td>
                    <Td>{p.connector.name}</Td>
                    <Td className="ltr-value">
                      {day(p.periodFrom)} – {day(p.periodTo)}
                    </Td>
                    <Td className="tabular-nums">{money(p.gross)}</Td>
                    <Td className="tabular-nums">{money(p.net)}</Td>
                    <Td>
                      <Badge tone={p.status === "CONFIRMED" ? "success" : "warning"}>
                        {t(`delivery.payouts.statuses.${p.status}`)}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
