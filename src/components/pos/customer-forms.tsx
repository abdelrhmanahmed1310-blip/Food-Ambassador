"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Add a customer (ADR-068). Consent to offers is asked, never assumed. */
export function CustomerForm({
  action,
  values,
}: {
  action: Action;
  values?: { name: string; email: string | null; marketingConsent: boolean };
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={values ? t("common.save") : t("customers.add")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="name" label={t("customers.name")} defaultValue={values?.name} required />
        {values ? null : (
          <TextField
            name="phone"
            label={t("customers.phone")}
            hint={t("customers.phoneHint")}
            dir="ltr"
            inputMode="text"
            required
          />
        )}
        <TextField
          name="email"
          type="email"
          label={t("customers.email")}
          defaultValue={values?.email ?? ""}
          optionalLabel={t("common.optional")}
        />
      </div>
      <CheckboxField
        name="marketingConsent"
        label={t("customers.marketingConsent")}
        defaultChecked={values?.marketingConsent ?? false}
      />
    </ActionForm>
  );
}

export function AdjustPointsForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("customers.adjust")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="points"
          label={t("customers.pointsChange")}
          hint={t("customers.pointsChangeHint")}
          dir="ltr"
          inputMode="numeric"
          required
        />
        <TextField name="reason" label={t("pos.reason")} required />
      </div>
    </ActionForm>
  );
}

export function LoyaltySettingsForm({
  action,
  values,
}: {
  action: Action;
  values: { enabled: boolean; earnRate: string; pointValue: string; minRedeemPoints: string };
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <CheckboxField
        name="enabled"
        label={t("customers.loyaltyEnabled")}
        defaultChecked={values.enabled}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          name="earnRate"
          label={t("customers.earnRate")}
          hint={t("customers.earnRateHint")}
          defaultValue={values.earnRate}
          dir="ltr"
          inputMode="decimal"
          required
        />
        <TextField
          name="pointValue"
          label={t("customers.pointValue")}
          hint={t("customers.pointValueHint")}
          defaultValue={values.pointValue}
          dir="ltr"
          inputMode="decimal"
          required
        />
        <TextField
          name="minRedeemPoints"
          label={t("customers.minRedeem")}
          defaultValue={values.minRedeemPoints}
          dir="ltr"
          inputMode="numeric"
          required
        />
      </div>
    </ActionForm>
  );
}
