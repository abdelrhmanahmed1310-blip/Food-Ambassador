"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

export function SurveyForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations("engagement");
  return (
    <ActionForm action={action} submitLabel={t("createSurvey")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="title" label={t("surveyTitle")} required />
        <SelectField
          name="branchId"
          label={t("audience")}
          options={branches}
          placeholder={t("everyone")}
        />
        <TextField name="closesOn" type="date" label={t("closesOn")} />
      </div>
      <TextField name="intro" label={t("intro")} />
    </ActionForm>
  );
}

export function QuestionForm({ action }: { action: Action }) {
  const t = useTranslations("engagement");
  return (
    <ActionForm action={action} submitLabel={t("addQuestion")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="type"
          label={t("questionType")}
          options={["RATING", "ENPS", "YES_NO", "TEXT"].map((x) => ({
            value: x,
            label: t(`types.${x}`),
          }))}
        />
        <TextField name="text" label={t("questionText")} required />
      </div>
      <CheckboxField name="required" label={t("required")} defaultChecked />
    </ActionForm>
  );
}

export interface QuestionView {
  id: string;
  type: "RATING" | "ENPS" | "YES_NO" | "TEXT";
  text: string;
  required: boolean;
}

/** The answer form: radio scales, yes/no, or a text box per question. */
export function AnswerForm({ action, questions }: { action: Action; questions: QuestionView[] }) {
  const t = useTranslations("engagement");
  return (
    <ActionForm action={action} submitLabel={t("submit")} pendingLabel={t("working")}>
      <p className="text-muted text-sm">{t("anonymousNote")}</p>
      {questions.map((q, i) => (
        <fieldset key={q.id} className="border-border space-y-2 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">
            {i + 1}. {q.text}
            {q.required ? " *" : ""}
          </legend>
          {q.type === "TEXT" ? (
            <textarea
              name={`q.${q.id}`}
              rows={3}
              maxLength={2000}
              aria-label={q.text}
              className="border-border bg-surface w-full rounded-lg border p-2"
            />
          ) : (
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={q.text}>
              {(q.type === "RATING"
                ? [1, 2, 3, 4, 5]
                : q.type === "ENPS"
                  ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
                  : [1, 0]
              ).map((v) => (
                <label
                  key={v}
                  className="border-border flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
                >
                  <input type="radio" name={`q.${q.id}`} value={String(v)} />
                  {q.type === "YES_NO"
                    ? v
                      ? t("yes")
                      : t("no")
                    : q.type === "RATING"
                      ? t(`scale.${v}`)
                      : v}
                </label>
              ))}
            </div>
          )}
          {q.type === "ENPS" ? <p className="text-muted text-xs">{t("enpsHint")}</p> : null}
        </fieldset>
      ))}
    </ActionForm>
  );
}

export function RecognitionForm({ action, colleagues }: { action: Action; colleagues: Option[] }) {
  const t = useTranslations("engagement");
  return (
    <ActionForm action={action} submitLabel={t("recognize")} pendingLabel={t("working")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="toEmployeeId" label={t("colleague")} options={colleagues} />
        <SelectField
          name="value"
          label={t("for")}
          options={[
            "TEAMWORK",
            "GUEST_SERVICE",
            "FOOD_SAFETY",
            "CLEANLINESS",
            "LEADERSHIP",
            "EXTRA_MILE",
          ].map((v) => ({
            value: v,
            label: t(`values.${v}`),
          }))}
        />
      </div>
      <TextField name="message" label={t("message")} required />
    </ActionForm>
  );
}

export function HideForm({ action }: { action: Action }) {
  const t = useTranslations("engagement");
  return (
    <ActionForm
      action={action}
      submitLabel={t("hide")}
      pendingLabel={t("working")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-2"
    >
      <TextField name="reason" label={t("hideReason")} required />
    </ActionForm>
  );
}
