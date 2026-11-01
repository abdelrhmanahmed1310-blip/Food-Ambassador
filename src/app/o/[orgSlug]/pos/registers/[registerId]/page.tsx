import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { CashMovementForm, CloseShiftForm, OpenShiftForm } from "@/components/pos/forms";
import { PendingSyncNotice } from "@/components/pos/pending-notice";
import {
  Badge,
  Card,
  DescriptionList,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { getRegister } from "@/modules/pos/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter } from "@/server/inventory-view";
import { cashMovementAction, closeShiftAction, openShiftAction } from "../../actions";
import { ShiftTotals } from "../../shift-totals";

export default async function RegisterPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/registers/[registerId]">) {
  const { orgSlug, registerId } = await params;
  if (!isUuid(registerId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const [t, format, money, r] = await Promise.all([
    getTranslations(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency),
    notFoundOnAppError(getRegister(ctx, registerId)),
  ]);
  const shift = r.openShift;
  const when = (d: Date) =>
    format.dateTime(d, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: r.branch.timeZone ?? ctx.timeZone,
    });
  return (
    <>
      <PageHeader
        title={`${r.code} — ${r.name}`}
        description={t("pos.registerAt", { branch: r.branch.name, warehouse: r.warehouse.name })}
        actions={
          <div className="flex flex-wrap gap-2">
            {shift && r.can.sell ? (
              <LinkButton href={`/o/${orgSlug}/pos/registers/${r.id}/sell`}>
                {t("pos.openTill")}
              </LinkButton>
            ) : null}
            <LinkButton href={`/o/${orgSlug}/pos`} variant="secondary">
              {t("pos.title")}
            </LinkButton>
          </div>
        }
      />
      <div className="space-y-6">
        {!shift ? (
          r.can.sell ? (
            <Card title={t("pos.openShift")}>
              <OpenShiftForm
                action={openShiftAction.bind(null, orgSlug, r.id)}
                currency={ctx.baseCurrency}
              />
            </Card>
          ) : (
            <EmptyState title={t("pos.noShift")} />
          )
        ) : (
          <>
            <Card title={t("pos.currentShift", { number: shift.number })}>
              <ShiftTotals
                totals={shift.totals}
                openingFloat={shift.openingFloat}
                currency={ctx.baseCurrency}
              />
            </Card>
            {r.can.sell ? (
              <>
                <Card title={t("pos.cashMovement")}>
                  <CashMovementForm
                    action={cashMovementAction.bind(null, orgSlug, shift.id)}
                    currency={ctx.baseCurrency}
                  />
                </Card>
                <Card title={t("pos.closeShift")}>
                  <PendingSyncNotice registerId={r.id} />
                  <CloseShiftForm
                    action={closeShiftAction.bind(null, orgSlug, shift.id)}
                    currency={ctx.baseCurrency}
                  />
                </Card>
              </>
            ) : null}
            <Card title={t("pos.orders")}>
              {shift.orders.length === 0 ? (
                <p className="text-muted text-sm">{t("pos.noOrders")}</p>
              ) : (
                <Table label={t("pos.orders")}>
                  <thead>
                    <tr>
                      <Th>{t("pos.number")}</Th>
                      <Th>{t("pos.time")}</Th>
                      <Th>{t("menu.channel")}</Th>
                      <Th>{t("pos.total")}</Th>
                      <Th>{t("pos.status")}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {shift.orders.map((o) => (
                      <tr key={o.id}>
                        <Td>
                          <Link
                            href={`/o/${orgSlug}/pos/orders/${o.id}`}
                            className="text-primary ltr-value font-mono hover:underline"
                          >
                            {o.number}
                          </Link>
                        </Td>
                        <Td className="ltr-value">{when(o.orderedAt)}</Td>
                        <Td>{t(`menu.channels.${o.channel}`)}</Td>
                        <Td className="ltr-value tabular-nums">{money.money(o.grossAmount)}</Td>
                        <Td>
                          <Badge
                            tone={
                              o.status === "VOIDED"
                                ? "danger"
                                : o.refundedAmount.gt(0)
                                  ? "warning"
                                  : "success"
                            }
                          >
                            {o.status === "VOIDED"
                              ? t("pos.statuses.VOIDED")
                              : o.refundedAmount.gt(0)
                                ? t("pos.statuses.REFUNDED")
                                : t("pos.statuses.PAID")}
                          </Badge>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </>
        )}
        <Card title={t("pos.shifts")}>
          {r.shifts.length === 0 ? (
            <p className="text-muted text-sm">{t("pos.noShifts")}</p>
          ) : (
            <DescriptionList
              items={r.shifts.map((s) => ({
                label: s.number,
                value: (
                  <Link
                    href={`/o/${orgSlug}/pos/shifts/${s.id}`}
                    className="text-primary hover:underline"
                  >
                    <span className="ltr-value">{when(s.openedAt)}</span>
                    {" · "}
                    {t(`pos.shiftStatuses.${s.status}`)}
                    {s.cashDifference && !s.cashDifference.isZero() ? (
                      <>
                        {" · "}
                        {t("pos.difference")}{" "}
                        <span className="ltr-value tabular-nums">
                          {money.money(s.cashDifference)}
                        </span>
                      </>
                    ) : null}
                  </Link>
                ),
              }))}
            />
          )}
        </Card>
      </div>
    </>
  );
}
