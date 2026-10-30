"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxGroup, SelectField, TextField } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function NewRecallForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.create")} pendingLabel={t("common.saving")}>
      <TextField name="title" label={t("recalls.recallTitle")} required />
      <TextField
        name="reason"
        label={t("recalls.reason")}
        hint={t("recalls.reasonHint")}
        required
      />
    </ActionForm>
  );
}

export function AddLotsForm({
  action,
  lots,
}: {
  action: Action;
  lots: Array<{ value: string; label: string; hint?: string }>;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("recalls.addLots")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <CheckboxGroup name="lotId" legend={t("recalls.foundLots")} options={lots} />
    </ActionForm>
  );
}

export function SupplierLotsForm({
  action,
  suppliers,
  products,
}: {
  action: Action;
  suppliers: Option[];
  products: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("recalls.addSupplierLots")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="supplierId"
          label={t("purchasing.supplier")}
          options={suppliers}
          placeholder={t("common.select")}
          required
        />
        <SelectField
          name="productId"
          label={t("purchasing.product")}
          options={products}
          placeholder={t("recalls.allProducts")}
          optionalLabel={t("common.optional")}
        />
      </div>
    </ActionForm>
  );
}

export function CloseRecallForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("recalls.close")}
      pendingLabel={t("common.saving")}
      submitVariant="danger"
    >
      <SelectField
        name="outcome"
        label={t("recalls.outcome")}
        options={[
          { value: "DISPOSED", label: t("recalls.outcomes.DISPOSED") },
          { value: "RELEASED", label: t("recalls.outcomes.RELEASED") },
        ]}
        placeholder={t("common.select")}
        required
      />
      <TextField
        name="note"
        label={t("recalls.closeNote")}
        hint={t("recalls.closeHint")}
        required
      />
    </ActionForm>
  );
}
