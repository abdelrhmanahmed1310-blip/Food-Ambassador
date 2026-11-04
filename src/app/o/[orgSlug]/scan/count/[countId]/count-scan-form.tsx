"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, TextField } from "@/components/forms/fields";

/** What was counted for the scanned product (one field per matching line). */
export function CountScanForm({
  action,
  lines,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  lines: Array<{ id: string; label: string; unit: string; counted: string }>;
}) {
  const t = useTranslations("scan");
  return (
    <ActionForm action={action} submitLabel={t("saveCount")} pendingLabel={t("saving")}>
      {lines.map((l, i) => (
        <TextField
          key={l.id}
          name={`line:${l.id}`}
          label={`${l.label} (${l.unit})`}
          defaultValue={l.counted}
          inputMode="decimal"
          dir="ltr"
          required={i === 0}
        />
      ))}
    </ActionForm>
  );
}
