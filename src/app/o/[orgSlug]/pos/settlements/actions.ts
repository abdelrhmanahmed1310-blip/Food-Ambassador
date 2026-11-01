"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { importSettlement } from "@/modules/pos/settlements";
import { tenantMutation } from "@/server/actions/tenant";

const MAX_BYTES = 2 * 1024 * 1024;

export async function importSettlementAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES)
    return { ok: false, seq: (previous.seq ?? 0) + 1, formError: t("import.fileRequired") };
  const text = await file.text();
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await importSettlement(ctx, { fileName: file.name, text });
    return { message: t("settlements.imported", r) };
  });
}
