import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import type { DueState } from "@/modules/foodsafety/equipment-rules";

export async function DueBadge({ state, date }: { state: DueState; date: string | null }) {
  const t = await getTranslations("equipment");
  if (state === "NOT_PLANNED") return <span className="text-muted text-xs">{t("notPlanned")}</span>;
  return (
    <Badge tone={state === "OVERDUE" ? "danger" : state === "DUE_SOON" ? "warning" : "success"}>
      <span className="ltr-value">{date}</span>
      {state === "OVERDUE" ? ` · ${t("overdue")}` : ""}
    </Badge>
  );
}

export async function EquipmentStatusBadge({
  status,
}: {
  status: "ACTIVE" | "OUT_OF_SERVICE" | "RETIRED";
}) {
  const t = await getTranslations("equipment.statuses");
  return (
    <Badge
      tone={status === "ACTIVE" ? "success" : status === "OUT_OF_SERVICE" ? "danger" : "muted"}
    >
      {t(status)}
    </Badge>
  );
}
