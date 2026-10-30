"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function InvoiceForm({
  action,
  suppliers,
  currency,
  defaults,
  submitLabel,
}: {
  action: Action;
  /** Omitted when editing: the supplier of an invoice does not change. */
  suppliers?: Option[];
  currency: string;
  defaults?: {
    supplierInvoiceNo: string;
    invoiceDate: string;
    dueDate: string;
    printedGross: string;
    note: string;
  };
  submitLabel: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel}
      pendingLabel={t("common.saving")}
      idempotent={!defaults}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {suppliers ? (
          <SelectField
            name="supplierId"
            label={t("purchasing.supplier")}
            options={suppliers}
            placeholder={t("common.select")}
            required
          />
        ) : null}
        <TextField
          name="supplierInvoiceNo"
          label={t("invoices.supplierInvoiceNo")}
          defaultValue={defaults?.supplierInvoiceNo}
          dir="ltr"
          required
        />
        <TextField
          name="invoiceDate"
          type="date"
          label={t("invoices.invoiceDate")}
          defaultValue={defaults?.invoiceDate}
          required
        />
        <TextField
          name="dueDate"
          type="date"
          label={t("invoices.dueDate")}
          hint={t("invoices.dueDateHint")}
          defaultValue={defaults?.dueDate}
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="printedGross"
          label={t("invoices.printedGross")}
          hint={t("invoices.printedGrossHint", { currency })}
          defaultValue={defaults?.printedGross}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="note"
          label={t("common.note")}
          defaultValue={defaults?.note}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

/** One receipt line still to invoice: quantity and price default to what is open and was charged. */
export function GoodsLineForm({
  action,
  receiptLineId,
  label,
  quantity,
  unit,
  unitPrice,
  taxCodes,
}: {
  action: Action;
  receiptLineId: string;
  label: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxCodes: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("invoices.addLine")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
      className="border-border space-y-3 rounded-md border p-3"
    >
      <p className="text-sm font-medium">{label}</p>
      <input type="hidden" name="receiptLineId" value={receiptLineId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          name="quantity"
          label={t("invoices.quantityIn", { unit })}
          defaultValue={quantity}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="unitPrice"
          label={t("invoices.invoicePrice")}
          defaultValue={unitPrice}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <SelectField
          name="taxCodeId"
          label={t("invoices.vatCode")}
          options={taxCodes}
          placeholder={t("invoices.defaultVat")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function ChargeLineForm({ action, taxCodes }: { action: Action; taxCodes: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("invoices.addCharge")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField name="description" label={t("invoices.chargeDescription")} required />
        <TextField
          name="netAmount"
          label={t("invoices.netAmount")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <SelectField
          name="taxCodeId"
          label={t("invoices.vatCode")}
          options={taxCodes}
          placeholder={t("invoices.defaultVat")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function TextReasonForm({
  action,
  name,
  label,
  submitLabel,
  variant = "secondary",
}: {
  action: Action;
  name: "note" | "reason";
  label: string;
  submitLabel: string;
  variant?: "primary" | "secondary" | "danger";
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel}
      pendingLabel={t("common.saving")}
      submitVariant={variant}
    >
      <TextField name={name} label={label} required />
    </ActionForm>
  );
}
