"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const TYPES = [
  "THERMOMETER",
  "FRIDGE",
  "FREEZER",
  "OVEN",
  "HOT_HOLDING",
  "SCALE",
  "DISHWASHER",
  "EXTRACTION",
  "OTHER",
] as const;
const MAINT = ["PREVENTIVE", "REPAIR", "CLEANING", "INSPECTION"] as const;

/** Register equipment at a branch (ADR-099). */
export function EquipmentForm({
  action,
  branches,
  checkpoints,
}: {
  action: Action;
  branches: Option[];
  checkpoints: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("equipment.register")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="branchId"
          label={t("equipment.branch")}
          options={branches}
          placeholder={t("common.select")}
          required
        />
        <TextField name="code" label={t("equipment.code")} required dir="ltr" />
        <TextField name="name" label={t("equipment.name")} required />
        <SelectField
          name="type"
          label={t("equipment.type")}
          options={TYPES.map((v) => ({ value: v, label: t(`equipment.types.${v}`) }))}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="serialNumber"
          label={t("equipment.serialNumber")}
          optionalLabel={t("common.optional")}
          dir="ltr"
        />
        <TextField
          name="location"
          label={t("equipment.location")}
          optionalLabel={t("common.optional")}
        />
        <SelectField
          name="checkpointId"
          label={t("equipment.checkpoint")}
          hint={t("equipment.checkpointHint")}
          options={checkpoints}
          placeholder="—"
        />
        <TextField
          name="calibrationIntervalDays"
          label={t("equipment.calibrationInterval")}
          hint={t("equipment.intervalHint")}
          inputMode="numeric"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="maintenanceIntervalDays"
          label={t("equipment.maintenanceInterval")}
          inputMode="numeric"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function CalibrationForm({ action, today }: { action: Action; today: string }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("equipment.recordCalibration")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          name="performedOn"
          type="date"
          label={t("equipment.performedOn")}
          defaultValue={today}
          required
        />
        <TextField
          name="performedBy"
          label={t("equipment.performedBy")}
          hint={t("equipment.performedByHint")}
          required
        />
        <TextField
          name="method"
          label={t("equipment.method")}
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="referenceValue"
          label={t("equipment.reference")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="readingValue"
          label={t("equipment.reading")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="tolerance"
          label={t("equipment.tolerance")}
          hint={t("equipment.toleranceHint")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="unit"
          label={t("equipment.unit")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <SelectField
          name="result"
          label={t("equipment.result")}
          hint={t("equipment.resultHint")}
          options={[
            { value: "PASS", label: t("equipment.results.PASS") },
            { value: "FAIL", label: t("equipment.results.FAIL") },
          ]}
          placeholder={t("equipment.fromNumbers")}
        />
        <TextField
          name="certificateNo"
          label={t("equipment.certificate")}
          optionalLabel={t("common.optional")}
          dir="ltr"
        />
        <TextField
          name="nextDueOn"
          type="date"
          label={t("equipment.nextDue")}
          hint={t("equipment.nextDueHint")}
          optionalLabel={t("common.optional")}
        />
        <div className="sm:col-span-2">
          <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
        </div>
      </div>
    </ActionForm>
  );
}

export function MaintenanceForm({ action, today }: { action: Action; today: string }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("equipment.recordMaintenance")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField
          name="type"
          label={t("equipment.maintenanceType")}
          options={MAINT.map((v) => ({ value: v, label: t(`equipment.maintenanceTypes.${v}`) }))}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="performedOn"
          type="date"
          label={t("equipment.performedOn")}
          defaultValue={today}
          required
        />
        <TextField name="performedBy" label={t("equipment.performedBy")} required />
        <div className="sm:col-span-2">
          <TextField name="description" label={t("equipment.work")} required />
        </div>
        <TextField
          name="nextDueOn"
          type="date"
          label={t("equipment.nextDue")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}
