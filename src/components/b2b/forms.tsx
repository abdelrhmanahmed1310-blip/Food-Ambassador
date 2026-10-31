"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function CustomerForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("b2b.addCustomer")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="code" label={t("b2b.code")} dir="ltr" required />
        <TextField name="name" label={t("b2b.name")} required />
        <TextField name="nameAr" label={t("b2b.nameAr")} optionalLabel={t("common.optional")} />
        <TextField
          name="taxId"
          label={t("b2b.vatNumber")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="paymentTermsDays"
          label={t("b2b.paymentTerms")}
          inputMode="numeric"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="email"
          label={t("b2b.email")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function SalesOrderForm({
  action,
  customers,
  warehouses,
}: {
  action: Action;
  customers: Option[];
  warehouses: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("b2b.createOrder")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="customerId"
          label={t("b2b.customer")}
          options={customers}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="warehouseId"
          label={t("b2b.shipFrom")}
          options={warehouses}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="customerRef"
          label={t("b2b.customerRef")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="requestedOn"
          type="date"
          label={t("b2b.requestedOn")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function SalesOrderLineForm({
  action,
  products,
  units,
  taxCodes,
}: {
  action: Action;
  products: Option[];
  units: Option[];
  taxCodes: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("b2b.addLine")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-5">
        <SelectField
          name="productId"
          label={t("purchasing.product")}
          options={products}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="quantity"
          label={t("common.quantity")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <SelectField
          name="uomId"
          label={t("common.unit")}
          options={units}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="unitPrice"
          label={t("b2b.netPrice")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <SelectField
          name="taxCodeId"
          label={t("invoices.vatCode")}
          options={taxCodes}
          placeholder={t("b2b.defaultSalesVat")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function DeliverForm({
  action,
  lines,
}: {
  action: Action;
  lines: Array<{ id: string; label: string; open: string }>;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("b2b.deliver")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {lines.map((l, i) => (
          <div key={l.id}>
            <input type="hidden" name={`lines.${i}.lineId`} value={l.id} />
            <TextField
              name={`lines.${i}.quantity`}
              label={l.label}
              defaultValue={l.open}
              inputMode="decimal"
              dir="ltr"
            />
          </div>
        ))}
      </div>
    </ActionForm>
  );
}

export function InvoiceDeliveryForm({ action, today }: { action: Action; today: string }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("b2b.invoice")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-3"
    >
      <TextField
        name="invoiceDate"
        type="date"
        label={t("invoices.invoiceDate")}
        defaultValue={today}
        required
      />
    </ActionForm>
  );
}

export function CustomerReceiptForm({
  action,
  methods,
  currency,
  today,
}: {
  action: Action;
  methods: Option[];
  currency: string;
  today: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("b2b.recordReceipt")}
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
      </div>
      <CheckboxField name="autoAllocate" label={t("b2b.applyOldestFirst")} defaultChecked />
    </ActionForm>
  );
}
