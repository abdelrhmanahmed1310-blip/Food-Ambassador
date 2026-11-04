"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";
import { SignaturePad } from "./signature-pad";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function VehicleForm({ action, warehouses }: { action: Action; warehouses: Option[] }) {
  const t = useTranslations();
  const optional = t("common.optional");
  return (
    <ActionForm
      action={action}
      submitLabel={t("logistics.addVehicle")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <TextField name="code" label={t("logistics.code")} dir="ltr" required />
        <TextField name="plateNumber" label={t("logistics.plate")} dir="ltr" required />
        <SelectField
          name="type"
          label={t("logistics.type")}
          options={["VAN", "TRUCK", "CAR", "MOTORBIKE", "OTHER"].map((v) => ({
            value: v,
            label: t(`logistics.types.${v}`),
          }))}
          defaultValue="VAN"
        />
        <SelectField
          name="warehouseId"
          label={t("logistics.base")}
          options={warehouses}
          placeholder="—"
          required
        />
        <TextField
          name="minTemperatureC"
          label={t("logistics.minTemp")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="maxTemperatureC"
          label={t("logistics.maxTemp")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={optional}
        />
        <TextField
          name="capacityKg"
          label={t("logistics.capacity")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={optional}
        />
      </div>
      <input type="hidden" name="refrigerated" value="false" />
      <CheckboxField name="refrigerated" label={t("logistics.refrigerated")} />
    </ActionForm>
  );
}

export function TripForm({
  action,
  vehicles,
  drivers,
  date,
}: {
  action: Action;
  vehicles: Option[];
  drivers: Option[];
  date: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("logistics.planTrip")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="vehicleId"
          label={t("logistics.vehicle")}
          options={vehicles}
          placeholder="—"
          required
        />
        <SelectField
          name="driverUserId"
          label={t("logistics.driver")}
          options={drivers}
          placeholder="—"
          required
        />
        <TextField
          name="plannedOn"
          type="date"
          label={t("logistics.plannedOn")}
          defaultValue={date}
          required
        />
      </div>
      <TextField name="note" label={t("logistics.note")} optionalLabel={t("common.optional")} />
    </ActionForm>
  );
}

/** One number (odometer) or nothing, then the action. */
export function OdometerForm({
  action,
  name,
  submitLabel,
}: {
  action: Action;
  name: string;
  submitLabel: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={submitLabel} pendingLabel={t("common.saving")}>
      <TextField
        name={name}
        label={t("logistics.odometer")}
        inputMode="numeric"
        dir="ltr"
        optionalLabel={t("common.optional")}
      />
    </ActionForm>
  );
}

export function ReadingForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("logistics.recordReading")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="temperatureC"
          label={t("logistics.temperature")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField name="note" label={t("logistics.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

/** Proof of delivery at a stop. */
export function DeliverForm({
  action,
  needsTemperature,
}: {
  action: Action;
  needsTemperature: boolean;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("logistics.confirmDelivery")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="recipientName" label={t("logistics.recipient")} required />
        <TextField
          name="handoverTemperatureC"
          label={t("logistics.handoverTemp")}
          inputMode="decimal"
          dir="ltr"
          {...(needsTemperature ? { required: true } : { optionalLabel: t("common.optional") })}
        />
      </div>
      <SignaturePad />
      <TextField name="note" label={t("logistics.note")} optionalLabel={t("common.optional")} />
    </ActionForm>
  );
}
