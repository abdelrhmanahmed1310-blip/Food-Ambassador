"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function ProductionOrderForm({
  action,
  recipes,
  warehouses,
  defaults = {},
}: {
  action: Action;
  recipes: Option[];
  warehouses: Option[];
  defaults?: { recipeId?: string; warehouseId?: string; plannedQuantity?: string };
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("production.create")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="recipeId"
          label={t("production.recipe")}
          options={recipes}
          placeholder={t("common.select")}
          defaultValue={defaults.recipeId}
          required
        />
        <SelectField
          name="warehouseId"
          label={t("production.warehouse")}
          options={warehouses}
          placeholder={t("common.select")}
          defaultValue={
            defaults.warehouseId ?? (warehouses.length === 1 ? warehouses[0].value : undefined)
          }
          required
        />
        <TextField
          name="plannedQuantity"
          label={t("production.plannedQuantity")}
          hint={t("production.plannedQuantityHint")}
          defaultValue={defaults.plannedQuantity}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="plannedFor"
          type="date"
          label={t("production.plannedFor")}
          optionalLabel={t("common.optional")}
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export function CompleteProductionForm({
  action,
  unit,
  plannedQuantity,
  lotTracked,
  defaultLot,
}: {
  action: Action;
  unit: string;
  plannedQuantity: string;
  lotTracked: boolean;
  defaultLot: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("production.complete")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          name="producedQuantity"
          label={t("production.producedIn", { unit })}
          hint={t("production.producedHint")}
          defaultValue={plannedQuantity}
          inputMode="decimal"
          dir="ltr"
        />
        {lotTracked ? (
          <>
            <TextField
              name="lotCode"
              label={t("production.lotCode")}
              defaultValue={defaultLot}
              dir="ltr"
            />
            <TextField
              name="expiresOn"
              type="date"
              label={t("production.expiresOn")}
              hint={t("production.expiresOnHint")}
              optionalLabel={t("common.optional")}
            />
          </>
        ) : null}
      </div>
    </ActionForm>
  );
}

export function OutputProductForm({
  action,
  products,
  current,
}: {
  action: Action;
  products: Option[];
  current?: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.save")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <SelectField
        name="productId"
        label={t("production.outputProduct")}
        hint={t("production.outputProductHint")}
        options={products}
        placeholder={t("production.noOutput")}
        defaultValue={current}
        optionalLabel={t("common.optional")}
      />
    </ActionForm>
  );
}
