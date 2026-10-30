"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxGroup, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

function YieldFields({
  units,
  defaults = {},
}: {
  units: Option[];
  defaults?: { yieldQuantity?: string; yieldUomId?: string; portions?: string };
}) {
  const t = useTranslations();
  return (
    <>
      <TextField
        name="yieldQuantity"
        label={t("recipes.yieldQuantity")}
        hint={t("recipes.yieldHint")}
        defaultValue={defaults.yieldQuantity}
        inputMode="decimal"
        dir="ltr"
        required
      />
      <SelectField
        name="yieldUomId"
        label={t("recipes.yieldUnit")}
        options={units}
        placeholder={t("common.select")}
        defaultValue={defaults.yieldUomId}
        required
      />
      <TextField
        name="portions"
        label={t("recipes.portions")}
        hint={t("recipes.portionsHint")}
        defaultValue={defaults.portions}
        inputMode="decimal"
        dir="ltr"
        optionalLabel={t("common.optional")}
      />
    </>
  );
}

export function NewRecipeForm({ action, units }: { action: Action; units: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.create")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="code" label={t("recipes.code")} dir="ltr" required />
        <SelectField
          name="type"
          label={t("recipes.type")}
          options={[
            { value: "DISH", label: t("recipes.types.DISH") },
            { value: "PREPARATION", label: t("recipes.types.PREPARATION") },
          ]}
          placeholder={t("common.select")}
          required
        />
        <TextField name="name" label={t("recipes.name")} required />
        <TextField
          name="nameAr"
          label={t("recipes.nameAr")}
          dir="rtl"
          optionalLabel={t("common.optional")}
        />
        <YieldFields units={units} />
        <div className="sm:col-span-2">
          <TextField
            name="description"
            label={t("recipes.description")}
            optionalLabel={t("common.optional")}
          />
        </div>
      </div>
    </ActionForm>
  );
}

export function RecipeHeaderForm({
  action,
  defaults,
}: {
  action: Action;
  defaults: { name: string; nameAr?: string; description?: string };
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="name" label={t("recipes.name")} defaultValue={defaults.name} required />
        <TextField
          name="nameAr"
          label={t("recipes.nameAr")}
          dir="rtl"
          defaultValue={defaults.nameAr}
          optionalLabel={t("common.optional")}
        />
        <div className="sm:col-span-2">
          <TextField
            name="description"
            label={t("recipes.description")}
            defaultValue={defaults.description}
            optionalLabel={t("common.optional")}
          />
        </div>
      </div>
    </ActionForm>
  );
}

export function VersionForm({
  action,
  units,
  defaults,
}: {
  action: Action;
  units: Option[];
  defaults: {
    yieldQuantity: string;
    yieldUomId: string;
    portions?: string;
    note?: string;
    method?: string;
  };
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <YieldFields units={units} defaults={defaults} />
        <div className="sm:col-span-3">
          <TextField
            name="note"
            label={t("common.note")}
            defaultValue={defaults.note}
            optionalLabel={t("common.optional")}
          />
        </div>
        <div className="sm:col-span-3">
          <label className="block text-sm font-medium" htmlFor="recipe-method">
            {t("recipes.method")}{" "}
            <span className="text-muted font-normal">({t("common.optional")})</span>
          </label>
          <textarea
            id="recipe-method"
            name="method"
            rows={6}
            maxLength={5000}
            defaultValue={defaults.method}
            className="border-border bg-surface mt-1 w-full rounded-md border px-3 py-2 text-sm"
          />
        </div>
      </div>
    </ActionForm>
  );
}

export function IngredientForm({
  action,
  items,
  units,
}: {
  action: Action;
  items: Option[];
  units: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("recipes.addIngredient")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <SelectField
            name="item"
            label={t("recipes.ingredient")}
            options={items}
            placeholder={t("common.select")}
            required
          />
        </div>
        <TextField
          name="quantity"
          label={t("recipes.netQuantity")}
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
          name="wastePercent"
          label={t("recipes.wastePercent")}
          hint={t("recipes.wasteHint")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <div className="sm:col-span-3">
          <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
        </div>
      </div>
    </ActionForm>
  );
}

export function StandardCostForm({
  action,
  currency,
  baseUnit,
  today,
}: {
  action: Action;
  currency: string;
  baseUnit: string;
  today: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("recipes.addStandardCost")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          name="unitCost"
          label={`${t("recipes.standardCost")} (${currency} / ${baseUnit})`}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="effectiveFrom"
          type="date"
          label={t("recipes.effectiveFrom")}
          defaultValue={today}
          required
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export function RecipePriceForm({
  action,
  currency,
  today,
}: {
  action: Action;
  currency: string;
  today: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("recipes.addPrice")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          name="price"
          label={`${t("recipes.sellingPrice")} (${currency})`}
          hint={t("recipes.priceHint")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="effectiveFrom"
          type="date"
          label={t("recipes.effectiveFrom")}
          defaultValue={today}
          required
        />
        <TextField name="note" label={t("common.note")} optionalLabel={t("common.optional")} />
      </div>
    </ActionForm>
  );
}

export function TargetForm({
  action,
  label,
  hint,
  defaultValue,
}: {
  action: Action;
  label: string;
  hint: string;
  defaultValue?: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("common.save")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <TextField
        name="targetPercent"
        label={label}
        hint={hint}
        defaultValue={defaultValue}
        inputMode="decimal"
        dir="ltr"
        optionalLabel={t("common.optional")}
      />
    </ActionForm>
  );
}

export function BulkReplaceForm({
  action,
  fromProductId,
  products,
  recipes,
}: {
  action: Action;
  fromProductId: string;
  products: Option[];
  recipes: Array<{ value: string; label: string; hint?: string }>;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("recipes.replace")}
      pendingLabel={t("common.saving")}
    >
      <input type="hidden" name="fromProductId" value={fromProductId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="toProductId"
          label={t("recipes.replaceWith")}
          options={products}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="factor"
          label={t("recipes.quantityFactor")}
          hint={t("recipes.quantityFactorHint")}
          defaultValue="1"
          inputMode="decimal"
          dir="ltr"
          required
        />
      </div>
      <CheckboxGroup
        name="recipeId"
        legend={t("recipes.recipesToChange")}
        options={recipes}
        defaultValues={recipes.map((r) => r.value)}
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="activate" />
        {t("recipes.activateNow")}
      </label>
    </ActionForm>
  );
}
