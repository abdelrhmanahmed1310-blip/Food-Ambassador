import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/pos/auto-refresh";
import { CheckScreen, type CheckView } from "@/components/pos/check-screen";
import { Badge, LinkButton } from "@/components/ui/primitives";
import { isUuid } from "@/lib/uuid";
import { businessDate } from "@/modules/inventory/rules";
import { sellableMenu } from "@/modules/pos/service";
import { getTab } from "@/modules/pos/tables";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { notFoundOnAppError } from "@/server/actions/not-found";
import {
  addLinesAction,
  cancelAction,
  mergeAction,
  moveAction,
  payAction,
  removeLineAction,
  sendAction,
  updateLineAction,
  voidLineAction,
} from "../../tables-actions";

/** One check: the waiter adds and sends items; the cashier takes payment (ADR-062). */
export default async function CheckPage({ params }: PageProps<"/o/[orgSlug]/pos/tabs/[tabId]">) {
  const { orgSlug, tabId } = await params;
  if (!isUuid(tabId)) notFound();
  const ctx = await requireTenant(orgSlug);
  const [t, format, tab] = await Promise.all([
    getTranslations(),
    getFormatter(),
    notFoundOnAppError(getTab(ctx, tabId)),
  ]);
  const open = tab.status === "OPEN";
  const menu =
    open && tab.can.serve
      ? ((
          await sellableMenu(ctx, tab.branchId, businessDate(tab.branch.timeZone ?? ctx.timeZone))
        ).find((c) => c.channel === tab.channel)?.items ?? [])
      : [];
  const check: CheckView = {
    id: tab.id,
    number: tab.number,
    status: tab.status,
    tableCode: tab.table?.code ?? null,
    label: tab.label,
    guests: tab.guests,
    currency: tab.currency,
    lines: tab.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      name: l.name,
      optionNames: Array.isArray(l.optionNames) ? (l.optionNames as string[]) : [],
      quantity: l.quantity.toFixed(),
      paidQuantity: l.paidQuantity.toFixed(),
      remaining: l.remaining.toFixed(),
      seat: l.seat,
      course: l.course,
      note: l.note,
      hold: l.hold,
      status: l.status,
      unitPrice: l.unitPrice?.toFixed() ?? null,
      includesTax: l.includesTax,
      taxRate: l.taxRate,
      gross: l.gross?.toFixed() ?? null,
      voidReason: l.voidReason,
    })),
    orders: tab.orders.map((o) => ({ id: o.id, number: o.number, gross: o.grossAmount.toFixed() })),
    otherTabs: tab.otherTabs.map((o) => ({
      id: o.id,
      label: `${o.table?.code ?? o.label ?? ""} · ${o.number}`,
    })),
    freeTables: tab.freeTables,
    registers: tab.registers.map((r) => ({ id: r.id, label: `${r.code} — ${r.name}` })),
    can: { serve: tab.can.serve, pay: tab.can.pay, void: tab.can.void, open },
  };
  const bind = <A extends unknown[], R>(fn: (orgSlug: string, ...args: A) => R) =>
    fn.bind(null, orgSlug) as (...args: A) => R;
  return (
    <div className="space-y-4">
      <AutoRefresh seconds={20} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">
            {tab.table ? t("pos.tableTitle", { code: tab.table.code }) : <bdi>{tab.label}</bdi>}
            <span className="text-muted ms-2 text-sm font-normal">
              <span className="ltr-value">{tab.number}</span> ·{" "}
              {t("pos.guestsCount", { count: tab.guests })} ·{" "}
              {format.dateTime(tab.openedAt, {
                timeStyle: "short",
                timeZone: tab.branch.timeZone ?? ctx.timeZone,
              })}
            </span>
          </h1>
          {!open ? <Badge tone="muted">{t(`pos.checkStatuses.${tab.status}`)}</Badge> : null}
        </div>
        <LinkButton href={`/o/${orgSlug}/pos/floor`} variant="secondary">
          {t("pos.floorPlan")}
        </LinkButton>
      </div>
      <CheckScreen
        orgSlug={orgSlug}
        check={check}
        menu={menu}
        actions={{
          addLines: bind(addLinesAction).bind(null, tab.id),
          updateLine: bind(updateLineAction),
          removeLine: bind(removeLineAction),
          send: bind(sendAction).bind(null, tab.id),
          voidLine: bind(voidLineAction),
          move: bind(moveAction).bind(null, tab.id),
          merge: bind(mergeAction).bind(null, tab.id),
          cancel: bind(cancelAction).bind(null, tab.id),
          pay: bind(payAction).bind(null, tab.id),
        }}
      />
    </div>
  );
}
