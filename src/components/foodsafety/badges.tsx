import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";

export async function SpecBadge({ inSpec }: { inSpec: boolean }) {
  const t = await getTranslations("foodSafety");
  return (
    <Badge tone={inSpec ? "success" : "danger"}>{inSpec ? t("inSpec") : t("outOfSpec")}</Badge>
  );
}

export async function NcStatusBadge({
  status,
}: {
  status: "OPEN" | "INVESTIGATING" | "ACTION_PLANNED" | "CLOSED";
}) {
  const t = await getTranslations("foodSafety.ncStatuses");
  return (
    <Badge tone={status === "CLOSED" ? "muted" : status === "OPEN" ? "danger" : "warning"}>
      {t(status)}
    </Badge>
  );
}

export async function SeverityBadge({
  severity,
}: {
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}) {
  const t = await getTranslations("foodSafety.severities");
  return (
    <Badge
      tone={
        severity === "HIGH" || severity === "CRITICAL"
          ? "danger"
          : severity === "MEDIUM"
            ? "warning"
            : "neutral"
      }
    >
      {t(severity)}
    </Badge>
  );
}
