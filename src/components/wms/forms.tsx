"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Inspect one quarantined receipt line (ADR-101). Quantities in the base unit. */
export function InspectionForm({
  action,
  total,
  unit,
}: {
  action: Action;
  total: string;
  unit: string;
}) {
  const t = useTranslations();
  const yesNo = [
    { value: "yes", label: t("common.yes") },
    { value: "no", label: t("common.no") },
  ];
  return (
    <ActionForm
      action={action}
      submitLabel={t("inspections.record")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField
          name="packagingOk"
          label={t("inspections.packaging")}
          options={yesNo}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="labellingOk"
          label={t("inspections.labelling")}
          options={yesNo}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="conditionOk"
          label={t("inspections.condition")}
          options={yesNo}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="acceptedQuantity"
          label={`${t("inspections.accepted")} (${unit})`}
          hint={t("inspections.acceptedHint", { total: `${total} ${unit}` })}
          defaultValue={total}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="temperatureCelsius"
          label={t("inspections.temperature")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="rejectionReason"
          label={t("inspections.rejectionReason")}
          hint={t("inspections.rejectionHint")}
          optionalLabel={t("common.optional")}
        />
        <div className="sm:col-span-3">
          <TextField
            name="note"
            label={t("common.note")}
            hint={t("inspections.noteHint")}
            optionalLabel={t("common.optional")}
          />
        </div>
      </div>
    </ActionForm>
  );
}

/** Put one received balance away. */
export function PutAwayForm({
  action,
  targets,
  suggested,
  quantity,
  unit,
}: {
  action: Action;
  targets: Option[];
  suggested?: string;
  quantity: string;
  unit: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("putaway.confirm")}
      pendingLabel={t("common.saving")}
      className="flex flex-wrap items-end gap-2"
    >
      <SelectField
        name="toLocationId"
        label={t("putaway.to")}
        options={targets}
        placeholder={t("common.select")}
        defaultValue={suggested}
        required
      />
      <TextField
        name="quantity"
        label={`${t("putaway.quantity")} (${unit})`}
        defaultValue={quantity}
        inputMode="decimal"
        dir="ltr"
        required
      />
    </ActionForm>
  );
}

export function PutawayRuleForm({
  action,
  locations,
  products,
  categories,
}: {
  action: Action;
  locations: Option[];
  products: Option[];
  categories: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("putaway.addRule")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-5">
        <TextField
          name="priority"
          label={t("putaway.priority")}
          hint={t("putaway.priorityHint")}
          inputMode="numeric"
          dir="ltr"
          required
        />
        <SelectField
          name="productId"
          label={t("putaway.product")}
          options={products}
          placeholder={t("putaway.any")}
        />
        <SelectField
          name="categoryId"
          label={t("putaway.category")}
          options={categories}
          placeholder={t("putaway.any")}
        />
        <SelectField
          name="storageRequirement"
          label={t("putaway.storage")}
          options={(["AMBIENT", "CHILLED", "FROZEN"] as const).map((z) => ({
            value: z,
            label: t(`catalog.zones.${z}`),
          }))}
          placeholder={t("putaway.any")}
        />
        <SelectField
          name="locationId"
          label={t("putaway.location")}
          options={locations}
          placeholder={t("common.select")}
          required
        />
      </div>
    </ActionForm>
  );
}
