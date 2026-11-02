"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField, useFormState } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

function RowErrors() {
  const t = useTranslations();
  const state = useFormState();
  const errors: Array<{ row: number; column: string; message: string }> = state.data?.errors
    ? JSON.parse(state.data.errors)
    : [];
  if (errors.length === 0) return null;
  return (
    <div className="border-border max-h-80 overflow-auto rounded-md border">
      <table className="w-full text-sm" aria-label={t("import.problem")}>
        <thead>
          <tr>
            {[t("import.row"), t("import.column"), t("import.problem")].map((h) => (
              <th
                key={h}
                className="bg-surface-muted text-muted px-3 py-2 text-start text-xs font-semibold"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {errors.map((e, i) => (
            <tr key={i} className="border-border border-t">
              <td className="px-3 py-1.5 tabular-nums">{e.row}</td>
              <td className="ltr-value px-3 py-1.5 font-mono">{e.column}</td>
              <td className="px-3 py-1.5">{e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Import a delivery platform's settlement statement (ADR-075). */
export function PayoutImportForm({
  action,
  connectors,
}: {
  action: Action;
  connectors: Array<{ value: string; label: string }>;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("import.upload")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="connectorId"
          label={t("delivery.payouts.connector")}
          options={connectors}
          placeholder={t("common.select")}
          defaultValue={connectors.length === 1 ? connectors[0].value : undefined}
          required
        />
        <TextField name="reference" label={t("delivery.payouts.reference")} required dir="ltr" />
        <TextField
          name="periodFrom"
          type="date"
          label={t("delivery.payouts.periodFrom")}
          required
        />
        <TextField name="periodTo" type="date" label={t("delivery.payouts.periodTo")} required />
        <TextField
          name="paidOn"
          type="date"
          label={t("delivery.payouts.paidOn")}
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="receivedAmount"
          label={t("delivery.payouts.receivedAmount")}
          hint={t("delivery.payouts.receivedHint")}
          optionalLabel={t("common.optional")}
          inputMode="decimal"
          dir="ltr"
        />
      </div>
      <div>
        <label htmlFor="payout-file" className="mb-1 block text-sm font-medium">
          {t("delivery.payouts.file")}
        </label>
        <input
          id="payout-file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          required
          className="block text-sm"
        />
        <p className="text-muted mt-1 text-xs">{t("delivery.payouts.fileHint")}</p>
      </div>
      <RowErrors />
    </ActionForm>
  );
}
