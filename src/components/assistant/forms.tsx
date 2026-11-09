"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField, useFormState } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

function QuestionBox({ hint }: { hint?: string }) {
  const t = useTranslations("assistant");
  const state = useFormState();
  const error = state.fieldErrors?.question;
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{t("question")}</span>
      <textarea
        // A fresh box after each answer; the text is kept when asking failed.
        key={state.seq ?? 0}
        name="question"
        dir="auto"
        rows={3}
        maxLength={2000}
        required
        defaultValue={state.ok ? "" : (state.values?.question ?? "")}
        aria-invalid={error ? true : undefined}
        className="border-border bg-surface w-full rounded-lg border p-2"
      />
      <span className="text-muted mt-1 block text-xs">{hint ?? t("questionHint")}</span>
    </label>
  );
}

export function AskForm({ action, hint }: { action: Action; hint?: string }) {
  const t = useTranslations("assistant");
  return (
    <ActionForm action={action} submitLabel={t("ask")} pendingLabel={t("thinking")}>
      <QuestionBox hint={hint} />
    </ActionForm>
  );
}

export function AssistantSettingsForm({
  action,
  defaults,
}: {
  action: Action;
  defaults: { model: string; dailyQuestionLimit: string; keyHint: string | null };
}) {
  const t = useTranslations("assistant");
  const tc = useTranslations("common");
  return (
    <ActionForm action={action} submitLabel={tc("save")} pendingLabel={tc("saving")}>
      <TextField
        name="apiKey"
        type="password"
        autoComplete="off"
        dir="ltr"
        label={t("apiKey")}
        hint={defaults.keyHint ? t("apiKeyKept", { hint: defaults.keyHint }) : t("apiKeyHint")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="model"
          label={t("model")}
          defaultValue={defaults.model}
          options={["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((m) => ({
            value: m,
            label: t(`models.${m}`),
          }))}
        />
        <TextField
          name="dailyQuestionLimit"
          label={t("dailyLimit")}
          hint={t("dailyLimitHint")}
          defaultValue={defaults.dailyQuestionLimit}
          inputMode="numeric"
          dir="ltr"
        />
      </div>
    </ActionForm>
  );
}

/** A one-button form (test the connection, switch on or off). */
export function ButtonForm({
  action,
  label,
  variant = "secondary",
}: {
  action: Action;
  label: string;
  variant?: "primary" | "secondary";
}) {
  const tc = useTranslations("common");
  return (
    <ActionForm
      action={action}
      submitLabel={label}
      pendingLabel={tc("saving")}
      submitVariant={variant}
    >
      {null}
    </ActionForm>
  );
}
