import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";

export async function HaccpStatusBadge({
  status,
}: {
  status: "DRAFT" | "APPROVED" | "SUPERSEDED";
}) {
  const t = await getTranslations("haccp.statuses");
  return (
    <Badge tone={status === "APPROVED" ? "success" : status === "DRAFT" ? "warning" : "muted"}>
      {t(status)}
    </Badge>
  );
}

export async function ClassBadge({ value }: { value: "CCP" | "OPRP" | "PRP" }) {
  return (
    <Badge tone={value === "CCP" ? "danger" : value === "OPRP" ? "warning" : "neutral"}>
      {value}
    </Badge>
  );
}
