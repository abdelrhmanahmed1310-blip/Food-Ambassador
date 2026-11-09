import { getTranslations } from "next-intl/server";
import { NutritionTabs } from "@/components/nutrition/engine-view";

const TABS = ["", "foods", "usda", "nutrients", "quality", "sources"] as const;

/** Tabs across the nutrition section (ADR-132). */
export async function Tabs({
  orgSlug,
  current,
}: {
  orgSlug: string;
  current: (typeof TABS)[number];
}) {
  const t = await getTranslations("nutritionEngine.tabs");
  return (
    <NutritionTabs
      base={`/o/${orgSlug}/nutrition`}
      current={current}
      items={TABS.map((key) => ({ key, label: t(key || "dashboard") }))}
    />
  );
}
