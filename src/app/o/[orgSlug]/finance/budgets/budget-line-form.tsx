"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, TextField } from "@/components/forms/fields";

/** One budget line's twelve months; empty clears a month. */
export function BudgetLineForm({
  action,
  values,
  currency,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  values: Record<string, string>;
  currency: string;
}) {
  const t = useTranslations();
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
  return (
    <ActionForm action={action} submitLabel={t("budgets.saveLine")}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {months.map((mm) => (
          <TextField
            key={mm}
            name={`m.${mm}`}
            label={`${t(`salesReport.months.${mm}`)} (${currency})`}
            defaultValue={values[mm] ?? ""}
            inputMode="decimal"
            dir="ltr"
          />
        ))}
      </div>
    </ActionForm>
  );
}
