import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { TextReasonForm } from "@/components/invoices/forms";
import { RefundForm } from "@/components/pos/forms";
import {
  Badge,
  Card,
  DescriptionList,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getOrder, refundRegisters } from "@/modules/pos/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter } from "@/server/inventory-view";
import { refundOrderAction, voidOrderAction } from "../../actions";

type Option = { optionId: string; name: string; priceDelta: string };

export default async function OrderPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/orders/[orderId]">) {
  const { orgSlug, orderId } = await params;
  if (!isUuid(orderId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const [t, format, money, o] = await Promise.all([
    getTranslations(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency),
    notFoundOnAppError(getOrder(ctx, orderId)),
  ]);
  const registers = o.can.refund ? await refundRegisters(ctx, o.branchId) : [];
  const tz = o.branch.timeZone ?? ctx.timeZone;
  const when = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: tz });
  const m = (v: { toString(): string }) => (
    <span className="ltr-value tabular-nums">{money.money(v)}</span>
  );
  const status = o.status === "VOIDED" ? "VOIDED" : o.refundedAmount.gt(0) ? "REFUNDED" : "PAID";
  return (
    <>
      <PageHeader
        title={t("pos.orderTitle", { number: o.number })}
        description={`${o.register.code} · ${when(o.orderedAt)} · ${t(`menu.channels.${o.channel}`)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/o/${orgSlug}/pos/orders/${o.id}/receipt`} variant="secondary">
              {t("pos.receipt")}
            </LinkButton>
            <LinkButton href={`/o/${orgSlug}/pos/shifts/${o.shift.id}`} variant="secondary">
              {o.shift.number}
            </LinkButton>
          </div>
        }
      />
      <div className="space-y-6">
        <Card title={t("pos.summary")}>
          <DescriptionList
            items={[
              {
                label: t("pos.status"),
                value: (
                  <Badge
                    tone={
                      status === "VOIDED" ? "danger" : status === "REFUNDED" ? "warning" : "success"
                    }
                  >
                    {t(`pos.statuses.${status}`)}
                  </Badge>
                ),
              },
              { label: t("pos.netSales"), value: m(o.netAmount) },
              { label: t("pos.vat"), value: m(o.taxAmount) },
              { label: t("pos.total"), value: m(o.grossAmount) },
              ...(o.refundedAmount.gt(0)
                ? [{ label: t("pos.refunded"), value: m(o.refundedAmount) }]
                : []),
              { label: t("pos.stockCost"), value: m(o.costAmount) },
              ...(o.cashierName ? [{ label: t("pos.cashier"), value: o.cashierName }] : []),
              ...(o.voidReason ? [{ label: t("pos.voidReason"), value: o.voidReason }] : []),
            ]}
          />
        </Card>
        <Card title={t("pos.lines")}>
          <Table label={t("pos.lines")}>
            <thead>
              <tr>
                <Th>{t("pos.item")}</Th>
                <Th>{t("pos.quantity")}</Th>
                <Th>{t("pos.unitPrice")}</Th>
                <Th>{t("pos.vat")}</Th>
                <Th>{t("pos.total")}</Th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.id}>
                  <Td>
                    <bdi>{l.name}</bdi>
                    {(l.options as Option[]).length > 0 ? (
                      <span className="text-muted block text-xs">
                        {(l.options as Option[]).map((x) => x.name).join(" · ")}
                      </span>
                    ) : null}
                    {l.refundedQuantity.gt(0) ? (
                      <span className="text-muted block text-xs">
                        {t("pos.refundedQty", { quantity: l.refundedQuantity.toFixed() })}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="ltr-value tabular-nums">{l.quantity.toFixed()}</Td>
                  <Td>{m(l.unitPrice)}</Td>
                  <Td>{m(l.taxAmount)}</Td>
                  <Td>{m(l.grossAmount)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card title={t("pos.payments")}>
          <ul className="divide-border divide-y text-sm">
            {o.payments.map((p) => (
              <li key={p.id} className="flex justify-between gap-2 py-2">
                <span>
                  {t(`pos.methods.${p.method}`)}
                  {p.tendered ? (
                    <span className="text-muted">
                      {" · "}
                      {t("pos.tendered")} {m(p.tendered)} · {t("pos.change")} {m(p.change ?? 0)}
                    </span>
                  ) : null}
                  {p.method === "CARD" && (p.cardScheme || p.approvalCode || p.cardLast4) ? (
                    <span className="text-muted" data-testid="card-details">
                      {" · "}
                      {[
                        p.cardScheme ? t(`pos.cardSchemes.${p.cardScheme}`) : null,
                        p.cardLast4 ? `•••• ${p.cardLast4}` : null,
                        p.approvalCode ? `${t("pos.approvalCode")} ${p.approvalCode}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  ) : null}
                  {p.tip.gt(0) ? (
                    <span className="text-muted">
                      {" · "}
                      {t("pos.tip")} {m(p.tip)}
                    </span>
                  ) : null}
                </span>
                {m(p.amount)}
              </li>
            ))}
            {o.refunds.map((r) => (
              <li key={r.id} className="flex justify-between gap-2 py-2">
                <span>
                  <span className="ltr-value font-mono">{r.number}</span> ·{" "}
                  {t(`pos.methods.${r.method}`)}
                  {r.reference ? ` (${r.reference})` : ""} · {r.reason}
                </span>
                <span className="text-danger">−{m(r.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
        {o.shortfalls.length > 0 ? (
          <Card title={t("pos.shortfalls")}>
            <ul className="text-sm">
              {o.shortfalls.map((s) => (
                <li key={s.id}>
                  <span className="ltr-value font-mono">{s.product.sku}</span> {s.product.nameEn} ·{" "}
                  <span className="ltr-value tabular-nums">{s.quantity.toFixed()}</span> ·{" "}
                  {t(`pos.shortfallStatuses.${s.status}`)}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {o.can.refund ? (
          <Card title={t("pos.refund")}>
            {registers.length === 0 ? (
              <p className="text-muted text-sm">{t("pos.refundNeedsShift")}</p>
            ) : (
              <RefundForm
                action={refundOrderAction.bind(null, orgSlug, o.id)}
                registers={registers.map((r) => ({ value: r.id, label: `${r.code} — ${r.name}` }))}
                lines={o.lines
                  .filter((l) => l.quantity.gt(l.refundedQuantity))
                  .map((l) => ({
                    id: l.id,
                    label: `${l.lineNo}. ${l.name}`,
                    remaining: l.quantity.minus(l.refundedQuantity).toFixed(),
                  }))}
              />
            )}
          </Card>
        ) : null}
        {o.can.void ? (
          <Card title={t("pos.void")}>
            <p className="text-muted mb-3 text-sm">{t("pos.voidHint")}</p>
            <TextReasonForm
              action={voidOrderAction.bind(null, orgSlug, o.id)}
              name="reason"
              label={t("pos.voidReason")}
              submitLabel={t("pos.void")}
              variant="danger"
            />
          </Card>
        ) : null}
        <p className="text-sm">
          <Link
            href={`/o/${orgSlug}/pos/registers/${o.register.id}`}
            className="text-primary hover:underline"
          >
            {o.register.code} — {o.register.name}
          </Link>
        </p>
      </div>
    </>
  );
}
