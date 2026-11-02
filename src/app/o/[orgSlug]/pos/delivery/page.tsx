import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { AutoRefresh } from "@/components/pos/auto-refresh";
import { RejectForm } from "@/components/pos/delivery-forms";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui/primitives";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { listDeliveryOrders } from "@/modules/delivery/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { moneyFormatter } from "@/server/inventory-view";
import { acceptAction, rejectAction } from "./actions";

const TONE = {
  PENDING: "warning",
  NEEDS_MAPPING: "danger",
  ACCEPTED: "success",
  REJECTED: "muted",
  CANCELLED: "muted",
} as const;

/** Orders from delivery platforms waiting for the branch, and what happened to them (ADR-069). */
export default async function DeliveryOrdersPage({
  params,
}: PageProps<"/o/[orgSlug]/pos/delivery">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "pos.sell")) notFound();
  const [t, format, money, orders] = await Promise.all([
    getTranslations(),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency),
    listDeliveryOrders(ctx),
  ]);
  const setUp =
    hasPermission(ctx.grants, "integrations.manage") || hasPermission(ctx.grants, "menu.manage");
  const payouts =
    hasPermission(ctx.grants, "payments.manage") || hasPermission(ctx.grants, "invoices.view");
  const open = orders.filter((o) => o.status === "PENDING" || o.status === "NEEDS_MAPPING");
  const done = orders.filter((o) => !open.includes(o));
  const when = (d: Date) =>
    format.dateTime(d, { timeStyle: "short", dateStyle: "short", timeZone: ctx.timeZone });
  const card = (o: (typeof orders)[number]) => (
    <li
      key={o.id}
      className="border-border bg-surface space-y-2 rounded-lg border p-4"
      data-testid="delivery-order"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          {t(`delivery.platforms.${o.platform}`)}{" "}
          <span className="ltr-value">{o.displayCode ?? o.externalId}</span>
          {o.customerName ? (
            <span className="text-muted font-normal">
              {" "}
              · <bdi>{o.customerName}</bdi>
            </span>
          ) : null}
        </p>
        <Badge tone={TONE[o.status]}>{t(`delivery.statuses.${o.status}`)}</Badge>
      </div>
      <ul className="text-sm">
        {o.payload.items.map((i, n) => (
          <li key={n}>
            {i.quantity} × <bdi>{i.name ?? i.externalId}</bdi>
            {i.modifiers.length > 0 ? (
              <span className="text-muted">
                {" "}
                ({i.modifiers.map((m) => m.name ?? m.externalId).join(", ")})
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-sm">
        {t("pos.total")}{" "}
        <span className="ltr-value font-semibold tabular-nums">{money.money(o.total)}</span> ·{" "}
        {when(o.receivedAt)} · {o.connector.name}
      </p>
      {o.problem ? (
        <p className="text-danger text-sm" role="status">
          {o.problem.startsWith("VOID_NEEDED")
            ? t("delivery.voidNeeded")
            : t.has(`rules.${o.problem}`)
              ? t(`rules.${o.problem}`, {
                  items: "",
                  options: "",
                  total: "",
                  minimum: "",
                  balance: "",
                })
              : o.problem}
        </p>
      ) : null}
      {o.posOrder ? (
        <Link
          href={`/o/${orgSlug}/pos/orders/${o.posOrder.id}`}
          className="text-primary text-sm hover:underline"
        >
          {o.posOrder.number}
        </Link>
      ) : null}
      {o.status === "PENDING" ? (
        <div className="flex flex-wrap items-end gap-3">
          <ConfirmActionButton
            action={acceptAction.bind(null, orgSlug, o.id)}
            label={t("delivery.accept")}
            variant="primary"
          />
          <RejectForm action={rejectAction.bind(null, orgSlug, o.id)} />
        </div>
      ) : null}
      {o.status === "NEEDS_MAPPING" ? (
        <div className="flex flex-wrap items-end gap-3">
          {setUp ? (
            <Link
              href={`/o/${orgSlug}/pos/delivery/setup/${o.connectorId}`}
              className="text-primary text-sm underline"
            >
              {t("delivery.mapItems")}
            </Link>
          ) : (
            <p className="text-muted text-sm">{t("delivery.askManagerToMap")}</p>
          )}
          <RejectForm action={rejectAction.bind(null, orgSlug, o.id)} />
        </div>
      ) : null}
    </li>
  );
  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader
        title={t("delivery.title")}
        description={t("delivery.intro")}
        actions={
          <>
            {payouts ? (
              <LinkButton href={`/o/${orgSlug}/pos/delivery/payouts`} variant="secondary">
                {t("delivery.payoutsLink")}
              </LinkButton>
            ) : null}
            {setUp ? (
              <LinkButton href={`/o/${orgSlug}/pos/delivery/setup`} variant="secondary">
                {t("delivery.setup")}
              </LinkButton>
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        <Card title={t("delivery.waiting", { count: open.length })}>
          {open.length === 0 ? (
            <p className="text-muted text-sm">{t("delivery.noneWaiting")}</p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">{open.map(card)}</ul>
          )}
        </Card>
        <Card title={t("delivery.recent")}>
          {done.length === 0 ? (
            <p className="text-muted text-sm">{t("delivery.noneYet")}</p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">{done.map(card)}</ul>
          )}
        </Card>
      </div>
    </>
  );
}
