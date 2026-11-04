"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { setBudgetLine } from "@/modules/finance/budgets";
import { tenantMutation } from "@/server/actions/tenant";

/** "m.MM" inputs → { months: { MM: amount } } for one branch, year and line. */
export async function setBudgetLineAction(
  orgSlug: string,
  branchId: string,
  year: number,
  line: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  const months: Record<string, string> = {};
  for (const [key, value] of formData.entries())
    if (/^m\.(0[1-9]|1[0-2])$/.test(key) && typeof value === "string") months[key.slice(2)] = value;
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setBudgetLine(ctx, { branchId, year, line, months });
    return { message: t("savedSuccessfully") };
  });
}
