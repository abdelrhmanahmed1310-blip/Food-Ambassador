"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function CustomerForm({ action, currencies }: { action: Action; currencies: string[] }) {
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
        <SelectField
          name="currency"
          label={t("fx.currency")}
          options={currencies.map((c) => ({ value: c, label: c }))}
          defaultValue={currencies[0]}
        />
      </div>
    </ActionForm>
  );
}

export function SalesOrderForm({
  action,
  customers,
  warehouses,
  currencies,
}: {
  action: Action;
  customers: Option[];
  warehouses: Option[];
  /** "" = the customer's currency (ADR-054). */
  currencies: string[];
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
        <SelectField
          name="currency"
          label={t("fx.currency")}
          options={[
            { value: "", label: t("fx.customerCurrency") },
            ...currencies.map((c) => ({ value: c, label: c })),
          ]}
          defaultValue=""
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
  currencies,
  companies = [],
  today,
}: {
  action: Action;
  methods: Option[];
  /** The customer's currency (default). */
  currency: string;
  currencies: string[];
  /** The receiving company (ADR-086), shown when the group has several; the default first. */
  companies?: Option[];
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
        {companies.length > 1 ? (
          <SelectField
            name="companyId"
            label={t("companies.company")}
            options={companies}
            defaultValue={companies[0].value}
          />
        ) : null}
        <TextField
          name="date"
          type="date"
          label={t("payables.date")}
          defaultValue={today}
          required
        />
        <TextField name="amount" label={t("fx.amount")} inputMode="decimal" dir="ltr" required />
        <SelectField
          name="currency"
          label={t("fx.currency")}
          options={currencies.map((c) => ({ value: c, label: c }))}
          defaultValue={currency}
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

/** The buyer's VAT number and address for e-invoices in Saudi Arabia (ADR-072). */
export function EInvoiceDetailsForm({
  action,
  values,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  values: {
    taxId: string | null;
    crNumber: string | null;
    street: string | null;
    buildingNumber: string | null;
    district: string | null;
    city: string | null;
    postalCode: string | null;
    countryCode: string;
  };
}) {
  const t = useTranslations();
  const optional = t("common.optional");
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <p className="text-muted text-sm">{t("b2b.eInvoiceHint")}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          name="taxId"
          label={t("b2b.vatNumber")}
          hint={t("b2b.vatNumberHint")}
          defaultValue={values.taxId ?? ""}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="crNumber"
          label={t("b2b.crNumber")}
          defaultValue={values.crNumber ?? ""}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="countryCode"
          label={t("b2b.country")}
          hint={t("b2b.countryHint")}
          defaultValue={values.countryCode}
          dir="ltr"
        />
        <TextField
          name="street"
          label={t("b2b.street")}
          defaultValue={values.street ?? ""}
          optionalLabel={optional}
        />
        <TextField
          name="buildingNumber"
          label={t("b2b.buildingNumber")}
          hint={t("b2b.buildingNumberHint")}
          defaultValue={values.buildingNumber ?? ""}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="district"
          label={t("b2b.district")}
          defaultValue={values.district ?? ""}
          optionalLabel={optional}
        />
        <TextField
          name="city"
          label={t("b2b.city")}
          defaultValue={values.city ?? ""}
          optionalLabel={optional}
        />
        <TextField
          name="postalCode"
          label={t("b2b.postalCode")}
          defaultValue={values.postalCode ?? ""}
          dir="ltr"
          optionalLabel={optional}
        />
      </div>
    </ActionForm>
  );
}
