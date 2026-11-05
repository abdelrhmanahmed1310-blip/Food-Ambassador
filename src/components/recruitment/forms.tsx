"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

const SOURCES = ["REFERRAL", "JOB_BOARD", "WALK_IN", "AGENCY", "SOCIAL_MEDIA", "OTHER"];

export function PositionForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations("recruitment");
  return (
    <ActionForm action={action} submitLabel={t("setPosition")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField name="branchId" label={t("branch")} options={branches} required />
        <TextField name="jobTitle" label={t("jobTitle")} required />
        <TextField name="plannedHeadcount" label={t("planned")} inputMode="numeric" required />
      </div>
      <TextField name="note" label={t("note")} />
    </ActionForm>
  );
}

export function OpeningForm({
  action,
  branches,
  departments,
}: {
  action: Action;
  branches: Option[];
  departments: Option[];
}) {
  const t = useTranslations("recruitment");
  return (
    <ActionForm action={action} submitLabel={t("requestOpening")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField name="branchId" label={t("branch")} options={branches} required />
        <TextField name="jobTitle" label={t("jobTitle")} required />
        <SelectField
          name="departmentId"
          label={t("department")}
          options={departments}
          placeholder={t("none")}
        />
        <SelectField
          name="employmentType"
          label={t("employmentType")}
          options={["FULL_TIME", "PART_TIME", "CONTRACT", "TEMPORARY"].map((v) => ({
            value: v,
            label: t(`employmentTypes.${v}`),
          }))}
        />
        <TextField
          name="headcount"
          label={t("headcount")}
          inputMode="numeric"
          defaultValue="1"
          required
        />
        <SelectField
          name="reason"
          label={t("reason")}
          options={["NEW_POSITION", "REPLACEMENT", "SEASONAL"].map((v) => ({
            value: v,
            label: t(`reasons.${v}`),
          }))}
        />
        <TextField name="targetStartOn" type="date" label={t("targetStart")} />
      </div>
      <TextField name="description" label={t("description")} />
    </ActionForm>
  );
}

export function DecisionForm({ action }: { action: Action }) {
  const t = useTranslations("recruitment");
  return (
    <ActionForm action={action} submitLabel={t("decide")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="decision"
          label={t("decision")}
          options={[
            { value: "APPROVE", label: t("approveOpening") },
            { value: "REJECT", label: t("rejectOpening") },
          ]}
        />
        <TextField name="note" label={t("note")} />
      </div>
    </ActionForm>
  );
}

export function ReasonForm({ action, label }: { action: Action; label: string }) {
  const t = useTranslations("recruitment");
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

export function CandidateFields() {
  const t = useTranslations("recruitment");
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <TextField name="firstName" label={t("firstName")} />
      <TextField name="lastName" label={t("lastName")} />
      <SelectField
        name="source"
        label={t("source")}
        options={SOURCES.map((v) => ({ value: v, label: t(`sources.${v}`) }))}
      />
      <TextField name="email" type="email" label={t("email")} />
      <TextField name="phone" label={t("phone")} />
      <TextField name="note" label={t("note")} />
    </div>
  );
}

export function AddApplicationForm({
  action,
  candidates,
}: {
  action: Action;
  candidates: Option[];
}) {
  const t = useTranslations("recruitment");
  return (
    <ActionForm action={action} submitLabel={t("addCandidate")} pendingLabel={t("working")}>
      <SelectField
        name="candidateId"
        label={t("existingCandidate")}
        options={candidates}
        placeholder={t("newCandidate")}
      />
      <p className="text-muted text-sm">{t("newCandidateHint")}</p>
      <CandidateFields />
    </ActionForm>
  );
}

export function CandidateForm({ action }: { action: Action }) {
  const t = useTranslations("recruitment");
  return (
    <ActionForm action={action} submitLabel={t("createCandidate")} pendingLabel={t("working")}>
      <CandidateFields />
    </ActionForm>
  );
}

export function MoveForm({ action, moves }: { action: Action; moves: string[] }) {
  const t = useTranslations("recruitment");
  return (
    <ActionForm action={action} submitLabel={t("move")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="to"
          label={t("moveTo")}
          options={moves.map((v) => ({ value: v, label: t(`stages.${v}`) }))}
        />
        <TextField name="note" label={t("note")} />
      </div>
    </ActionForm>
  );
}

export function InterviewForm({ action, members }: { action: Action; members: Option[] }) {
  const t = useTranslations("recruitment");
  return (
    <ActionForm action={action} submitLabel={t("schedule")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="kind"
          label={t("interviewKind")}
          options={["IN_PERSON", "PHONE", "VIDEO", "TRIAL_SHIFT"].map((v) => ({
            value: v,
            label: t(`kinds.${v}`),
          }))}
        />
        <TextField name="date" type="date" label={t("date")} required />
        <TextField name="time" type="time" label={t("time")} required />
        <SelectField name="interviewerUserId" label={t("interviewer")} options={members} required />
        <TextField name="location" label={t("location")} />
      </div>
    </ActionForm>
  );
}

export function ScorecardForm({ action }: { action: Action }) {
  const t = useTranslations("recruitment");
  return (
    <ActionForm action={action} submitLabel={t("submitScorecard")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="rating"
          label={t("rating")}
          options={[5, 4, 3, 2, 1].map((v) => ({ value: String(v), label: t(`ratings.${v}`) }))}
        />
        <SelectField
          name="recommendation"
          label={t("recommendation")}
          options={["HIRE", "UNSURE", "NO_HIRE"].map((v) => ({
            value: v,
            label: t(`recommendations.${v}`),
          }))}
        />
      </div>
      <TextField name="notes" label={t("notes")} />
    </ActionForm>
  );
}

export function HireForm({
  action,
  managers,
  templates,
}: {
  action: Action;
  managers: Option[];
  templates: Option[];
}) {
  const t = useTranslations("recruitment");
  return (
    <ActionForm action={action} submitLabel={t("hire")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="hireDate" type="date" label={t("hireDate")} required />
        <SelectField
          name="managerId"
          label={t("lineManager")}
          options={managers}
          placeholder={t("none")}
        />
        <SelectField
          name="onboardingTemplateId"
          label={t("onboarding")}
          options={templates}
          placeholder={t("none")}
        />
      </div>
    </ActionForm>
  );
}

export function RetentionForm({ action, days }: { action: Action; days: string }) {
  const t = useTranslations("recruitment");
  return (
    <ActionForm action={action} submitLabel={t("save")} pendingLabel={t("working")}>
      <TextField
        name="candidateRetentionDays"
        label={t("retentionDays")}
        hint={t("retentionHint")}
        inputMode="numeric"
        defaultValue={days}
      />
    </ActionForm>
  );
}
