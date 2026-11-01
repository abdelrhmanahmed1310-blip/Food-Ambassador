import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/pos/auto-refresh";
import { guestOrderStatus } from "@/modules/pos/ordering";

export const dynamic = "force-dynamic";

const STEPS = ["RECEIVED", "PREPARING", "READY", "COLLECTED"] as const;

/** The guest follows their order (ADR-070); the address is the guest's own. */
export default async function OrderStatusPage({ params }: PageProps<"/order/status/[guestToken]">) {
  const { guestToken } = await params;
  const s = await guestOrderStatus(guestToken);
  if (!s) notFound();
  const t = await getTranslations("ordering");
  const done = (step: (typeof STEPS)[number]) =>
    STEPS.indexOf(step) <= STEPS.indexOf(s.state as never);
  return (
    <main className="mx-auto w-full max-w-lg space-y-4 p-4">
      {s.state === "COLLECTED" || s.state === "CANCELLED" ? null : <AutoRefresh seconds={15} />}
      <header>
        <h1 className="text-2xl font-semibold">{s.organizationName}</h1>
        <p className="text-muted">{s.branchName}</p>
      </header>
      <p className="text-3xl font-bold">{s.number}</p>
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
          <ol className="flex gap-2 text-sm">
            {STEPS.map((step) => (
              <li
                key={step}
                className={`flex-1 rounded px-2 py-1 text-center ${done(step) ? "bg-primary text-primary-foreground" : "bg-surface border-border border"}`}
              >
                {t(`steps.${step}`)}
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
      <p className="text-muted text-sm">{t("payAtCounter")}</p>
    </main>
  );
}
