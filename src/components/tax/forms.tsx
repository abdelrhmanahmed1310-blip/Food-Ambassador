"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function PresetForm({
  action,
  countries,
  current,
}: {
  action: Action;
  countries: Option[];
  current?: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("tax.applyPreset")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <SelectField
        name="country"
        label={t("tax.country")}
        options={countries}
        placeholder={t("common.select")}
        defaultValue={current}
        required
      />
    </ActionForm>
  );
}

export function TaxSettingsForm({
  action,
  countries,
  codes,
  defaults,
}: {
  action: Action;
  countries: Option[];
  codes: Option[];
  defaults: {
    country?: string;
    vatRegistered: boolean;
    vatNumber?: string;
    pricesIncludeTax: boolean;
    defaultSalesTaxCodeId?: string;
    defaultPurchaseTaxCodeId?: string;
  };
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="country"
          label={t("tax.country")}
          options={countries}
          placeholder={t("common.select")}
          defaultValue={defaults.country}
          required
        />
        <TextField
          name="vatNumber"
          label={t("tax.vatNumber")}
          hint={t("tax.vatNumberHint")}
          defaultValue={defaults.vatNumber}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <CheckboxField
          name="vatRegistered"
          label={t("tax.vatRegistered")}
          defaultChecked={defaults.vatRegistered}
        />
        <CheckboxField
          name="pricesIncludeTax"
          label={t("tax.pricesIncludeTax")}
          defaultChecked={defaults.pricesIncludeTax}
        />
        <SelectField
          name="defaultSalesTaxCodeId"
          label={t("tax.defaultSales")}
          options={codes}
          placeholder="—"
          defaultValue={defaults.defaultSalesTaxCodeId}
          optionalLabel={t("common.optional")}
        />
        <SelectField
          name="defaultPurchaseTaxCodeId"
          label={t("tax.defaultPurchase")}
          options={codes}
          placeholder="—"
          defaultValue={defaults.defaultPurchaseTaxCodeId}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

const CATEGORIES = ["STANDARD", "ZERO_RATED", "EXEMPT", "OUT_OF_SCOPE"] as const;

export function TaxCodeForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.create")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="code" label={t("tax.code")} dir="ltr" required />
        <TextField name="name" label={t("tax.name")} required />
        <TextField
          name="nameAr"
          label={t("tax.nameAr")}
          dir="rtl"
          optionalLabel={t("common.optional")}
        />
        <SelectField
          name="category"
          label={t("tax.category")}
          options={CATEGORIES.map((c) => ({ value: c, label: t(`tax.categories.${c}`) }))}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="ratePercent"
          label={t("tax.ratePercent")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField name="effectiveFrom" type="date" label={t("tax.effectiveFrom")} required />
      </div>
    </ActionForm>
  );
}

export function TaxRateForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("tax.addRate")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          name="ratePercent"
          label={t("tax.ratePercent")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField name="effectiveFrom" type="date" label={t("tax.effectiveFrom")} required />
        <TextField name="source" label={t("tax.source")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export function RecipeTaxForm({
  action,
  codes,
  current,
}: {
  action: Action;
  codes: Option[];
  current?: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.save")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <SelectField
        name="taxCodeId"
        label={t("tax.dishTaxCode")}
        options={codes}
        placeholder={t("tax.useDefault")}
        defaultValue={current}
        optionalLabel={t("common.optional")}
      />
    </ActionForm>
  );
}
