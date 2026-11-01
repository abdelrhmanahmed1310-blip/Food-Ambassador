import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmActionButton } from "@/components/forms/confirm-button";
import { AutoRefresh } from "@/components/pos/auto-refresh";
import { RejectGuestForm } from "@/components/pos/ordering-forms";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui/primitives";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { listGuestOrders } from "@/modules/pos/ordering";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { acceptGuestAction, rejectGuestAction } from "./actions";

const TONE = { NEW: "warning", PREPARING: "neutral", READY: "success" } as const;

/** Orders guests placed online or at a kiosk, to accept and follow (ADR-070). */
export default async function OnlineOrdersPage({ params }: PageProps<"/o/[orgSlug]/pos/online">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "pos.tables")) notFound();
  const [t, format, orders] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listGuestOrders(ctx),
  ]);
  const when = (d: Date) => format.dateTime(d, { timeStyle: "short", timeZone: ctx.timeZone });
  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader
        title={t("ordering.staffTitle")}
        description={t("ordering.staffIntro")}
        actions={
          hasPermission(ctx.grants, "pos.manage") ? (
            <LinkButton href={`/o/${orgSlug}/pos/online/setup`} variant="secondary">
              {t("ordering.setup")}
            </LinkButton>
          ) : null
        }
      />
      <Card>
        {orders.length === 0 ? (
          <p className="text-muted text-sm">{t("ordering.noneOpen")}</p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {orders.map((o) => (
              <li
                key={o.id}
                className="border-border bg-surface space-y-2 rounded-lg border p-4"
                data-testid="guest-order"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">
                    <Link
                      href={`/o/${orgSlug}/pos/tabs/${o.id}`}
                      className="text-primary hover:underline"
                    >
                      {o.number}
                    </Link>{" "}
                    · <bdi>{o.guestName}</bdi>
                    {o.guestPhone ? (
                      <span className="ltr-value text-muted font-normal"> · {o.guestPhone}</span>
                    ) : null}
                  </p>
                  <Badge tone={TONE[o.state]}>{t(`ordering.staffStates.${o.state}`)}</Badge>
                </div>
                <p className="text-muted text-sm">
                  {t(`ordering.kinds.${o.source}`)} · {o.channelName} ·{" "}
                  {t(`ordering.channels.${o.channel}`)} · {when(o.openedAt)}
                </p>
                <ul className="text-sm">
                  {o.items.map((i, n) => (
                    <li key={n}>
                      {i.quantity} × <bdi>{i.name}</bdi>
                      {i.note ? <span className="text-muted"> — {i.note}</span> : null}
                    </li>
                  ))}
                </ul>
                {o.state === "NEW" ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <ConfirmActionButton
                      action={acceptGuestAction.bind(null, orgSlug, o.id)}
                      label={t("ordering.accept")}
                      variant="primary"
                    />
                    <RejectGuestForm action={rejectGuestAction.bind(null, orgSlug, o.id)} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
