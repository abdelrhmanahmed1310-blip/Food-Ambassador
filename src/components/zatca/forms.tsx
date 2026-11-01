"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Seller details on e-invoices (national address) and the ZATCA environment. */
export function ZatcaSettingsForm({
  action,
  defaults,
}: {
  action: Action;
  defaults?: Record<string, string | null | undefined>;
}) {
  const t = useTranslations();
  const v = (k: string) => defaults?.[k] ?? undefined;
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="legalName"
          label={t("zatca.legalName")}
          defaultValue={v("legalName")}
          required
        />
        <TextField
          name="crNumber"
          label={t("zatca.crNumber")}
          defaultValue={v("crNumber")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField name="street" label={t("zatca.street")} defaultValue={v("street")} required />
        <TextField
          name="building"
          label={t("zatca.building")}
          hint={t("zatca.buildingHint")}
          defaultValue={v("building")}
          inputMode="numeric"
          dir="ltr"
          required
        />
        <TextField
          name="district"
          label={t("zatca.district")}
          defaultValue={v("district")}
          required
        />
        <TextField name="city" label={t("zatca.city")} defaultValue={v("city")} required />
        <TextField
          name="postalCode"
          label={t("zatca.postalCode")}
          defaultValue={v("postalCode")}
          inputMode="numeric"
          dir="ltr"
          required
        />
        <TextField
          name="businessCategory"
          label={t("zatca.businessCategory")}
          defaultValue={v("businessCategory")}
          required
        />
        <SelectField
          name="environment"
          label={t("zatca.environment")}
          hint={t("zatca.environmentHint")}
          defaultValue={v("environment") ?? "DEVELOPER_PORTAL"}
          options={(["DEVELOPER_PORTAL", "SIMULATION", "CORE"] as const).map((e) => ({
            value: e,
            label: t(`zatca.environments.${e}`),
          }))}
          required
        />
      </div>
    </ActionForm>
  );
}

export function OtpForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("zatca.onboard")}
      pendingLabel={t("zatca.onboarding")}
      className="flex flex-wrap items-end gap-3"
    >
      <TextField
        name="otp"
        label={t("zatca.otp")}
        hint={t("zatca.otpHint")}
        inputMode="numeric"
        dir="ltr"
        required
      />
    </ActionForm>
  );
}
