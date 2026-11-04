import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";

const TONES = {
  PLANNED: "warning",
  PICKED: "neutral",
  DELIVERED: "success",
  CANCELLED: "muted",
} as const;

export async function PickStatusBadge({ status }: { status: keyof typeof TONES }) {
  const t = await getTranslations("picking");
  return <Badge tone={TONES[status]}>{t(`statuses.${status}`)}</Badge>;
}
