import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import type { PoStatus } from "@/modules/procurement/rules";

export async function OrderStatusBadge({ status }: { status: PoStatus }) {
  const t = await getTranslations("purchasing.statuses");
  const tone =
    status === "RECEIVED" || status === "APPROVED"
      ? "success"
      : status === "PENDING_APPROVAL" || status === "PARTIALLY_RECEIVED"
        ? "warning"
        : status === "DRAFT"
          ? "neutral"
          : "muted";
  return <Badge tone={tone}>{t(status)}</Badge>;
}

export async function ReceiptStatusBadge({ status }: { status: "POSTED" | "REVERSED" }) {
  const t = await getTranslations("purchasing.receiptStatuses");
  return <Badge tone={status === "POSTED" ? "success" : "muted"}>{t(status)}</Badge>;
}
