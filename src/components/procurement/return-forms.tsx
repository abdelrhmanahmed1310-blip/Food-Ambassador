"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export const RETURN_REASONS = [
  "QUALITY",
  "DAMAGED",
  "EXPIRED",
  "WRONG_ITEM",
  "RECALL",
  "OVERSUPPLY",
  "OTHER",
] as const;

/** Start a supplier return from a posted receipt (ADR-094). */
export function NewReturnForm({
  action,
  receipts,
  receiptId,
}: {
  action: Action;
  receipts: Option[];
  receiptId?: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.create")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="receiptId"
          label={t("returns.fromReceipt")}
          options={receipts}
          defaultValue={receiptId}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="reason"
          label={t("returns.reason")}
          options={RETURN_REASONS.map((r) => ({ value: r, label: t(`returns.reasons.${r}`) }))}
          placeholder={t("common.select")}
          required
        />
        <div className="sm:col-span-2">
          <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
        </div>
      </div>
    </ActionForm>
  );
}

/** Add one receipt line to the return: how much, and from available stock or quarantine. */
export function ReturnLineForm({
  action,
  receiptLineId,
  unit,
  remaining,
  quarantine,
}: {
  action: Action;
  receiptLineId: string;
  unit: string;
  remaining: string;
  quarantine: boolean;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("returns.addLine")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-3"
    >
      <input type="hidden" name="receiptLineId" value={receiptLineId} />
      <div className="w-32">
        <TextField
          name="quantity"
          label={`${t("common.quantity")} (${unit})`}
          defaultValue={remaining}
          inputMode="decimal"
          dir="ltr"
          required
        />
      </div>
      <div className="w-40">
        <SelectField
          name="fromStatus"
          label={t("returns.takeFrom")}
          defaultValue={quarantine ? "QUARANTINE" : "AVAILABLE"}
          options={[
            { value: "AVAILABLE", label: t("returns.fromAvailable") },
            { value: "QUARANTINE", label: t("returns.fromQuarantine") },
          ]}
        />
      </div>
    </ActionForm>
  );
}

export function LinkCreditNoteForm({
  action,
  creditNotes,
}: {
  action: Action;
  creditNotes: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("returns.linkCredit")}
      pendingLabel={t("common.saving")}
      className="flex flex-wrap items-end gap-3"
    >
      <div className="min-w-64">
        <SelectField
          name="creditNoteId"
          label={t("returns.creditNote")}
          options={creditNotes}
          placeholder={t("common.select")}
          required
        />
      </div>
    </ActionForm>
  );
}
