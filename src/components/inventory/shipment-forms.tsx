"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const SHORTAGE_REASONS = [
  "DAMAGED_IN_TRANSIT",
  "LOST_IN_TRANSIT",
  "SHORT_SHIPPED",
  "OTHER",
] as const;

export function NewShipmentForm({
  action,
  sources,
  destinations,
}: {
  action: Action;
  sources: Option[];
  destinations: Option[];
}) {
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
          name="fromWarehouseId"
          label={t("shipments.from")}
          options={sources}
          placeholder={t("common.select")}
          defaultValue={sources.length === 1 ? sources[0].value : undefined}
          required
        />
        <SelectField
          name="toWarehouseId"
          label={t("shipments.to")}
          options={destinations}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="expectedOn"
          type="date"
          label={t("shipments.expectedOn")}
          optionalLabel={t("common.optional")}
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export function ShipmentLineForm({
  action,
  stock,
  units,
}: {
  action: Action;
  stock: Option[];
  units: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("shipments.addLine")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <SelectField
            name="balanceId"
            label={t("shipments.stock")}
            options={stock}
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
      </div>
    </ActionForm>
  );
}

export interface ReceiveLine {
  id: string;
  label: string;
  unit: string;
  /** Dispatched quantity: plain for the input, formatted for the hint. */
  quantity: string;
  quantityLabel: string;
}

export function ReceiveShipmentForm({
  action,
  lines,
  locations,
}: {
  action: Action;
  lines: ReceiveLine[];
  locations: Option[];
}) {
  const t = useTranslations();
  const reasons = SHORTAGE_REASONS.map((r) => ({ value: r, label: t(`inventory.reasons.${r}`) }));
  return (
    <ActionForm
      action={action}
      submitLabel={t("shipments.receive")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      {locations.length > 0 ? (
        <SelectField
          name="toLocationId"
          label={t("common.location")}
          options={locations}
          placeholder={t("common.noLocation")}
          optionalLabel={t("common.optional")}
        />
      ) : null}
      {lines.map((l, i) => (
        <fieldset key={l.id} className="border-border rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">{l.label}</legend>
          <input type="hidden" name={`lines.${i}.lineId`} value={l.id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              name={`lines.${i}.receivedQuantity`}
              label={`${t("shipments.received")} (${l.unit})`}
              hint={t("shipments.dispatched", { quantity: `${l.quantityLabel} ${l.unit}` })}
              defaultValue={l.quantity}
              inputMode="decimal"
              dir="ltr"
            />
            <SelectField
              name={`lines.${i}.shortageReason`}
              label={t("shipments.shortageReason")}
              options={reasons}
              placeholder="—"
              optionalLabel={t("common.optional")}
            />
          </div>
        </fieldset>
      ))}
    </ActionForm>
  );
}
