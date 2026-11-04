"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { inspectReceiptLine } from "@/modules/wms/inspections";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function inspectAction(
  orgSlug: string,
  receiptLineId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("inspections");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await inspectReceiptLine(ctx, receiptLineId, formValues(formData));
    return { message: t(`decisionMessages.${r.decision}`, { number: r.document.number }) };
  });
}
