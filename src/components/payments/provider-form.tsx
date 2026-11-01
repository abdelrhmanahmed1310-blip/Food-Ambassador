"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

/** Moyasar account: test or live, and the secret key (stored sealed, never shown again). */
export function ProviderForm({
  action,
  mode,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  mode?: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="mode"
          label={t("onlinePayments.mode")}
          defaultValue={mode ?? "TEST"}
          options={[
            { value: "TEST", label: t("onlinePayments.modes.TEST") },
            { value: "LIVE", label: t("onlinePayments.modes.LIVE") },
          ]}
          required
        />
        <TextField
          name="secretKey"
          type="password"
          autoComplete="off"
          label={t("onlinePayments.secretKey")}
          hint={t("onlinePayments.secretKeyHint")}
          dir="ltr"
          required
        />
      </div>
    </ActionForm>
  );
}
