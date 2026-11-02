import Link from "next/link";
import { notFound } from "next/navigation";
import { currencyOf } from "@/modules/fx/service";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge, Card, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { PrintButton } from "@/components/ui/print-button";
import { isUuid } from "@/lib/uuid";
import { getShift } from "@/modules/pos/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import { moneyFormatter } from "@/server/inventory-view";
import { ShiftTotals } from "../../shift-totals";

/** X report while the shift is open, Z report once it is closed. */
export default async function ShiftPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/shifts/[shiftId]">) {
  const { orgSlug, shiftId } = await params;
  if (!isUuid(shiftId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const [t, format, s] = await Promise.all([
    getTranslations(),
    getFormatter(),
    notFoundOnAppError(getShift(ctx, shiftId)),
  ]);
  const currency = await currencyOf(ctx, { branchId: s.register.branchId });
  const money = await moneyFormatter(currency);
  const tz = s.register.branch.timeZone ?? ctx.timeZone;
  const when = (d: Date) =>
    format.dateTime(d, { dateStyle: "medium", timeStyle: "short", timeZone: tz });
  return (
    <>
      <PageHeader
        title={t(s.status === "OPEN" ? "pos.xReport" : "pos.zReport", { number: s.number })}
        description={`${s.register.code} — ${s.register.name} · ${when(s.openedAt)}${s.closedAt ? ` → ${when(s.closedAt)}` : ""}`}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <PrintButton label={t("pos.print")} />
            <LinkButton href={`/o/${orgSlug}/pos/registers/${s.register.id}`} variant="secondary">
              {s.register.code}
            </LinkButton>
          </div>
        }
      />
      <div className="space-y-6">
        <Card title={t(`pos.shiftStatuses.${s.status}`)}>
          <ShiftTotals
            totals={s.totals}
            openingFloat={s.openingFloat}
            currency={currency}
            counted={
              s.countedCash && s.cashDifference && s.expectedCash
                ? { counted: s.countedCash, difference: s.cashDifference, expected: s.expectedCash }
                : null
            }
          />
          {s.closeNote ? <p className="mt-4 text-sm">{s.closeNote}</p> : null}
        </Card>
        {s.movements.length > 0 ? (
          <Card title={t("pos.cashMovements")}>
            <ul className="divide-border divide-y text-sm">
              {s.movements.map((mv) => (
                <li key={mv.id} className="flex justify-between gap-2 py-2">
                  <span>
                    {t(`pos.movementKinds.${mv.kind}`)} · {mv.reason}
                  </span>
                  <span className="ltr-value tabular-nums">{money.money(mv.amount)}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <Card title={t("pos.orders")}>
          {s.orders.length === 0 ? (
            <p className="text-muted text-sm">{t("pos.noOrders")}</p>
          ) : (
            <Table label={t("pos.orders")}>
              <thead>
                <tr>
                  <Th>{t("pos.number")}</Th>
                  <Th>{t("pos.time")}</Th>
                  <Th>{t("pos.total")}</Th>
                  <Th>{t("pos.status")}</Th>
                </tr>
              </thead>
              <tbody>
                {s.orders.map((o) => (
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
                    <Td className="ltr-value tabular-nums">{money.money(o.grossAmount)}</Td>
                    <Td>
                      <Badge tone={o.status === "VOIDED" ? "danger" : "success"}>
                        {t(`pos.statuses.${o.status}`)}
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
