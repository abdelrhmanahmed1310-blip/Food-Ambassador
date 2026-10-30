import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";

export async function RecallStatusBadge({ status }: { status: "DRAFT" | "ACTIVE" | "CLOSED" }) {
  const t = await getTranslations("recalls.statuses");
  return (
    <Badge tone={status === "ACTIVE" ? "danger" : status === "DRAFT" ? "neutral" : "muted"}>
      {t(status)}
    </Badge>
  );
}
