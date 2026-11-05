"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

export function OnboardingTemplateForm({ action }: { action: Action }) {
  const t = useTranslations("onboarding");
  return (
    <ActionForm action={action} submitLabel={t("createTemplate")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="code" label={t("code")} required />
        <TextField name="name" label={t("name")} required />
      </div>
    </ActionForm>
  );
}

export function TemplateTaskForm({ action }: { action: Action }) {
  const t = useTranslations("onboarding");
  return (
    <ActionForm action={action} submitLabel={t("addTask")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="title" label={t("taskTitle")} required />
        <TextField
          name="dueDays"
          label={t("dueDays")}
          hint={t("dueDaysHint")}
          inputMode="numeric"
          defaultValue="0"
          required
        />
        <SelectField
          name="assignee"
          label={t("for")}
          options={["HR", "MANAGER", "EMPLOYEE"].map((v) => ({
            value: v,
            label: t(`assignees.${v}`),
          }))}
        />
      </div>
    </ActionForm>
  );
}

export function StartOnboardingForm({
  action,
  templates,
}: {
  action: Action;
  templates: Option[];
}) {
  const t = useTranslations("onboarding");
  return (
    <ActionForm action={action} submitLabel={t("start")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="templateId" label={t("checklist")} options={templates} required />
        <TextField name="startedOn" type="date" label={t("startedOn")} hint={t("startedOnHint")} />
      </div>
    </ActionForm>
  );
}

export function CancelChecklistForm({ action }: { action: Action }) {
  const t = useTranslations("onboarding");
  return (
    <ActionForm
      action={action}
      submitLabel={t("cancel")}
      pendingLabel={t("working")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-2"
    >
      <TextField name="reason" label={t("reason")} required />
    </ActionForm>
  );
}
