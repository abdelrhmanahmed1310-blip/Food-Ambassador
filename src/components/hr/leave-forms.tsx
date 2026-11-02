"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

export function LeaveRequestForm({
  action,
  types,
  submitLabel,
}: {
  action: Action;
  types: Option[];
  submitLabel?: string;
}) {
  const t = useTranslations("leave");
  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel ?? t("request")}
      pendingLabel={t("saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="leaveTypeId"
          label={t("type")}
          options={types}
          placeholder="—"
          required
        />
        <TextField name="reason" label={t("reason")} optionalLabel={t("optional")} />
        <TextField name="startDate" type="date" label={t("from")} required />
        <TextField name="endDate" type="date" label={t("to")} required />
      </div>
    </ActionForm>
  );
}

export function AllocationForm({
  action,
  types,
  year,
}: {
  action: Action;
  types: Option[];
  year: number;
}) {
  const t = useTranslations("leave");
  return (
    <ActionForm
      action={action}
      submitLabel={t("setEntitlement")}
      pendingLabel={t("saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="leaveTypeId"
          label={t("type")}
          options={types}
          placeholder="—"
          required
        />
        <TextField
          name="year"
          label={t("year")}
          defaultValue={String(year)}
          inputMode="numeric"
          dir="ltr"
          required
        />
        <TextField
          name="days"
          label={t("days")}
          hint={t("daysHint")}
          inputMode="decimal"
          dir="ltr"
          required
        />
      </div>
    </ActionForm>
  );
}

export function LeaveTypeForm({ action }: { action: Action }) {
  const t = useTranslations("leave");
  return (
    <ActionForm action={action} submitLabel={t("addType")} pendingLabel={t("saving")} idempotent>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="code" label={t("code")} dir="ltr" required />
        <TextField name="name" label={t("name")} required />
        <TextField name="nameAr" label={t("nameAr")} dir="rtl" optionalLabel={t("optional")} />
        <TextField
          name="country"
          label={t("country")}
          hint={t("countryHint")}
          dir="ltr"
          optionalLabel={t("optional")}
        />
        <CheckboxField name="paid" label={t("paid")} defaultChecked />
        <CheckboxField name="usesBalance" label={t("usesBalance")} defaultChecked />
      </div>
    </ActionForm>
  );
}
