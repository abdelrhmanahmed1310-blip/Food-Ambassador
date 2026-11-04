"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const MODES = ["SEA", "AIR", "ROAD", "RAIL", "COURIER"];
const INCOTERMS = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];
const CONTAINERS = ["DRY_20", "DRY_40", "HIGH_CUBE_40", "REEFER_20", "REEFER_40", "OTHER"];

/** A new import shipment (with supplier and warehouse) or its transport details (ADR-113). */
export function ShipmentForm({
  action,
  submitLabel,
  countries,
  suppliers,
  warehouses,
  defaults = {},
}: {
  action: Action;
  submitLabel: string;
  countries: Option[];
  suppliers?: Option[];
  warehouses?: Option[];
  defaults?: Record<string, string | undefined>;
}) {
  const t = useTranslations();
  const optional = t("common.optional");
  return (
    <ActionForm action={action} submitLabel={submitLabel} pendingLabel={t("common.saving")}>
      {suppliers && warehouses ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            name="supplierId"
            label={t("trade.supplier")}
            options={suppliers}
            placeholder="—"
            required
          />
          <SelectField
            name="warehouseId"
            label={t("trade.warehouse")}
            options={warehouses}
            placeholder="—"
            required
          />
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="mode"
          label={t("trade.mode")}
          options={MODES.map((m) => ({ value: m, label: t(`trade.modes.${m}`) }))}
          defaultValue={defaults.mode ?? "SEA"}
        />
        <SelectField
          name="incoterm"
          label={t("trade.incoterm")}
          options={INCOTERMS.map((i) => ({ value: i, label: i }))}
          defaultValue={defaults.incoterm}
          placeholder="—"
          optionalLabel={optional}
        />
        <SelectField
          name="originCountry"
          label={t("trade.originCountry")}
          options={countries}
          defaultValue={defaults.originCountry}
          placeholder="—"
          optionalLabel={optional}
        />
        <TextField
          name="portOfLoading"
          label={t("trade.portOfLoading")}
          defaultValue={defaults.portOfLoading}
          optionalLabel={optional}
        />
        <TextField
          name="portOfDischarge"
          label={t("trade.portOfDischarge")}
          defaultValue={defaults.portOfDischarge}
          optionalLabel={optional}
        />
        <TextField
          name="carrier"
          label={t("trade.carrier")}
          defaultValue={defaults.carrier}
          optionalLabel={optional}
        />
        <TextField
          name="transportDocument"
          label={t("trade.transportDocument")}
          defaultValue={defaults.transportDocument}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="vesselOrFlight"
          label={t("trade.vesselOrFlight")}
          defaultValue={defaults.vesselOrFlight}
          optionalLabel={optional}
        />
        <div className="grid grid-cols-2 gap-4">
          <TextField
            name="etd"
            type="date"
            label={t("trade.etd")}
            defaultValue={defaults.etd}
            optionalLabel={optional}
          />
          <TextField
            name="eta"
            type="date"
            label={t("trade.eta")}
            defaultValue={defaults.eta}
            optionalLabel={optional}
          />
        </div>
      </div>
      <TextField
        name="note"
        label={t("trade.note")}
        defaultValue={defaults.note}
        optionalLabel={optional}
      />
    </ActionForm>
  );
}

export function ContainerForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("trade.addContainer")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <TextField
          name="number"
          label={t("trade.containerNumber")}
          hint={t("trade.containerNumberHint")}
          dir="ltr"
          required
        />
        <SelectField
          name="type"
          label={t("trade.containerType")}
          options={CONTAINERS.map((c) => ({ value: c, label: t(`trade.containerTypes.${c}`) }))}
          defaultValue="DRY_20"
        />
        <TextField
          name="sealNumber"
          label={t("trade.sealNumber")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="temperatureC"
          label={t("trade.temperature")}
          hint={t("trade.temperatureHint")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

/** Pick one record (an order, a receipt) and add it. */
export function PickOneForm({
  action,
  name,
  label,
  options,
  submitLabel,
}: {
  action: Action;
  name: string;
  label: string;
  options: Option[];
  submitLabel: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={submitLabel} pendingLabel={t("common.saving")}>
      <SelectField name={name} label={label} options={options} placeholder="—" required />
    </ActionForm>
  );
}

/** The next step on a date (today by default). */
export function AdvanceForm({
  action,
  submitLabel,
  withDate,
}: {
  action: Action;
  submitLabel: string;
  withDate: boolean;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={submitLabel} pendingLabel={t("common.saving")}>
      {withDate ? (
        <TextField
          name="date"
          type="date"
          label={t("trade.stepDate")}
          hint={t("trade.stepDateHint")}
          optionalLabel={t("common.optional")}
        />
      ) : null}
    </ActionForm>
  );
}

/** A trade document: added (with its type, and product when held per product) or renewed (ADR-114). */
export function TradeDocumentForm({
  action,
  submitLabel,
  types,
  products,
  defaults = {},
}: {
  action: Action;
  submitLabel: string;
  types?: Option[];
  products?: Option[];
  defaults?: Record<string, string | undefined>;
}) {
  const t = useTranslations();
  const optional = t("common.optional");
  return (
    <ActionForm action={action} submitLabel={submitLabel} pendingLabel={t("common.saving")}>
      {types || products ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {types ? (
            <SelectField
              name="documentTypeId"
              label={t("tradeDocs.type")}
              options={types}
              placeholder="—"
              required
            />
          ) : null}
          {products ? (
            <SelectField
              name="productId"
              label={t("tradeDocs.product")}
              options={products}
              placeholder="—"
              required
            />
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-4">
        <TextField
          name="number"
          label={t("tradeDocs.number")}
          defaultValue={defaults.number}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="issuedBy"
          label={t("tradeDocs.issuedBy")}
          defaultValue={defaults.issuedBy}
          optionalLabel={optional}
        />
        <TextField
          name="issuedOn"
          type="date"
          label={t("tradeDocs.issuedOn")}
          defaultValue={defaults.issuedOn}
          optionalLabel={optional}
        />
        <TextField
          name="expiresOn"
          type="date"
          label={t("tradeDocs.expiresOn")}
          hint={t("tradeDocs.expiresOnHint")}
          defaultValue={defaults.expiresOn}
          optionalLabel={optional}
        />
      </div>
      <TextField
        name="note"
        label={t("tradeDocs.note")}
        defaultValue={defaults.note}
        optionalLabel={optional}
      />
    </ActionForm>
  );
}

export function DocumentTypeForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("tradeDocs.addType")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <TextField name="code" label={t("tradeDocs.code")} dir="ltr" required />
        <TextField name="name" label={t("tradeDocs.name")} required />
        <TextField
          name="nameAr"
          label={t("tradeDocs.nameAr")}
          optionalLabel={t("common.optional")}
        />
        <SelectField
          name="scope"
          label={t("tradeDocs.scope")}
          options={["SHIPMENT", "PRODUCT"].map((s) => ({
            value: s,
            label: t(`tradeDocs.scopes.${s}`),
          }))}
          defaultValue="SHIPMENT"
        />
      </div>
      <input type="hidden" name="hasExpiry" value="false" />
      <CheckboxField name="hasExpiry" label={t("tradeDocs.hasExpiry")} />
    </ActionForm>
  );
}

export function RequirementForm({
  action,
  types,
  countries,
}: {
  action: Action;
  types: Option[];
  countries: Option[];
}) {
  const t = useTranslations();
  const optional = t("common.optional");
  return (
    <ActionForm
      action={action}
      submitLabel={t("tradeDocs.addRequirement")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="documentTypeId"
          label={t("tradeDocs.type")}
          options={types}
          placeholder="—"
          required
        />
        <SelectField
          name="destinationCountry"
          label={t("tradeDocs.destinationCountry")}
          hint={t("tradeDocs.destinationHint")}
          options={countries}
          placeholder={t("tradeDocs.anyCountry")}
          optionalLabel={optional}
        />
        <SelectField
          name="originCountry"
          label={t("tradeDocs.originCountry")}
          options={countries}
          placeholder={t("tradeDocs.anyCountry")}
          optionalLabel={optional}
        />
        <TextField
          name="hsPrefix"
          label={t("tradeDocs.hsPrefix")}
          hint={t("tradeDocs.hsPrefixHint")}
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField name="authority" label={t("tradeDocs.authority")} optionalLabel={optional} />
        <TextField name="note" label={t("tradeDocs.note")} optionalLabel={optional} />
      </div>
    </ActionForm>
  );
}
