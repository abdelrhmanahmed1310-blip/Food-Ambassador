"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

export function ShiftForm({
  action,
  branchId,
  employees,
  days,
  templates,
}: {
  action: Action;
  branchId: string;
  employees: Option[];
  days: Option[];
  templates: Option[];
}) {
  const t = useTranslations("rosters");
  return (
    <ActionForm action={action} submitLabel={t("addShift")} pendingLabel={t("working")}>
      <input type="hidden" name="branchId" value={branchId} />
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField name="employeeId" label={t("employee")} options={employees} required />
        <SelectField name="day" label={t("day")} options={days} required />
        <SelectField
          name="templateId"
          label={t("shift")}
          options={templates}
          placeholder={t("customTimes")}
        />
        <TextField name="startTime" type="time" label={t("start")} hint={t("customHint")} />
        <TextField name="endTime" type="time" label={t("end")} />
        <TextField name="breakMinutes" label={t("breakMinutes")} inputMode="numeric" />
      </div>
      <TextField name="note" label={t("note")} />
    </ActionForm>
  );
}

export function ShiftTemplateForm({ action }: { action: Action }) {
  const t = useTranslations("rosters");
  return (
    <ActionForm action={action} submitLabel={t("addTemplate")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-5">
        <TextField name="code" label={t("code")} required />
        <TextField name="name" label={t("name")} required />
        <TextField name="startTime" type="time" label={t("start")} required />
        <TextField name="endTime" type="time" label={t("end")} required />
        <TextField
          name="breakMinutes"
          label={t("breakMinutes")}
          inputMode="numeric"
          defaultValue="0"
          required
        />
      </div>
    </ActionForm>
  );
}

export interface SettingsValues {
  graceMinutes: string;
  overtimeMinimumMinutes: string;
  standardDailyHours: string;
  overtimeMultiplier: string;
  overtimeBase: string;
}

export function RosterSettingsForm({ action, values }: { action: Action; values: SettingsValues }) {
  const t = useTranslations("rosters");
  return (
    <ActionForm action={action} submitLabel={t("save")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="graceMinutes"
          label={t("graceMinutes")}
          hint={t("graceHint")}
          inputMode="numeric"
          defaultValue={values.graceMinutes}
          required
        />
        <TextField
          name="overtimeMinimumMinutes"
          label={t("overtimeMinimum")}
          hint={t("overtimeMinimumHint")}
          inputMode="numeric"
          defaultValue={values.overtimeMinimumMinutes}
          required
        />
        <TextField
          name="standardDailyHours"
          label={t("dailyHours")}
          hint={t("dailyHoursHint")}
          inputMode="decimal"
          defaultValue={values.standardDailyHours}
        />
        <TextField
          name="overtimeMultiplier"
          label={t("multiplier")}
          hint={t("multiplierHint")}
          inputMode="decimal"
          defaultValue={values.overtimeMultiplier}
        />
        <SelectField
          name="overtimeBase"
          label={t("overtimeBase")}
          defaultValue={values.overtimeBase}
          placeholder={t("notSet")}
          options={["BASIC", "GROSS"].map((v) => ({ value: v, label: t(`bases.${v}`) }))}
        />
      </div>
    </ActionForm>
  );
}

export function ReasonForm({ action, label }: { action: Action; label: string }) {
  const t = useTranslations("rosters");
  return (
    <ActionForm
      action={action}
      submitLabel={label}
      pendingLabel={t("working")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-2"
    >
      <TextField name="reason" label={t("reason")} required />
    </ActionForm>
  );
}

export function OvertimeForm({ action, measured }: { action: Action; measured: number }) {
  const t = useTranslations("rosters");
  return (
    <ActionForm action={action} submitLabel={t("decide")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="decision"
          label={t("decision")}
          options={[
            { value: "APPROVE", label: t("approve") },
            { value: "REJECT", label: t("reject") },
          ]}
        />
        <TextField
          name="minutes"
          label={t("minutesToApprove")}
          hint={t("minutesHint", { measured })}
          inputMode="numeric"
          defaultValue={String(measured)}
        />
        <TextField name="note" label={t("note")} />
      </div>
    </ActionForm>
  );
}

export function CopyWeekForm({ action, weeks }: { action: Action; weeks: Option[] }) {
  const t = useTranslations("rosters");
  return (
    <ActionForm
      action={action}
      submitLabel={t("copy")}
      pendingLabel={t("working")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-2"
    >
      <SelectField name="fromWeek" label={t("copyFrom")} options={weeks} />
    </ActionForm>
  );
}
