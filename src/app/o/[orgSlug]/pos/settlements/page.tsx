import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { SettlementForm } from "@/components/pos/settlement-form";
import { PeriodForm } from "@/components/reports/period-form";
import {
  Alert,
  Badge,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { hasPermission } from "@/modules/access/authorize";
import { businessDate } from "@/modules/inventory/rules";
import { reconciliation, SETTLEMENT_DUE_DAYS } from "@/modules/pos/settlements";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { importSettlementAction } from "./actions";

/** Card sales against what the acquirer paid out (ADR-065). */
export default async function SettlementsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/pos/settlements">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!hasPermission(ctx.grants, "payments.manage")) notFound();
  const sp = await searchParams;
  const today = businessDate(ctx.timeZone);
  const from =
    typeof sp.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.from)
      ? sp.from
      : `${today.slice(0, 8)}01`;
  const to = typeof sp.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : today;
  const [t, format, money, r] = await Promise.all([
    getTranslations(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency),
    reconciliation(ctx, { from, to }, today),
  ]);
  const m = (v: { toString(): string }) => (
    <span className="ltr-value tabular-nums">{money.money(v)}</span>
  );
  const date = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" });
  return (
    <>
      <PageHeader title={t("settlements.title")} description={t("settlements.intro")} />
      <div className="space-y-6">
        <PeriodForm from={from} to={to} />
        <Card title={t("settlements.summary")}>
          <DescriptionList
            items={[
              { label: t("settlements.cardSales"), value: m(r.cardSales) },
              { label: t("pos.cardTips"), value: m(r.tips) },
              { label: t("settlements.settled"), value: m(r.settled) },
              { label: t("settlements.fees"), value: m(r.fees) },
              {
                label: t("settlements.matched"),
                value: <span data-testid="matched-count">{r.matched}</span>,
              },
              {
                label: t("settlements.unsettledCount"),
                value: <span data-testid="unsettled-count">{r.unsettled.length}</span>,
              },
            ]}
          />
        </Card>
        {r.mismatched.length > 0 || r.unmatched.length > 0 ? (
          <Card title={t("settlements.differences")}>
            <Table label={t("settlements.differences")}>
              <thead>
                <tr>
                  <Th>{t("settlements.date")}</Th>
                  <Th>{t("pos.approvalCode")}</Th>
                  <Th>{t("settlements.settledAmount")}</Th>
                  <Th>{t("settlements.saleAmount")}</Th>
                  <Th>{t("settlements.result")}</Th>
                </tr>
              </thead>
              <tbody>
                {[...r.mismatched, ...r.unmatched].map((l) => (
                  <tr key={l.id}>
                    <Td className="ltr-value">{date(l.transactionDate)}</Td>
                    <Td className="ltr-value font-mono">{l.approvalCode}</Td>
                    <Td>{m(l.amount)}</Td>
                    <Td>
                      {l.payment ? (
                        <Link
                          href={`/o/${orgSlug}/pos/orders/${l.payment.order.id}`}
                          className="text-primary hover:underline"
                        >
                          {m(l.payment.amount.plus(l.payment.tip))} · {l.payment.order.number}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td>
                      <Badge tone={l.match === "UNMATCHED" ? "danger" : "warning"}>
                        {t(`settlements.matches.${l.match}`)}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : null}
        <Card title={t("settlements.unsettled")}>
          {r.unsettled.length === 0 ? (
            <p className="text-muted text-sm">{t("settlements.allSettled")}</p>
          ) : (
            <ul className="divide-border divide-y text-sm" data-testid="unsettled">
              {r.unsettled.map((p) => (
                <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <Link
                    href={`/o/${orgSlug}/pos/orders/${p.order.id}`}
                    className="text-primary ltr-value hover:underline"
                  >
                    {p.order.number}
                  </Link>
                  <span>
                    {p.approvalCode ? (
                      <span className="ltr-value font-mono">{p.approvalCode}</span>
                    ) : (
                      t("settlements.noApprovalCode")
                    )}{" "}
                    · {m(p.charged)}{" "}
                    {p.overdue ? (
                      <Badge tone="danger">
                        {t("settlements.overdue", { days: SETTLEMENT_DUE_DAYS })}
                      </Badge>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t("settlements.import")}>
          <Alert tone="info">{t("settlements.providerNote")}</Alert>
          <div className="mt-4">
            <SettlementForm action={importSettlementAction.bind(null, orgSlug)} />
          </div>
          {r.batches.length > 0 ? (
            <ul className="text-muted mt-4 text-sm">
              {r.batches.map((b) => (
                <li key={b.id}>
                  {b.fileName} · {t("settlements.lines", { count: b.lineCount })} ·{" "}
                  {format.dateTime(b.importedAt, {
                    dateStyle: "short",
                    timeStyle: "short",
                    timeZone: ctx.timeZone,
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>
    </>
  );
}
