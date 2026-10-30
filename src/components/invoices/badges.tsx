import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";

export async function InvoiceStatusBadge({ status }: { status: "DRAFT" | "POSTED" | "CANCELLED" }) {
  const t = await getTranslations("invoices.statuses");
  const tone = status === "POSTED" ? "success" : status === "DRAFT" ? "neutral" : "muted";
  return <Badge tone={tone}>{t(status)}</Badge>;
}

export async function MatchBadge({ status }: { status: "MATCHED" | "EXCEPTION" }) {
  const t = await getTranslations("invoices.matchStatuses");
  return <Badge tone={status === "MATCHED" ? "success" : "warning"}>{t(status)}</Badge>;
}

export async function LineMatchBadge({
  match,
}: {
  match:
    "MATCHED" | "PRICE_VARIANCE" | "QUANTITY_VARIANCE" | "PRICE_AND_QUANTITY" | "NOT_APPLICABLE";
}) {
  const t = await getTranslations("invoices.lineMatches");
  const tone = match === "MATCHED" ? "success" : match === "NOT_APPLICABLE" ? "muted" : "warning";
  return <Badge tone={tone}>{t(match)}</Badge>;
}

export async function PaymentStatusBadge({ status }: { status: "OPEN" | "PARTLY_PAID" | "PAID" }) {
  const t = await getTranslations("payables.paymentStatuses");
  const tone = status === "PAID" ? "success" : status === "PARTLY_PAID" ? "warning" : "neutral";
  return <Badge tone={tone}>{t(status)}</Badge>;
}
