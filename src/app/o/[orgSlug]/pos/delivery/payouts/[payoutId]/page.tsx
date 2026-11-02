import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
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
import { getDeliveryPayout } from "@/modules/delivery/payouts";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { confirmPayoutAction, deletePayoutAction } from "../actions";

const TONE = {
  MATCHED: "success",
  AMOUNT_DIFFERS: "warning",
  NOT_FOUND: "danger",
  CANCELLED_ORDER: "warning",
  NOT_ACCEPTED: "danger",
  ALREADY_PAID: "danger",
  ADJUSTMENT: "muted",
} as const;

/** One payout: totals, each line against our order, and orders it does not pay for (ADR-075). */
export default async function DeliveryPayoutPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/delivery/payouts/[payoutId]">) {
  const { orgSlug, payoutId } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, format, money, view] = await Promise.all([
    getTranslations(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency).then((f) => f.money),
    getDeliveryPayout(ctx, payoutId),
  ]);
  const { payout: p } = view;
  const manage = hasPermission(ctx.grants, "payments.manage");
  const day = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" });
  const when = (d: Date) =>
    format.dateTime(d, { dateStyle: "short", timeStyle: "short", timeZone: ctx.timeZone });
  return (
    <>
      <PageHeader
        title={`${t("delivery.payouts.payout")} ${p.reference}`}
        description={`${p.connector.name} · ${day(p.periodFrom)} – ${day(p.periodTo)}`}
        actions={
          manage && p.status === "DRAFT" ? (
            <>
              <ConfirmActionButton
                action={confirmPayoutAction.bind(null, orgSlug, p.id)}
                label={t("delivery.payouts.confirm")}
                confirmMessage={t("delivery.payouts.confirmMessage")}
                variant="primary"
              />
              <ConfirmActionButton
                action={deletePayoutAction.bind(null, orgSlug, p.id)}
                label={t("delivery.payouts.delete")}
                confirmMessage={t("delivery.payouts.deleteMessage")}
              />
            </>
          ) : null
        }
      />
      <div className="space-y-6">
        {view.exceptions > 0 || view.unpaid.length > 0 ? (
          <Alert tone="info">
            {t("delivery.payouts.toReview", {
              exceptions: view.exceptions,
              unpaid: view.unpaid.length,
            })}
          </Alert>
        ) : (
          <Alert tone="success">{t("delivery.payouts.allMatched")}</Alert>
        )}
        <Card title={t("delivery.payouts.summary")}>
          <div data-testid="payout-summary">
            <DescriptionList
              items={[
                {
                  label: t("delivery.payouts.status"),
                  value: (
                    <Badge tone={p.status === "CONFIRMED" ? "success" : "warning"}>
                      {t(`delivery.payouts.statuses.${p.status}`)}
                    </Badge>
                  ),
                },
                { label: t("delivery.payouts.gross"), value: money(p.gross) },
                { label: t("delivery.payouts.commission"), value: money(p.commission) },
                { label: t("delivery.payouts.fees"), value: money(p.fees) },
                { label: t("delivery.payouts.vatOnFees"), value: money(p.vatOnFees) },
                { label: t("delivery.payouts.net"), value: money(p.net) },
                {
                  label: t("delivery.payouts.effectiveRate"),
                  value:
                    view.effectiveRate === null
                      ? "—"
                      : `${format.number(Number(view.effectiveRate.toFixed(2)))} %`,
                },
                ...(p.receivedAmount !== null
                  ? [
                      {
                        label: t("delivery.payouts.receivedAmount"),
                        value: money(p.receivedAmount),
                      },
                      {
                        label: t("delivery.payouts.bankDifference"),
                        value: money(view.bankDifference!.toString()),
                      },
                    ]
                  : []),
                ...(p.paidOn
                  ? [{ label: t("delivery.payouts.paidOn"), value: day(p.paidOn) }]
                  : []),
                ...(p.confirmedAt
                  ? [{ label: t("delivery.payouts.confirmedAt"), value: when(p.confirmedAt) }]
                  : []),
              ]}
            />
          </div>
        </Card>
        <Card title={t("delivery.payouts.lines")}>
          <Table label={t("delivery.payouts.lines")}>
            <thead>
              <tr>
                <Th>{t("delivery.payouts.order")}</Th>
                <Th>{t("delivery.payouts.gross")}</Th>
                <Th>{t("delivery.payouts.recorded")}</Th>
                <Th>{t("delivery.payouts.commissionAndFees")}</Th>
                <Th>{t("delivery.payouts.net")}</Th>
                <Th>{t("delivery.payouts.match")}</Th>
              </tr>
            </thead>
            <tbody>
              {p.lines.map((l) => (
                <tr key={l.id} data-testid="payout-line">
                  <Td>
                    {l.externalId ? (
                      <span className="ltr-value font-mono">{l.externalId}</span>
                    ) : (
                      l.description
                    )}
                    {l.deliveryOrder?.posOrder ? (
                      <Link
                        href={`/o/${orgSlug}/pos/orders/${l.deliveryOrder.posOrder.id}`}
                        className="text-primary ltr-value ms-2 font-mono text-xs hover:underline"
                      >
                        {l.deliveryOrder.posOrder.number}
                      </Link>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">{money(l.gross)}</Td>
                  <Td className="tabular-nums">
                    {l.recordedTotal === null ? "—" : money(l.recordedTotal)}
                  </Td>
                  <Td className="tabular-nums">
                    {money(l.commission.plus(l.fees).plus(l.vatOnFees).toString())}
                  </Td>
                  <Td className="tabular-nums">{money(l.net)}</Td>
                  <Td>
                    <Badge tone={TONE[l.match]}>{t(`delivery.payouts.matches.${l.match}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card title={t("delivery.payouts.unpaid")}>
          <p className="text-muted mb-3 text-sm">{t("delivery.payouts.unpaidIntro")}</p>
          {view.unpaid.length === 0 ? (
            <p className="text-muted text-sm">{t("delivery.payouts.noUnpaid")}</p>
          ) : (
            <Table label={t("delivery.payouts.unpaid")}>
              <thead>
                <tr>
                  <Th>{t("delivery.payouts.order")}</Th>
                  <Th>{t("delivery.payouts.placedAt")}</Th>
                  <Th>{t("delivery.payouts.recorded")}</Th>
                </tr>
              </thead>
              <tbody>
                {view.unpaid.map((o) => (
                  <tr key={o.id} data-testid="unpaid-order">
                    <Td className="ltr-value font-mono">{o.displayCode ?? o.externalId}</Td>
                    <Td className="ltr-value">{when(o.placedAt)}</Td>
                    <Td className="tabular-nums">{money(o.total)}</Td>
                  </tr>
                ))}
                <tr>
                  <Td className="font-semibold">{t("delivery.payouts.total")}</Td>
                  <Td>{null}</Td>
                  <Td className="font-semibold tabular-nums">
                    {money(view.unpaidTotal.toString())}
                  </Td>
                </tr>
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
