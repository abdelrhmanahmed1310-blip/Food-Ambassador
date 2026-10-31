"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import type { ApprovalDocument } from "@/modules/approvals/rules";
import { updateApprovalMatrix } from "@/modules/approvals/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function updateApprovalMatrixAction(
  orgSlug: string,
  document: ApprovalDocument,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateApprovalMatrix(ctx, document, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}
