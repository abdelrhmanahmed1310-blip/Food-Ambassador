"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const GROUPS = [
  "OCCUPANCY",
  "UTILITIES",
  "STAFF",
  "MARKETING",
  "REPAIRS",
  "ADMINISTRATION",
  "DELIVERY",
  "OTHER",
] as const;

/** Record an operating expense (ADR-109). */
export function ExpenseForm({
  action,
  branches,
  categories,
  centres,
  suppliers,
  today,
}: {
  action: Action;
  branches: Option[];
  categories: Option[];
  centres: Option[];
  suppliers: Option[];
  today: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("expenses.record")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="branchId"
          label={t("expenses.branch")}
          options={branches}
          placeholder={t("common.select")}
          defaultValue={branches.length === 1 ? branches[0].value : undefined}
          required
        />
        <SelectField
          name="categoryId"
          label={t("expenses.category")}
          options={categories}
          placeholder={t("common.select")}
          required
        />
        <TextField
          name="expenseDate"
          type="date"
          label={t("expenses.date")}
          defaultValue={today}
          required
        />
        <div className="sm:col-span-2">
          <TextField name="description" label={t("expenses.description")} required />
        </div>
        <TextField
          name="reference"
          label={t("expenses.reference")}
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <TextField
          name="netAmount"
          label={t("expenses.net")}
          inputMode="decimal"
          dir="ltr"
          required
        />
        <TextField
          name="taxAmount"
          label={t("expenses.tax")}
          hint={t("expenses.taxHint")}
          inputMode="decimal"
          dir="ltr"
          optionalLabel={t("common.optional")}
        />
        <SelectField
          name="costCentreId"
          label={t("expenses.costCentre")}
          options={centres}
          placeholder="—"
        />
        {suppliers.length > 0 ? (
          <SelectField
            name="supplierId"
            label={t("expenses.supplier")}
            options={suppliers}
            placeholder="—"
          />
        ) : null}
      </div>
    </ActionForm>
  );
}

export function CategoryForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("expenses.addCategory")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <TextField name="code" label={t("expenses.code")} dir="ltr" required />
        <TextField name="name" label={t("expenses.name")} required />
        <TextField
          name="nameAr"
          label={t("expenses.nameAr")}
          dir="rtl"
          optionalLabel={t("common.optional")}
        />
        <SelectField
          name="group"
          label={t("expenses.group")}
          hint={t("expenses.groupHint")}
          options={GROUPS.map((g) => ({ value: g, label: t(`expenses.groups.${g}`) }))}
          placeholder={t("common.select")}
          required
        />
      </div>
    </ActionForm>
  );
}

export function CostCentreForm({ action, branches }: { action: Action; branches: Option[] }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("expenses.addCentre")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField name="code" label={t("expenses.code")} dir="ltr" required />
        <TextField name="name" label={t("expenses.name")} required />
        <SelectField
          name="branchId"
          label={t("expenses.branch")}
          hint={t("expenses.centreBranchHint")}
          options={branches}
          placeholder={t("expenses.shared")}
        />
      </div>
    </ActionForm>
  );
}
