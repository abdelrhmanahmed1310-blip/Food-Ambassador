"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

function TextArea({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <textarea
        name={name}
        rows={3}
        maxLength={3000}
        defaultValue={defaultValue}
        className="border-border bg-surface w-full rounded-lg border p-2"
      />
    </label>
  );
}

function RatingSelect({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue?: string;
}) {
  const t = useTranslations("performance");
  return (
    <SelectField
      name={name}
      label={label}
      defaultValue={defaultValue ?? ""}
      placeholder="—"
      options={[1, 2, 3, 4, 5].map((r) => ({
        value: String(r),
        label: `${r} — ${t(`ratings.${r}`)}`,
      }))}
    />
  );
}

export function CycleForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations("performance");
  return (
    <ActionForm action={action} submitLabel={t("createCycle")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="name" label={t("cycleName")} required />
        <SelectField
          name="branchId"
          label={t("branch")}
          options={branches}
          placeholder={t("allBranches")}
        />
        <TextField name="periodStart" type="date" label={t("periodStart")} required />
        <TextField name="periodEnd" type="date" label={t("periodEnd")} required />
        <TextField name="selfDueOn" type="date" label={t("selfDueOn")} required />
        <TextField name="managerDueOn" type="date" label={t("managerDueOn")} required />
      </div>
    </ActionForm>
  );
}

export function GoalForm({ action, cycles }: { action: Action; cycles: Option[] }) {
  const t = useTranslations("performance");
  return (
    <ActionForm action={action} submitLabel={t("addGoal")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="title" label={t("goalTitle")} required />
        <SelectField
          name="cycleId"
          label={t("cycle")}
          options={cycles}
          placeholder={t("noCycle")}
        />
        <TextField
          name="weight"
          label={t("weight")}
          hint={t("weightHint")}
          inputMode="numeric"
          dir="ltr"
          defaultValue="0"
        />
        <TextField name="dueOn" type="date" label={t("dueOn")} />
      </div>
      <TextArea name="description" label={t("description")} />
    </ActionForm>
  );
}

export function GoalProgressForm({
  action,
  progress,
  status,
  canSetStatus,
}: {
  action: Action;
  progress: number;
  status: string;
  canSetStatus: boolean;
}) {
  const t = useTranslations("performance");
  return (
    <ActionForm
      action={action}
      submitLabel={t("save")}
      pendingLabel={t("working")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-2"
    >
      <TextField
        name="progress"
        label={t("progress")}
        defaultValue={String(progress)}
        inputMode="numeric"
        dir="ltr"
      />
      {canSetStatus ? (
        <SelectField
          name="status"
          label={t("outcome")}
          defaultValue={status}
          options={["OPEN", "ACHIEVED", "PARTLY_ACHIEVED", "MISSED", "CANCELLED"].map((s) => ({
            value: s,
            label: t(`goalStatuses.${s}`),
          }))}
        />
      ) : null}
    </ActionForm>
  );
}

export function SelfReviewForm({ action, goals }: { action: Action; goals: Option[] }) {
  const t = useTranslations("performance");
  return (
    <ActionForm action={action} submitLabel={t("submitSelf")} pendingLabel={t("working")}>
      {goals.map((g) => (
        <RatingSelect
          key={g.value}
          name={`rating.${g.value}`}
          label={t("rateGoal", { goal: g.label })}
        />
      ))}
      <TextArea name="comment" label={t("selfComment")} />
    </ActionForm>
  );
}

export function ManagerReviewForm({ action, goals }: { action: Action; goals: Option[] }) {
  const t = useTranslations("performance");
  return (
    <ActionForm action={action} submitLabel={t("submitManager")} pendingLabel={t("working")}>
      {goals.map((g) => (
        <RatingSelect
          key={g.value}
          name={`rating.${g.value}`}
          label={t("rateGoal", { goal: g.label })}
        />
      ))}
      <RatingSelect name="rating" label={t("overallRating")} />
      <TextArea name="strengths" label={t("strengths")} />
      <TextArea name="improvements" label={t("improvements")} />
    </ActionForm>
  );
}

export function AcknowledgeForm({ action }: { action: Action }) {
  const t = useTranslations("performance");
  return (
    <ActionForm action={action} submitLabel={t("acknowledge")} pendingLabel={t("working")}>
      <TextArea name="comment" label={t("employeeComment")} />
    </ActionForm>
  );
}

export function FinalizeForm({
  action,
  managerRating,
}: {
  action: Action;
  managerRating: number | null;
}) {
  const t = useTranslations("performance");
  return (
    <ActionForm action={action} submitLabel={t("finalize")} pendingLabel={t("working")}>
      <RatingSelect
        name="finalRating"
        label={t("finalRating")}
        defaultValue={managerRating ? String(managerRating) : ""}
      />
      <TextField name="reason" label={t("finalReason")} hint={t("finalReasonHint")} />
    </ActionForm>
  );
}

export function SkipForm({ action }: { action: Action }) {
  const t = useTranslations("performance");
  return (
    <ActionForm
      action={action}
      submitLabel={t("skip")}
      pendingLabel={t("working")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-2"
    >
      <TextField name="reason" label={t("skipReason")} required />
    </ActionForm>
  );
}
