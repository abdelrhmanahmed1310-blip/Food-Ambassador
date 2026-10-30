import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import type { PoStatus, RequisitionStatus } from "@/modules/procurement/rules";

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

export async function RequisitionStatusBadge({ status }: { status: RequisitionStatus }) {
  const t = await getTranslations("requisitions.statuses");
  const tone =
    status === "ORDERED"
      ? "success"
      : status === "SUBMITTED" || status === "PARTIALLY_ORDERED"
        ? "warning"
        : status === "DRAFT"
          ? "neutral"
          : "muted";
  return <Badge tone={tone}>{t(status)}</Badge>;
}
