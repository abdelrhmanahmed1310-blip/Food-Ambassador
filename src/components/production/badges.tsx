import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";

export async function ProductionStatusBadge({
  status,
}: {
  status: "PLANNED" | "COMPLETED" | "REVERSED" | "CANCELLED";
}) {
  const t = await getTranslations("production.statuses");
  const tone = status === "COMPLETED" ? "success" : status === "PLANNED" ? "warning" : "muted";
  return <Badge tone={tone}>{t(status)}</Badge>;
}
