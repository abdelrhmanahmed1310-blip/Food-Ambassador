"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** A legal entity (ADR-082). */
export function CompanyForm({
  action,
  defaults = {},
  submitLabel,
  idempotent = false,
}: {
  action: Action;
  defaults?: Record<string, string | null | undefined>;
  submitLabel: string;
  idempotent?: boolean;
}) {
  const t = useTranslations("companies");
  const d = (k: string) => defaults[k] ?? "";
  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel}
      pendingLabel={t("saving")}
      idempotent={idempotent}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="code" label={t("code")} defaultValue={d("code")} dir="ltr" required />
        <TextField name="name" label={t("name")} defaultValue={d("name")} required />
        <TextField name="legalName" label={t("legalName")} defaultValue={d("legalName")} required />
        <TextField
          name="country"
          label={t("country")}
          hint={t("countryHint")}
          defaultValue={d("country")}
          dir="ltr"
          optionalLabel={t("optional")}
        />
        <TextField
          name="vatNumber"
          label={t("vatNumber")}
          defaultValue={d("vatNumber")}
          dir="ltr"
          optionalLabel={t("optional")}
        />
        <TextField
          name="crNumber"
          label={t("crNumber")}
          defaultValue={d("crNumber")}
          dir="ltr"
          optionalLabel={t("optional")}
        />
      </div>
    </ActionForm>
  );
}

export function BrandForm({ action }: { action: Action }) {
  const t = useTranslations("companies");
  return (
    <ActionForm action={action} submitLabel={t("addBrand")} pendingLabel={t("saving")} idempotent>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="code" label={t("code")} dir="ltr" required />
        <TextField name="name" label={t("brandName")} required />
        <TextField name="nameAr" label={t("nameAr")} dir="rtl" optionalLabel={t("optional")} />
      </div>
    </ActionForm>
  );
}
