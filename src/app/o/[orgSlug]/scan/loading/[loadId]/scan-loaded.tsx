"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm } from "@/components/forms/fields";
import { ScanInput } from "@/components/scan/scan-input";

/** One scan per unit; the field is ready again after each. */
export function ActionFormScan({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const t = useTranslations("scan");
  return (
    <ActionForm action={action} submitLabel={t("check")} pendingLabel={t("saving")}>
      <ScanInput name="unit" label={t("scanUnit")} />
    </ActionForm>
  );
}
