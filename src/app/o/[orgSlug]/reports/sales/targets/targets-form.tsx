"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, TextField } from "@/components/forms/fields";

/** One branch's twelve monthly targets; empty clears a month. */
export function TargetsForm({
  action,
  values,
  currency,
  disabled,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  values: Record<string, string>;
  currency: string;
  disabled: boolean;
}) {
  const t = useTranslations("salesReport");
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
  return (
    <ActionForm action={action} submitLabel={t("saveTargets")} hideSubmit={disabled}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {months.map((mm) => (
          <TextField
            key={mm}
            name={`m.${mm}`}
            label={`${t(`months.${mm}`)} (${currency})`}
            defaultValue={values[mm] ?? ""}
            inputMode="decimal"
            dir="ltr"
            disabled={disabled}
          />
        ))}
      </div>
    </ActionForm>
  );
}
