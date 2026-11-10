"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";
import { inputClass } from "@/components/ui/styles";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function MenuCategoryForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("menu.addCategory")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="name" label={t("menu.name")} required />
        <TextField name="nameAr" label={t("menu.nameAr")} optionalLabel={t("common.optional")} />
        <TextField
          name="sortOrder"
          label={t("menu.sortOrder")}
          inputMode="numeric"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

/** An item uses a dish recipe or a stock product; a combo is made of other items. */
export function MenuItemForm({
  action,
  categories,
  recipes,
  products,
  taxCodes,
  defaults,
  submitLabel,
  kindFixed = false,
}: {
  action: Action;
  categories: Option[];
  recipes: Option[];
  products: Option[];
  taxCodes: Option[];
  defaults?: Record<string, string | undefined>;
  submitLabel: string;
  kindFixed?: boolean;
}) {
  const t = useTranslations();
  const opt = t("common.optional");
  const [kind, setKind] = useState(defaults?.kind ?? "ITEM");
  const [uses, setUses] = useState(defaults?.productId ? "PRODUCT" : "RECIPE");
  return (
    <ActionForm
      action={action}
      submitLabel={submitLabel}
      pendingLabel={t("common.saving")}
      idempotent={!defaults}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="code"
          label={t("menu.code")}
          defaultValue={defaults?.code}
          dir="ltr"
          required
        />
        <TextField name="name" label={t("menu.name")} defaultValue={defaults?.name} required />
        <TextField
          name="nameAr"
          label={t("menu.nameAr")}
          defaultValue={defaults?.nameAr}
          optionalLabel={opt}
        />
        <SelectField
          name="categoryId"
          label={t("menu.category")}
          options={categories}
          defaultValue={defaults?.categoryId}
          placeholder={t("common.select")}
          required
        />
        <div>
          <label htmlFor="menu-kind" className="mb-1 block text-sm font-medium">
            {t("menu.kind")}
          </label>
          <select
            id="menu-kind"
            name="kind"
            value={kind}
            disabled={kindFixed}
            onChange={(e) => setKind(e.target.value)}
            className={inputClass}
          >
            <option value="ITEM">{t("menu.kinds.ITEM")}</option>
            <option value="COMBO">{t("menu.kinds.COMBO")}</option>
          </select>
          {kindFixed ? <input type="hidden" name="kind" value={kind} /> : null}
        </div>
        {kind === "ITEM" ? (
          <div>
            <label htmlFor="menu-uses" className="mb-1 block text-sm font-medium">
              {t("menu.uses")}
            </label>
            <select
              id="menu-uses"
              value={uses}
              onChange={(e) => setUses(e.target.value)}
              className={inputClass}
            >
              <option value="RECIPE">{t("menu.usesRecipe")}</option>
              <option value="PRODUCT">{t("menu.usesProduct")}</option>
            </select>
          </div>
        ) : (
          <p className="text-muted self-end text-sm">{t("menu.comboHint")}</p>
        )}
        {kind === "ITEM" && uses === "RECIPE" ? (
          <SelectField
            name="recipeId"
            label={t("menu.recipe")}
            hint={t("menu.recipeHint")}
            options={recipes}
            defaultValue={defaults?.recipeId}
            placeholder={t("common.select")}
            required
          />
        ) : null}
        {kind === "ITEM" && uses === "PRODUCT" ? (
          <>
            <SelectField
              name="productId"
              label={t("menu.product")}
              options={products}
              defaultValue={defaults?.productId}
              placeholder={t("common.select")}
              required
            />
            <TextField
              name="productQuantity"
              label={t("menu.productQuantity")}
              hint={t("menu.productQuantityHint")}
              defaultValue={defaults?.productQuantity}
              inputMode="decimal"
              dir="ltr"
              optionalLabel={opt}
            />
          </>
        ) : null}
        <SelectField
          name="taxCodeId"
          label={t("menu.taxCode")}
          hint={t("menu.taxCodeHint")}
          options={taxCodes}
          defaultValue={defaults?.taxCodeId}
          placeholder="—"
        />
        <TextField
          name="barcode"
          label={t("menu.barcode")}
          hint={t("menu.barcodeHint")}
          defaultValue={defaults?.barcode}
          dir="ltr"
          optionalLabel={opt}
        />
        <TextField
          name="sortOrder"
          label={t("menu.sortOrder")}
          defaultValue={defaults?.sortOrder}
          inputMode="numeric"
          dir="ltr"
          optionalLabel={opt}
        />
        <TextField
          name="description"
          label={t("menu.description")}
          defaultValue={defaults?.description}
          optionalLabel={opt}
        />
      </div>
    </ActionForm>
  );
}

export function MenuPriceForm({
  action,
  channels,
  branches,
  currency,
  today,
  includesTax,
}: {
  action: Action;
  channels: Option[];
  branches: Option[];
  currency: string;
  today: string;
  includesTax: boolean;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("menu.addPrice")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-4">
        <SelectField
          name="channel"
          label={t("menu.channel")}
          options={channels}
          defaultValue="DINE_IN"
          required
        />
        <SelectField
          name="branchId"
          label={t("menu.branch")}
          options={branches}
          placeholder={t("menu.allBranches")}
        />
        <TextField
          name="price"
          label={t("menu.priceIn", { currency })}
          hint={t(includesTax ? "menu.priceInclVat" : "menu.priceExclVat")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="effectiveFrom"
          type="date"
          label={t("menu.effectiveFrom")}
          defaultValue={today}
          required
        />
      </div>
    </ActionForm>
  );
}

export function AttachGroupForm({ action, groups }: { action: Action; groups: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("menu.attachGroup")}
      pendingLabel={t("common.saving")}
    >
      <SelectField
        name="groupId"
        label={t("menu.modifierGroup")}
        options={groups}
        placeholder={t("common.select")}
        required
      />
    </ActionForm>
  );
}

export function ComboComponentForm({ action, items }: { action: Action; items: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("menu.addComponent")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="componentId"
          label={t("menu.component")}
          options={items}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="quantity"
          label={t("menu.quantity")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function ModifierGroupForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("menu.addGroup")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-4">
        <TextField name="name" label={t("menu.name")} required />
        <TextField name="nameAr" label={t("menu.nameAr")} optionalLabel={t("common.optional")} />
        <TextField
          name="minSelect"
          label={t("menu.minSelect")}
          defaultValue="0"
          inputMode="numeric"
          dir="ltr"
          required
        />
        <TextField
          name="maxSelect"
          label={t("menu.maxSelect")}
          defaultValue="1"
          inputMode="numeric"
          dir="ltr"
          required
        />
      </div>
    </ActionForm>
  );
}

export function ModifierOptionForm({
  action,
  recipes,
  products,
}: {
  action: Action;
  recipes: Option[];
  products: Option[];
}) {
  const t = useTranslations();
  const opt = t("common.optional");
  return (
    <ActionForm action={action} submitLabel={t("menu.addOption")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="name" label={t("menu.optionName")} required />
        <TextField name="nameAr" label={t("menu.nameAr")} optionalLabel={opt} />
        <TextField
          name="priceDelta"
          label={t("menu.priceDelta")}
          hint={t("menu.priceDeltaHint")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={opt}
        />
        <SelectField
          name="recipeId"
          label={t("menu.usesRecipe")}
          options={recipes}
          placeholder="—"
        />
        <SelectField
          name="productId"
          label={t("menu.usesProduct")}
          options={products}
          placeholder="—"
        />
        <TextField
          name="quantity"
          label={t("menu.optionQuantity")}
          hint={t("menu.optionQuantityHint")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={opt}
        />
      </div>
    </ActionForm>
  );
}
