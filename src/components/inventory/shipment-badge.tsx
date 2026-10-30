import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";

export type ShipmentStatus = "DRAFT" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED";

export async function ShipmentStatusBadge({ status }: { status: ShipmentStatus }) {
  const t = await getTranslations("shipments.statuses");
  const tone =
    status === "RECEIVED"
      ? "success"
      : status === "IN_TRANSIT"
        ? "warning"
        : status === "DRAFT"
          ? "neutral"
          : "muted";
  return <Badge tone={tone}>{t(status)}</Badge>;
}
