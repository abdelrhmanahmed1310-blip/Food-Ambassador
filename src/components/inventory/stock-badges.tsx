import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import type { ExpiryState, StockStatus } from "@/modules/inventory/rules";

export async function StatusBadge({ status }: { status: StockStatus }) {
  const t = await getTranslations("inventory.statuses");
  const tone =
    status === "AVAILABLE"
      ? "success"
      : status === "QUARANTINE" || status === "ON_HOLD"
        ? "warning"
        : "muted";
  return <Badge tone={tone}>{t(status)}</Badge>;
}

export async function ExpiryBadge({ state, date }: { state: ExpiryState; date: string | null }) {
  const t = await getTranslations("inventory.expiryStates");
  if (state === "NONE" || !date) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="ltr-value tabular-nums">{date}</span>
      {state !== "OK" ? (
        <Badge tone={state === "EXPIRED" ? "warning" : "neutral"}>{t(state)}</Badge>
      ) : null}
    </span>
  );
}
