"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const TYPES = ["CARTON", "CRATE", "PALLET", "BAG", "OTHER"] as const;

/** Pack into one unit: leave quantities empty to pack everything still unpacked (ADR-103). */
export function PackForm({
  action,
  lines,
}: {
  action: Action;
  lines: Array<{ id: string; label: string; remaining: string; unit: string }>;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("loads.pack")} pendingLabel={t("common.saving")}>
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField
          name="type"
          label={t("loads.unitType")}
          options={TYPES.map((v) => ({ value: v, label: t(`loads.unitTypes.${v}`) }))}
          defaultValue="CARTON"
          required
        />
        <TextField
          name="grossWeightKg"
          label={t("loads.weight")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
      <p className="text-muted text-sm">{t("loads.packHint")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {lines.map((l, i) => (
          <div key={l.id}>
            <input type="hidden" name={`lines.${i}.pickListLineId`} value={l.id} />
            <TextField
              name={`lines.${i}.quantity`}
              label={`${l.label} (${l.unit})`}
              hint={t("loads.remaining", { remaining: `${l.remaining} ${l.unit}` })}
              inputMode="decimal"
              dir="ltr"
              optionalLabel={t("common.optional")}
            />
          </div>
        ))}
      </div>
    </ActionForm>
  );
}

export function LoadForm({ action, warehouses }: { action: Action; warehouses: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("loads.create")} pendingLabel={t("common.saving")}>
      <div className="grid gap-3 sm:grid-cols-4">
        <SelectField
          name="warehouseId"
          label={t("loads.warehouse")}
          options={warehouses}
          placeholder={t("common.select")}
          defaultValue={warehouses.length === 1 ? warehouses[0].value : undefined}
          required
        />
        <TextField name="vehicleRef" label={t("loads.vehicle")} dir="ltr" required />
        <TextField
          name="driverName"
          label={t("loads.driver")}
          optionalLabel={t("common.optional")}
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export function AddToLoadForm({ action, lists }: { action: Action; lists: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("loads.add")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
      className="flex flex-wrap items-end gap-2"
    >
      <SelectField
        name="pickListId"
        label={t("loads.pickList")}
        options={lists}
        placeholder={t("common.select")}
        required
      />
    </ActionForm>
  );
}

/** Type or scan a unit number; the field is ready for the next scan after each one. */
export function LoadedForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("loads.confirmLoaded")}
      pendingLabel={t("common.saving")}
      className="flex flex-wrap items-end gap-2"
    >
      <TextField
        name="unit"
        label={t("loads.unitNumber")}
        hint={t("loads.unitNumberHint")}
        dir="ltr"
        autoComplete="off"
        required
      />
    </ActionForm>
  );
}

export function DispatchForm({ action, cold }: { action: Action; cold: boolean }) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("loads.dispatch")} pendingLabel={t("common.saving")}>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          name="vehicleTemperatureCelsius"
          label={t("loads.vehicleTemperature")}
          hint={cold ? t("loads.temperatureRequired") : undefined}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={cold ? undefined : t("common.optional")}
          required={cold}
        />
        <TextField
          name="sealNumber"
          label={t("loads.seal")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}
