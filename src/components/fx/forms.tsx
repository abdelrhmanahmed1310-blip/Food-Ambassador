"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField, useFormState } from "@/components/forms/fields";
import { inputClass } from "@/components/ui/styles";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function ExchangeRateForm({
  action,
  currencies,
  base,
  today,
}: {
  action: Action;
  currencies: string[];
  base: string;
  today: string;
}) {
  const t = useTranslations("fx");
  const tc = useTranslations("common");
  return (
    <ActionForm action={action} submitLabel={t("saveRate")} pendingLabel={tc("saving")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="currency"
          label={t("currency")}
          options={currencies.map((c) => ({ value: c, label: c }))}
          placeholder="—"
          required
        />
        <TextField
          name="rateDate"
          type="date"
          label={t("rateDate")}
          defaultValue={today}
          required
        />
        <TextField
          name="rate"
          label={t("rateLabel", { base })}
          hint={t("rateHint", { base })}
          inputMode="decimal"
          dir="ltr"
          required
        />
      </div>
    </ActionForm>
  );
}

function ImportErrors() {
  const t = useTranslations("fx");
  const state = useFormState();
  const errors: Array<{ row: number; message: string }> = state.data?.errors
    ? JSON.parse(state.data.errors)
    : [];
  if (errors.length === 0) return null;
  return (
    <ul role="alert" className="text-danger list-inside list-disc text-sm">
      {errors.slice(0, 50).map((e) => (
        <li key={`${e.row}-${e.message}`}>
          {t("importRowError", {
            row: e.row,
            problem: t(`importErrors.${e.message.split(":")[0]}`),
          })}
        </li>
      ))}
    </ul>
  );
}

export function ExchangeRateImportForm({ action }: { action: Action }) {
  const t = useTranslations("fx");
  const tc = useTranslations("common");
  return (
    <ActionForm action={action} submitLabel={t("import")} pendingLabel={tc("saving")}>
      <div>
        <label htmlFor="fx-csv" className="mb-1 block text-sm font-medium">
          {t("csvLabel")}
        </label>
        <textarea
          id="fx-csv"
          name="csv"
          rows={6}
          dir="ltr"
          required
          placeholder={"date,currency,rate\n2026-11-01,USD,48.5000"}
          className={`${inputClass} font-mono`}
        />
        <p className="text-muted mt-1 text-xs">{t("csvHint")}</p>
      </div>
      <ImportErrors />
    </ActionForm>
  );
}
