import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";

/** Status of a mock recall, and for a completed one whether it passed (ADR-100). */
export async function MockRecallBadge({
  status,
  passed,
}: {
  status: "RUNNING" | "COMPLETED" | "CANCELLED";
  passed: boolean | null;
}) {
  const t = await getTranslations("mockRecalls");
  if (status === "COMPLETED")
    return passed ? (
      <Badge tone="success">{t("passed")}</Badge>
    ) : (
      <Badge tone="danger">{t("notPassed")}</Badge>
    );
  return <Badge tone={status === "RUNNING" ? "warning" : "muted"}>{t(`statuses.${status}`)}</Badge>;
}
