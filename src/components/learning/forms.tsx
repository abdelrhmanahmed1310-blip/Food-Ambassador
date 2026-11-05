"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

const CATEGORIES = [
  "FOOD_SAFETY",
  "ALLERGENS",
  "HYGIENE",
  "HEALTH_SAFETY",
  "FIRE_SAFETY",
  "FIRST_AID",
  "EQUIPMENT",
  "SERVICE",
  "ONBOARDING",
  "OTHER",
] as const;

export function CourseForm({ action }: { action: Action }) {
  const t = useTranslations("learning");
  return (
    <ActionForm action={action} submitLabel={t("addCourse")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="code" label={t("code")} dir="ltr" required />
        <TextField name="name" label={t("name")} required />
        <TextField name="nameAr" label={t("nameAr")} dir="rtl" />
        <SelectField
          name="category"
          label={t("category")}
          options={CATEGORIES.map((c) => ({ value: c, label: t(`categories.${c}`) }))}
        />
        <SelectField
          name="delivery"
          label={t("delivery")}
          options={["IN_PERSON", "ONLINE", "ON_THE_JOB"].map((d) => ({
            value: d,
            label: t(`deliveries.${d}`),
          }))}
        />
        <TextField
          name="validityMonths"
          label={t("validityMonths")}
          hint={t("validityHint")}
          inputMode="numeric"
          dir="ltr"
        />
      </div>
    </ActionForm>
  );
}

export function RequirementForm({
  action,
  departments,
  branches,
}: {
  action: Action;
  departments: Option[];
  branches: Option[];
}) {
  const t = useTranslations("learning");
  return (
    <ActionForm action={action} submitLabel={t("addRequirement")} pendingLabel={t("working")}>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          name="scope"
          label={t("requiredOf")}
          options={["ALL", "JOB_TITLE", "DEPARTMENT", "BRANCH"].map((s) => ({
            value: s,
            label: t(`scopes.${s}`),
          }))}
        />
        <TextField name="jobTitle" label={t("jobTitle")} hint={t("jobTitleHint")} />
        <SelectField
          name="departmentId"
          label={t("department")}
          options={departments}
          placeholder="—"
        />
        <SelectField name="branchId" label={t("branch")} options={branches} placeholder="—" />
        <TextField
          name="dueWithinDays"
          label={t("dueWithinDays")}
          defaultValue="30"
          inputMode="numeric"
          dir="ltr"
        />
      </div>
    </ActionForm>
  );
}

export function SessionForm({
  action,
  courses,
  branches,
  today,
}: {
  action: Action;
  courses: Option[];
  branches: Option[];
  today: string;
}) {
  const t = useTranslations("learning");
  return (
    <ActionForm action={action} submitLabel={t("schedule")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="courseId" label={t("course")} options={courses} />
        <SelectField name="branchId" label={t("branch")} options={branches} />
        <TextField name="date" type="date" label={t("date")} defaultValue={today} required />
        <TextField
          name="time"
          label={t("time")}
          hint="HH:MM"
          defaultValue="09:00"
          dir="ltr"
          required
        />
        <TextField name="trainer" label={t("trainer")} required />
        <TextField name="location" label={t("location")} />
        <TextField name="capacity" label={t("capacity")} inputMode="numeric" dir="ltr" />
      </div>
    </ActionForm>
  );
}

export function ParticipantsForm({ action, employees }: { action: Action; employees: Option[] }) {
  const t = useTranslations("learning");
  return (
    <ActionForm action={action} submitLabel={t("addParticipants")} pendingLabel={t("working")}>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">{t("chooseEmployees")}</legend>
        {employees.map((e) => (
          <label key={e.value} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="employeeId" value={e.value} />
            {e.label}
          </label>
        ))}
      </fieldset>
    </ActionForm>
  );
}

export function AttendanceForm({
  action,
  attendance,
  result,
}: {
  action: Action;
  attendance: string;
  result: string | null;
}) {
  const t = useTranslations("learning");
  return (
    <ActionForm
      action={action}
      submitLabel={t("save")}
      pendingLabel={t("working")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-2"
    >
      <SelectField
        name="attendance"
        label={t("attendance")}
        defaultValue={attendance}
        options={["INVITED", "ATTENDED", "ABSENT"].map((a) => ({
          value: a,
          label: t(`attendances.${a}`),
        }))}
      />
      <SelectField
        name="result"
        label={t("result")}
        defaultValue={result ?? ""}
        placeholder="—"
        options={["PASSED", "FAILED"].map((r) => ({ value: r, label: t(`results.${r}`) }))}
      />
    </ActionForm>
  );
}

export function ReasonForm({
  action,
  label,
  danger = true,
}: {
  action: Action;
  label: string;
  danger?: boolean;
}) {
  const t = useTranslations("learning");
  return (
    <ActionForm
      action={action}
      submitLabel={label}
      pendingLabel={t("working")}
      submitVariant={danger ? "danger" : "secondary"}
      className="flex flex-wrap items-end gap-2"
    >
      <TextField name="reason" label={t("reason")} required />
    </ActionForm>
  );
}

export function ExternalRecordForm({ action, courses }: { action: Action; courses: Option[] }) {
  const t = useTranslations("learning");
  return (
    <ActionForm action={action} submitLabel={t("addRecord")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="courseId" label={t("course")} options={courses} />
        <TextField name="completedOn" type="date" label={t("completedOn")} required />
        <TextField name="provider" label={t("provider")} required />
        <TextField name="certificateNumber" label={t("certificateNumber")} dir="ltr" />
      </div>
      <TextField name="note" label={t("note")} />
    </ActionForm>
  );
}
