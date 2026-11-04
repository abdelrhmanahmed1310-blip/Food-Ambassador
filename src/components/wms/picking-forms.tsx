"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxGroup, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** What was picked on each line, in walk order (ADR-102). */
export function ConfirmPickForm({
  action,
  lines,
}: {
  action: Action;
  lines: Array<{ id: string; label: string; planned: string; unit: string }>;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("picking.confirm")}
      pendingLabel={t("common.saving")}
    >
      {lines.map((l, i) => (
        <fieldset key={l.id} className="border-border rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{l.label}</legend>
          <input type="hidden" name={`lines.${i}.id`} value={l.id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              name={`lines.${i}.pickedQuantity`}
              label={`${t("picking.picked")} (${l.unit})`}
              hint={t("picking.plannedHint", { planned: `${l.planned} ${l.unit}` })}
              defaultValue={l.planned}
              inputMode="decimal"
              dir="ltr"
              required
            />
            <TextField
              name={`lines.${i}.shortReason`}
              label={t("picking.shortReason")}
              optionalLabel={t("common.optional")}
            />
          </div>
        </fieldset>
      ))}
    </ActionForm>
  );
}

export function WaveForm({
  action,
  orders,
}: {
  action: Action;
  orders: Array<{ value: string; label: string }>;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("picking.planWave")}
      pendingLabel={t("common.saving")}
    >
      <CheckboxGroup name="orderIds" legend={t("picking.orders")} options={orders} />
      <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
    </ActionForm>
  );
}
