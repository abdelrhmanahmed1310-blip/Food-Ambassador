"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export interface OpenInvoiceOption {
  id: string;
  label: string;
  open: string;
}

/** Amount per open invoice, or "apply to the oldest first". */
function AllocationFields({ invoices }: { invoices: OpenInvoiceOption[] }) {
  const t = useTranslations();
  if (invoices.length === 0)
    return <p className="text-muted text-sm">{t("payables.noOpenInvoices")}</p>;
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-medium">{t("payables.applyTo")}</legend>
      <CheckboxField name="autoAllocate" label={t("payables.autoAllocate")} />
      <div className="grid gap-3 sm:grid-cols-2">
        {invoices.map((inv, i) => (
          <div key={inv.id}>
            <input type="hidden" name={`allocations.${i}.invoiceId`} value={inv.id} />
            <TextField
              name={`allocations.${i}.amount`}
              label={inv.label}
              hint={t("payables.openAmount", { amount: inv.open })}
              inputMode="decimal"
              dir="ltr"
              optionalLabel={t("common.optional")}
            />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

export function PaymentForm({
  action,
  methods,
  invoices,
  currency,
  today,
}: {
  action: Action;
  methods: Option[];
  invoices: OpenInvoiceOption[];
  currency: string;
  today: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("payables.recordPayment")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="date"
          type="date"
          label={t("payables.date")}
          defaultValue={today}
          required
        />
        <TextField
          name="amount"
          label={t("payables.amountIn", { currency })}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <SelectField
          name="method"
          label={t("payables.method")}
          options={methods}
          defaultValue="BANK_TRANSFER"
          required
        />
        <TextField
          name="reference"
          label={t("payables.reference")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
      <AllocationFields invoices={invoices} />
    </ActionForm>
  );
}

export function CreditNoteForm({
  action,
  taxCodes,
  invoices,
  currency,
  today,
}: {
  action: Action;
  taxCodes: Option[];
  invoices: OpenInvoiceOption[];
  currency: string;
  today: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("payables.recordCreditNote")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="supplierDocumentNo"
          label={t("payables.creditNoteNo")}
          dir="ltr"
          required
        />
        <TextField
          name="date"
          type="date"
          label={t("payables.date")}
          defaultValue={today}
          required
        />
        <TextField
          name="netAmount"
          label={t("payables.netIn", { currency })}
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
        <TextField name="note" label={t("payables.creditReason")} required />
      </div>
      <AllocationFields invoices={invoices} />
    </ActionForm>
  );
}

export function AllocateForm({
  action,
  invoices,
}: {
  action: Action;
  invoices: OpenInvoiceOption[];
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("payables.apply")} pendingLabel={t("common.saving")}>
      <AllocationFields invoices={invoices} />
    </ActionForm>
  );
}

export function AccountsForm({
  action,
  defaults,
}: {
  action: Action;
  defaults: {
    payablesAccount: string;
    purchasesAccount: string;
    inputVatAccount: string;
    paymentsAccount: string;
  };
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <p className="text-muted text-sm">{t("payables.accountsHint")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            ["payablesAccount", "accountPayables"],
            ["purchasesAccount", "accountPurchases"],
            ["inputVatAccount", "accountInputVat"],
            ["paymentsAccount", "accountPayments"],
          ] as const
        ).map(([name, label]) => (
          <TextField
            key={name}
            name={name}
            label={t(`payables.${label}`)}
            defaultValue={defaults[name]}
            dir="ltr"
            optionalLabel={t("common.optional")}
          />
        ))}
      </div>
    </ActionForm>
  );
}
