"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField, useFormState } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export const FS_DOCUMENT_TYPES = [
  "POLICY",
  "SOP",
  "WORK_INSTRUCTION",
  "FORM",
  "MANUAL",
  "OTHER",
] as const;

function ContentField({ defaultValue }: { defaultValue?: string }) {
  const t = useTranslations();
  const state = useFormState();
  const id = useId();
  const value = state.values?.content ?? defaultValue ?? "";
  const error = state.fieldErrors?.content;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {t("fsDocs.content")}
      </label>
      <textarea
        id={id}
        key={`${state.seq ?? 0}-${value.length}`}
        name="content"
        rows={14}
        maxLength={50000}
        defaultValue={value}
        aria-invalid={error ? true : undefined}
        className="border-border bg-surface mt-1 w-full rounded-md border px-3 py-2 text-sm"
      />
      {error ? (
        <p role="alert" className="text-danger mt-1 text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A new controlled document with its first draft (ADR-097). */
export function NewDocumentForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.create")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="code" label={t("fsDocs.code")} required dir="ltr" />
        <TextField name="title" label={t("fsDocs.docTitle")} required />
        <SelectField
          name="type"
          label={t("fsDocs.type")}
          required
          options={FS_DOCUMENT_TYPES.map((v) => ({ value: v, label: t(`fsDocs.types.${v}`) }))}
          placeholder={t("common.select")}
        />
        <SelectField
          name="branchId"
          label={t("fsDocs.branch")}
          options={branches}
          placeholder={t("fsDocs.allBranches")}
        />
      </div>
      <ContentField />
      <TextField
        name="changeSummary"
        label={t("fsDocs.changeSummary")}
        optionalLabel={t("common.optional")}
      />
    </ActionForm>
  );
}

export function DraftForm({
  action,
  defaults,
}: {
  action: Action;
  defaults: { title: string; content: string; changeSummary?: string };
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <TextField name="title" label={t("fsDocs.docTitle")} defaultValue={defaults.title} required />
      <ContentField defaultValue={defaults.content} />
      <TextField
        name="changeSummary"
        label={t("fsDocs.changeSummary")}
        defaultValue={defaults.changeSummary}
        optionalLabel={t("common.optional")}
      />
    </ActionForm>
  );
}

export function ApproveDocumentForm({
  action,
  today,
  review,
}: {
  action: Action;
  today: string;
  review: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("fsDocs.approve")}
      pendingLabel={t("common.saving")}
      className="flex flex-wrap items-end gap-3"
    >
      <div className="w-44">
        <TextField
          name="effectiveFrom"
          type="date"
          label={t("fsDocs.effectiveFrom")}
          defaultValue={today}
          required
        />
      </div>
      <div className="w-44">
        <TextField
          name="reviewDueOn"
          type="date"
          label={t("fsDocs.reviewDueOn")}
          defaultValue={review}
          required
        />
      </div>
    </ActionForm>
  );
}
