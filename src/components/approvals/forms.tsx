"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Four layers: three branch, one head office; each with its own limit (ADR-049). */
export function ApprovalMatrixForm({
  action,
  currency,
  defaults,
  amountHint,
}: {
  action: Action;
  currency: string;
  defaults: Record<1 | 2 | 3 | 4, string>;
  amountHint: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <p className="text-muted text-sm">{amountHint}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {([1, 2, 3, 4] as const).map((p) => (
          <TextField
            key={p}
            name={`layer${p}`}
            label={p === 4 ? t("approvals.headOfficeLayer") : t("approvals.branchLayer", { n: p })}
            hint={t("approvals.requiredAbove", { currency })}
            defaultValue={defaults[p]}
            inputMode="decimal"
            dir="ltr"
            optionalLabel={t("approvals.notUsed")}
          />
        ))}
      </div>
    </ActionForm>
  );
}
