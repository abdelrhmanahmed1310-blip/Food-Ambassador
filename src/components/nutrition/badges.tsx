import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";

export async function AllergenStatusBadge({
  status,
}: {
  status: "CONTAINS" | "MAY_CONTAIN" | "FREE_FROM" | "UNKNOWN";
}) {
  const t = await getTranslations("nutrition.statements");
  const tone =
    status === "CONTAINS"
      ? "danger"
      : status === "MAY_CONTAIN"
        ? "warning"
        : status === "FREE_FROM"
          ? "success"
          : "muted";
  return <Badge tone={tone}>{t(status)}</Badge>;
}

export async function LabelStatusBadge({
  status,
}: {
  status: "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "SUPERSEDED";
}) {
  const t = await getTranslations("nutrition.labelStatuses");
  const tone =
    status === "APPROVED" ? "success" : status === "PENDING_REVIEW" ? "warning" : "muted";
  return <Badge tone={tone}>{t(status)}</Badge>;
}
