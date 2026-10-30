import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import type { FoodCostStatus } from "@/modules/recipes/pricing";

const TONE = {
  OK: "success",
  ABOVE_TARGET: "danger",
  INCOMPLETE: "warning",
  NO_PRICE: "neutral",
  NO_TARGET: "neutral",
} as const;

export async function FoodCostBadge({ status }: { status: FoodCostStatus }) {
  const t = await getTranslations("recipes.foodCostStatuses");
  return <Badge tone={TONE[status]}>{t(status)}</Badge>;
}
