import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/pos/auto-refresh";
import { guestOrderStatus } from "@/modules/pos/ordering";

export const dynamic = "force-dynamic";

const STEPS = ["RECEIVED", "PREPARING", "READY", "COLLECTED"] as const;
const STEP_OF: Record<string, number> = {
  AWAITING_PAYMENT: -1,
  RECEIVED: 0,
  SCHEDULED: 0,
  PREPARING: 1,
  READY: 2,
  COLLECTED: 3,
};

/**
 * The guest follows their order (ADR-070, ADR-071); the address is the
 * guest's own. Returning here from the payment page checks the payment with
 * the provider (never trusting the return itself).
 */
export default async function OrderStatusPage({ params }: PageProps<"/order/status/[guestToken]">) {
  const { guestToken } = await params;
  const s = await guestOrderStatus(guestToken);
  if (!s) notFound();
  const t = await getTranslations("ordering");
  const step = STEP_OF[s.state] ?? -1;
  const pickup = s.pickupAt
    ? new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: s.timeZone,
      }).format(s.pickupAt)
    : null;
  return (
    <main className="mx-auto w-full max-w-lg space-y-4 p-4">
      {s.state === "COLLECTED" || s.state === "CANCELLED" ? null : <AutoRefresh seconds={15} />}
      <header>
        <h1 className="text-2xl font-semibold">{s.organizationName}</h1>
        <p className="text-muted">{s.branchName}</p>
      </header>
      <p className="text-3xl font-bold">{s.number}</p>
      {pickup ? <p className="font-medium">{t("pickupAt", { time: pickup })}</p> : null}
      {s.state === "CANCELLED" ? (
        <p role="status" className="text-danger" data-testid="guest-order-state">
          {t("states.CANCELLED")}
          {s.cancelReason ? `: ${s.cancelReason}` : ""}
        </p>
      ) : (
        <>
          <p role="status" className="text-xl" data-testid="guest-order-state">
            {t(`states.${s.state}`)}
          </p>
          {s.state === "AWAITING_PAYMENT" && s.paymentUrl ? (
            <a
              href={s.paymentUrl}
              className="bg-primary text-primary-foreground inline-block rounded-md px-4 py-2"
            >
              {t("payNow")}
            </a>
          ) : null}
          <ol className="flex gap-2 text-sm">
            {STEPS.map((st, i) => (
              <li
                key={st}
                className={`flex-1 rounded px-2 py-1 text-center ${i <= step ? "bg-primary text-primary-foreground" : "bg-surface border-border border"}`}
              >
                {t(`steps.${st}`)}
              </li>
            ))}
          </ol>
        </>
      )}
      <ul className="text-sm">
        {s.items.map((i, n) => (
          <li key={n}>
            {i.quantity} × <bdi>{i.name}</bdi>
          </li>
        ))}
      </ul>
      <p className="text-muted text-sm">{s.payOnline ? t("paidOnlineNote") : t("payAtCounter")}</p>
    </main>
  );
}
