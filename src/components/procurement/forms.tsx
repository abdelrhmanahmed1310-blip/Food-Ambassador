"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField, useFormState } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const REJECTION_REASONS = [
  "DAMAGED",
  "WRONG_ITEM",
  "QUALITY",
  "TEMPERATURE",
  "EXPIRED",
  "SHORT_SHELF_LIFE",
  "OTHER",
] as const;

function Checkbox({
  name,
  label,
  hint,
  defaultChecked = false,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
}) {
  const state = useFormState();
  const checked = state.values ? state.values[name] === "on" : defaultChecked;
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        key={`${state.seq ?? 0}-${checked}`}
        type="checkbox"
        name={name}
        defaultChecked={checked}
        className="mt-0.5"
      />
      <span>
        {label}
        {hint ? <span className="text-muted block text-xs">{hint}</span> : null}
      </span>
    </label>
  );
}

// ─── Suppliers ───

export function SupplierForm({
  action,
  submitLabel,
  defaults = {},
  idempotent = false,
}: {
  action: Action;
  submitLabel: string;
  defaults?: Record<string, string | undefined>;
  idempotent?: boolean;
}) {
  const t = useTranslations();
  const opt = t("common.optional");
  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel}
      pendingLabel={t("common.saving")}
      idempotent={idempotent}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="code"
          label={t("suppliers.code")}
          defaultValue={defaults.code}
          dir="ltr"
          required
        />
        <TextField name="name" label={t("suppliers.name")} defaultValue={defaults.name} required />
        <TextField
          name="nameAr"
          label={t("suppliers.nameAr")}
          defaultValue={defaults.nameAr}
          optionalLabel={opt}
        />
        <TextField
          name="taxId"
          label={t("suppliers.taxId")}
          defaultValue={defaults.taxId}
          dir="ltr"
          optionalLabel={opt}
        />
        <TextField
          name="contactName"
          label={t("suppliers.contactName")}
          defaultValue={defaults.contactName}
          optionalLabel={opt}
        />
        <TextField
          name="email"
          type="email"
          label={t("suppliers.email")}
          defaultValue={defaults.email}
          dir="ltr"
          optionalLabel={opt}
        />
        <TextField
          name="phone"
          label={t("suppliers.phone")}
          defaultValue={defaults.phone}
          dir="ltr"
          optionalLabel={opt}
        />
        <TextField
          name="address"
          label={t("suppliers.address")}
          defaultValue={defaults.address}
          optionalLabel={opt}
        />
        <TextField
          name="paymentTermsDays"
          label={t("suppliers.paymentTermsDays")}
          defaultValue={defaults.paymentTermsDays}
          inputMode="numeric"
          dir="ltr"
          optionalLabel={opt}
        />
        <TextField
          name="leadTimeDays"
          label={t("suppliers.leadTimeDays")}
          defaultValue={defaults.leadTimeDays}
          inputMode="numeric"
          dir="ltr"
          optionalLabel={opt}
        />
        <TextField
          name="note"
          label={t("suppliers.note")}
          defaultValue={defaults.note}
          optionalLabel={opt}
        />
      </div>
    </ActionForm>
  );
}

export function SupplierProductForm({
  action,
  products,
  units,
  currency,
}: {
  action: Action;
  products: Option[];
  units: Option[];
  currency: string;
}) {
  const t = useTranslations();
  const opt = t("common.optional");
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.save")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="productId"
          label={t("purchasing.product")}
          options={products}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="purchaseUomId"
          label={t("suppliers.purchaseUnit")}
          options={units}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="supplierSku"
          label={t("suppliers.supplierSku")}
          dir="ltr"
          optionalLabel={opt}
        />
        <TextField
          name="lastUnitPrice"
          label={t("suppliers.lastPrice")}
          hint={t("suppliers.lastPriceHint", { currency })}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={opt}
        />
        <TextField
          name="leadTimeDays"
          label={t("suppliers.leadTimeDays")}
          inputMode="numeric"
          dir="ltr"
          optionalLabel={opt}
        />
        <TextField
          name="minOrderQuantity"
          label={t("suppliers.minOrder")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={opt}
        />
      </div>
      <Checkbox name="preferred" label={t("suppliers.preferred")} />
    </ActionForm>
  );
}

// ─── Purchase orders ───

export function OrderHeaderForm({
  action,
  suppliers,
  warehouses,
  submitLabel,
  defaults = {},
  idempotent = false,
}: {
  action: Action;
  suppliers: Option[];
  warehouses: Option[];
  submitLabel: string;
  defaults?: Record<string, string | undefined>;
  idempotent?: boolean;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel}
      pendingLabel={t("common.saving")}
      idempotent={idempotent}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="supplierId"
          label={t("purchasing.supplier")}
          options={suppliers}
          defaultValue={defaults.supplierId}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="warehouseId"
          label={t("purchasing.deliverTo")}
          options={warehouses}
          defaultValue={defaults.warehouseId}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="expectedOn"
          type="date"
          label={t("purchasing.expectedOn")}
          defaultValue={defaults.expectedOn}
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="note"
          label={t("common.note")}
          defaultValue={defaults.note}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function OrderLineForm({
  action,
  products,
  units,
  currency,
}: {
  action: Action;
  products: Option[];
  units: Option[];
  currency: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("purchasing.addLine")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-4">
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
          label={t("purchasing.unitPrice")}
          hint={t("purchasing.unitPriceHint", { currency })}
          inputMode="decimal"
          dir="ltr"
          required
        />
      </div>
    </ActionForm>
  );
}

/** One-field form for actions that need a reason (send back, close, cancel). */
export function ReasonForm({
  action,
  submitLabel,
  label,
  variant = "secondary",
}: {
  action: Action;
  submitLabel: string;
  label: string;
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
      <TextField name="reason" label={label} required />
    </ActionForm>
  );
}

export function ProcurementSettingsForm({
  action,
  currency,
  defaults,
}: {
  action: Action;
  currency: string;
  defaults: { approvalThreshold: string; overReceiptTolerancePercent: string };
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="approvalThreshold"
          label={t("purchasing.approvalThreshold")}
          hint={t("purchasing.approvalThresholdHint", { currency })}
          defaultValue={defaults.approvalThreshold}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="overReceiptTolerancePercent"
          label={t("purchasing.tolerance")}
          hint={t("purchasing.toleranceHint")}
          defaultValue={defaults.overReceiptTolerancePercent}
          inputMode="decimal"
          dir="ltr"
        />
      </div>
    </ActionForm>
  );
}

// ─── Receiving ───

export interface ReceiptFormLine {
  id: string;
  label: string;
  sku: string;
  unit: string;
  openQuantity: string;
  unitPrice: string;
  lotTracking: "NONE" | "LOT" | "LOT_AND_EXPIRY";
  needsTemperature: boolean;
}

/**
 * One block per open order line (stacks on phones). Field names are
 * `lines.<i>.<field>`, matching the service's error paths.
 */
export function ReceiptForm({
  action,
  lines,
  locations,
}: {
  action: Action;
  lines: ReceiptFormLine[];
  locations: Option[];
}) {
  const t = useTranslations();
  const opt = t("common.optional");
  const reasons = REJECTION_REASONS.map((r) => ({
    value: r,
    label: t(`purchasing.rejectionReasons.${r}`),
  }));
  return (
    <ActionForm
      action={action}
      submitLabel={t("purchasing.postReceipt")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          name="deliveryNoteRef"
          label={t("purchasing.deliveryNote")}
          dir="ltr"
          optionalLabel={opt}
        />
        {locations.length > 0 ? (
          <SelectField
            name="locationId"
            label={t("common.location")}
            options={locations}
            placeholder={t("common.noLocation")}
            optionalLabel={opt}
          />
        ) : null}
        <TextField name="note" label={t("common.note")} optionalLabel={opt} />
      </div>
      {lines.map((l, i) => (
        <fieldset key={l.id} className="border-border rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">
            {l.label} <span className="ltr-value text-muted font-mono text-xs">{l.sku}</span>
          </legend>
          <input type="hidden" name={`lines.${i}.purchaseOrderLineId`} value={l.id} />
          <p className="text-muted mb-3 text-xs">
            {t("purchasing.open")}:{" "}
            <span className="ltr-value">
              {l.openQuantity} {l.unit}
            </span>
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            <TextField
              name={`lines.${i}.receivedQuantity`}
              label={`${t("purchasing.receivedQty")} (${l.unit})`}
              defaultValue={l.openQuantity}
              inputMode="decimal"
              dir="ltr"
            />
            <TextField
              name={`lines.${i}.rejectedQuantity`}
              label={`${t("purchasing.rejectedQty")} (${l.unit})`}
              inputMode="decimal"
              dir="ltr"
              optionalLabel={opt}
            />
            <SelectField
              name={`lines.${i}.rejectionReason`}
              label={t("purchasing.rejectionReason")}
              options={reasons}
              placeholder="—"
              optionalLabel={opt}
            />
            <TextField
              name={`lines.${i}.unitPrice`}
              label={`${t("purchasing.chargedPrice")} / ${l.unit}`}
              defaultValue={l.unitPrice}
              inputMode="decimal"
              dir="ltr"
            />
            {l.lotTracking !== "NONE" ? (
              <TextField name={`lines.${i}.lotCode`} label={t("purchasing.lotCode")} dir="ltr" />
            ) : null}
            {l.lotTracking === "LOT_AND_EXPIRY" ? (
              <TextField
                name={`lines.${i}.expiresOn`}
                type="date"
                label={t("purchasing.expiresOn")}
              />
            ) : null}
            <TextField
              name={`lines.${i}.temperatureCelsius`}
              label={t("purchasing.temperature")}
              inputMode="decimal"
              dir="ltr"
              optionalLabel={l.needsTemperature ? undefined : opt}
            />
            <div className="flex items-end">
              <Checkbox
                name={`lines.${i}.quarantine`}
                label={t("purchasing.quarantine")}
                hint={t("purchasing.quarantineHint")}
              />
            </div>
          </div>
        </fieldset>
      ))}
    </ActionForm>
  );
}

// ─── Reorder planning ───

export function ReorderRuleForm({
  action,
  products,
  units,
}: {
  action: Action;
  products: Option[];
  units: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.save")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <SelectField
          name="productId"
          label={t("purchasing.product")}
          options={products}
          placeholder={t("common.select")}
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
          name="minQuantity"
          label={t("reorder.min")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="maxQuantity"
          label={t("reorder.max")}
          inputMode="decimal"
          dir="ltr"
          required
        />
      </div>
    </ActionForm>
  );
}

/** Submit for the suggestions table; the row checkboxes join it by form id. */
export function CreateOrdersForm({ action, formId }: { action: Action; formId: string }) {
  const t = useTranslations();
  return (
    <ActionForm
      id={formId}
      action={action}
      submitLabel={t("reorder.createOrders")}
      pendingLabel={t("common.saving")}
    >
      <p className="text-muted text-sm">{t("reorder.createOrdersHint")}</p>
    </ActionForm>
  );
}

const LANDED_COST_CHARGES = ["FREIGHT", "CUSTOMS_DUTY", "INSURANCE", "HANDLING", "OTHER"] as const;

export function LandedCostForm({
  action,
  currency,
  quantityAllowed,
}: {
  action: Action;
  currency: string;
  /** Allocation by quantity is offered only when all lines share a base unit. */
  quantityAllowed: boolean;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("landedCost.add")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="chargeType"
          label={t("landedCost.charge")}
          options={LANDED_COST_CHARGES.map((c) => ({
            value: c,
            label: t(`landedCost.charges.${c}`),
          }))}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="amount"
          label={`${t("landedCost.amount")} (${currency})`}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <SelectField
          name="method"
          label={t("landedCost.method")}
          options={[
            { value: "BY_VALUE", label: t("landedCost.methods.BY_VALUE") },
            ...(quantityAllowed
              ? [{ value: "BY_QUANTITY", label: t("landedCost.methods.BY_QUANTITY") }]
              : []),
          ]}
          defaultValue="BY_VALUE"
          required
        />
        <TextField
          name="reference"
          label={t("landedCost.reference")}
          optionalLabel={t("common.optional")}
        />
        <div className="sm:col-span-2">
          <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
        </div>
      </div>
    </ActionForm>
  );
}

export function RequisitionForm({ action, warehouses }: { action: Action; warehouses: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.create")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="warehouseId"
          label={t("requisitions.warehouse")}
          options={warehouses}
          placeholder={t("common.select")}
          defaultValue={warehouses.length === 1 ? warehouses[0].value : undefined}
          required
        />
        <TextField
          name="neededBy"
          type="date"
          label={t("requisitions.neededBy")}
          optionalLabel={t("common.optional")}
        />
        <div className="sm:col-span-2">
          <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
        </div>
      </div>
    </ActionForm>
  );
}

export function RequisitionLineForm({
  action,
  products,
  units,
}: {
  action: Action;
  products: Option[];
  units: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("requisitions.addLine")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <SelectField
            name="productId"
            label={t("purchasing.product")}
            options={products}
            placeholder={t("common.select")}
            required
          />
        </div>
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
        <div className="sm:col-span-4">
          <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
        </div>
      </div>
    </ActionForm>
  );
}

export interface OrderableLine {
  id: string;
  label: string;
  quantity: string;
  unit: string;
  suggestedPrice: string | null;
}

/** Turn selected open requisition lines into a draft order for the chosen supplier. */
export function OrderRequisitionForm({
  action,
  supplierId,
  currency,
  lines,
}: {
  action: Action;
  supplierId: string;
  currency: string;
  lines: OrderableLine[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("requisitions.createOrder")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <input type="hidden" name="supplierId" value={supplierId} />
      <TextField
        name="expectedOn"
        type="date"
        label={t("purchasing.expectedOn")}
        optionalLabel={t("common.optional")}
      />
      {lines.map((l, i) => (
        <fieldset key={l.id} className="border-border rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">{l.label}</legend>
          <input type="hidden" name={`lines.${i}.lineId`} value={l.id} />
          <div className="grid items-end gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name={`lines.${i}.include`} defaultChecked />
              <span>
                {t("requisitions.include")} —{" "}
                <span className="ltr-value tabular-nums">
                  {l.quantity} {l.unit}
                </span>
              </span>
            </label>
            <TextField
              name={`lines.${i}.unitPrice`}
              label={`${t("purchasing.unitPrice")} (${currency} / ${l.unit})`}
              hint={l.suggestedPrice ? t("requisitions.lastPrice") : t("requisitions.noPrice")}
              defaultValue={l.suggestedPrice ?? undefined}
              inputMode="decimal"
              dir="ltr"
            />
          </div>
        </fieldset>
      ))}
    </ActionForm>
  );
}
