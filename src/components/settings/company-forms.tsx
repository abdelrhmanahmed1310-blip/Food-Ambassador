"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** A legal entity (ADR-082). */
export function CompanyForm({
  action,
  defaults = {},
  submitLabel,
  idempotent = false,
  isDefault = false,
  vatRegistered = false,
  currencies,
}: {
  action: Action;
  defaults?: Record<string, string | null | undefined>;
  submitLabel: string;
  idempotent?: boolean;
  /** The default company's VAT registration is set on the VAT settings page (ADR-084). */
  isDefault?: boolean;
  vatRegistered?: boolean;
  /** Currencies the company may keep its books in (ADR-086); the group's first. */
  currencies: string[];
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
        {isDefault ? (
          <p className="text-muted text-sm sm:col-span-2" data-testid="company-vat-managed">
            {vatRegistered
              ? t("vatManagedRegistered", { country: d("country"), number: d("vatNumber") })
              : t("vatManagedNot")}
          </p>
        ) : (
          <>
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
            <div className="sm:col-span-2">
              <CheckboxField
                name="vatRegistered"
                label={t("vatRegistered")}
                defaultChecked={vatRegistered}
              />
            </div>
          </>
        )}
        <SelectField
          name="currency"
          label={t("currency")}
          hint={t("currencyHint")}
          defaultValue={d("currency") || currencies[0]}
          options={currencies.map((c) => ({ value: c, label: c }))}
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
