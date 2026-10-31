import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { TextReasonForm } from "@/components/invoices/forms";
import {
  Badge,
  Card,
  DescriptionList,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { hasPermission } from "@/modules/access/authorize";
import { getRevaluation } from "@/modules/invoices/revaluation";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyIn } from "@/server/fx-view";
import { cancelRevaluationAction } from "../actions";

const day = (d: Date) => d.toISOString().slice(0, 10);

export default async function RevaluationDetailPage({
  params,
}: PageProps<"/o/[orgSlug]/purchasing/payables/revaluation/[revaluationId]">) {
  const { orgSlug, revaluationId } = await params;
  if (!isUuid(revaluationId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const rev = await notFoundOnAppError(getRevaluation(ctx, revaluationId));
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const money = await moneyIn([ctx.baseCurrency, ...rev.lines.map((l) => l.currency)]);
  const base = money(ctx.baseCurrency);
  return (
    <>
      <PageHeader
        title={rev.number}
        description={t("revaluation.detailHint")}
        actions={
          <Badge tone={rev.cancelledAt ? "muted" : "success"}>
            {t(rev.cancelledAt ? "revaluation.cancelled" : "revaluation.posted")}
          </Badge>
        }
      />
      <div className="space-y-6">
        <Card>
          <DescriptionList
            items={[
              {
                label: t("revaluation.asOf"),
                value: <span className="ltr-value">{day(rev.asOf)}</span>,
              },
              {
                label: t("revaluation.difference"),
                value: (
                  <span className="ltr-value" data-testid="revaluation-difference">
                    {base.money(rev.totalDifferenceBase)}
                  </span>
                ),
              },
              ...(rev.cancelReason
                ? [{ label: t("revaluation.cancelReason"), value: <bdi>{rev.cancelReason}</bdi> }]
                : []),
            ]}
          />
        </Card>
        <Table label={rev.number}>
          <thead>
            <tr>
              <Th>{t("purchasing.supplier")}</Th>
              <Th>{t("fx.currency")}</Th>
              <Th>{t("revaluation.open")}</Th>
              <Th>{t("revaluation.booked")}</Th>
              <Th>{t("revaluation.rate")}</Th>
              <Th>{t("revaluation.revalued")}</Th>
              <Th>{t("revaluation.difference")}</Th>
            </tr>
          </thead>
          <tbody>
            {rev.lines.map((l) => (
              <tr key={l.id}>
                <Td>
                  <span className="ltr-value font-mono text-xs">{l.supplier.code}</span>{" "}
                  <bdi>{(locale === "ar" && l.supplier.nameAr) || l.supplier.name}</bdi>
                </Td>
                <Td>
                  <span className="ltr-value font-mono text-xs">{l.currency}</span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">{money(l.currency).money(l.openAmount)}</span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">{base.money(l.bookedBase)}</span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">
                    {l.rate.toFixed().replace(/\.?0+$/, "")} ({day(l.rateDate)})
                  </span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">{base.money(l.revaluedBase)}</span>
                </Td>
                <Td className="tabular-nums">
                  <span className="ltr-value">{base.money(l.differenceBase)}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {!rev.cancelledAt && hasPermission(ctx.grants, "fx.manage") ? (
          <Card title={t("revaluation.cancel")}>
            <TextReasonForm
              action={cancelRevaluationAction.bind(null, orgSlug, rev.id)}
              name="reason"
              submitLabel={t("revaluation.cancel")}
              label={t("revaluation.cancelReason")}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
