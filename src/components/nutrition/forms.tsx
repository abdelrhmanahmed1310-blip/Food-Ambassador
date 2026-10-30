"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const NUTRIENT_FIELDS = [
  "energyKcal",
  "energyKj",
  "fat",
  "saturatedFat",
  "carbohydrate",
  "sugars",
  "fibre",
  "protein",
  "salt",
  "sodium",
] as const;

export function NutritionProfileForm({
  action,
  sources,
  defaultBasis,
}: {
  action: Action;
  sources: Option[];
  defaultBasis: "PER_100G" | "PER_100ML";
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("nutrition.saveValues")}
      pendingLabel={t("common.saving")}
    >
      <p className="text-muted text-sm">{t("nutrition.valuesHint")}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="basis"
          label={t("nutrition.basis")}
          options={[
            { value: "PER_100G", label: t("nutrition.bases.PER_100G") },
            { value: "PER_100ML", label: t("nutrition.bases.PER_100ML") },
          ]}
          defaultValue={defaultBasis}
          required
        />
        <SelectField
          name="source"
          label={t("nutrition.source")}
          options={sources}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="reference"
          label={t("nutrition.reference")}
          hint={t("nutrition.referenceHint")}
          optionalLabel={t("common.optional")}
        />
        {NUTRIENT_FIELDS.map((n) => (
          <TextField
            key={n}
            name={n}
            label={t(`nutrition.nutrients.${n}`)}
            inputMode="decimal"
            dir="ltr"
            optionalLabel={t("nutrition.unknownIfEmpty")}
          />
        ))}
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export function AllergenForm({
  action,
  allergens,
  sources,
}: {
  action: Action;
  allergens: Array<{ code: string; label: string; current: string | null }>;
  sources: Option[];
}) {
  const t = useTranslations();
  const statements = ["CONTAINS", "MAY_CONTAIN", "FREE_FROM", "UNKNOWN"].map((s) => ({
    value: s,
    label: t(`nutrition.statements.${s}`),
  }));
  return (
    <ActionForm
      action={action}
      submitLabel={t("nutrition.saveAllergens")}
      pendingLabel={t("common.saving")}
    >
      <p className="text-muted text-sm">{t("nutrition.allergensHint")}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="source"
          label={t("nutrition.source")}
          options={sources}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="reference"
          label={t("nutrition.reference")}
          hint={t("nutrition.freeFromNeedsReference")}
          optionalLabel={t("common.optional")}
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {allergens.map((a) => (
          <SelectField
            key={a.code}
            name={`statements.${a.code}`}
            label={a.label}
            hint={t("nutrition.currently", {
              status: t(`nutrition.statements.${a.current ?? "UNKNOWN"}`),
            })}
            options={statements}
            placeholder={t("nutrition.noChange")}
            optionalLabel={t("common.optional")}
          />
        ))}
      </div>
    </ActionForm>
  );
}

export function LabelReviewForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("nutrition.submitReview")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="decision"
          label={t("nutrition.decision")}
          options={[
            { value: "APPROVE", label: t("nutrition.approve") },
            { value: "REJECT", label: t("nutrition.reject") },
          ]}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="note"
          label={t("nutrition.reviewNote")}
          hint={t("nutrition.reviewNoteHint")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}
