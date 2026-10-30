"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { initialActionState, type ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, SubmitButton } from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function LibraryImportForm({ action, sources }: { action: Action; sources: Option[] }) {
  const t = useTranslations();
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="library-source" className="mb-1 block text-sm font-medium">
            {t("library.source")}
          </label>
          <select
            id="library-source"
            name="source"
            required
            defaultValue=""
            className="border-border bg-surface w-full rounded-md border px-3 py-2 text-sm"
          >
            <option value="">{t("common.select")}</option>
            {sources.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="library-file" className="mb-1 block text-sm font-medium">
            {t("library.file")}
          </label>
          <input
            id="library-file"
            name="file"
            type="file"
            accept=".json,.jsonl,application/json"
            required
            className="block text-sm"
          />
        </div>
      </div>
      <SubmitButton label={t("library.import")} pendingLabel={t("common.saving")} />
      {state.formError ? (
        <p
          role="alert"
          className="border-danger/40 bg-danger-surface text-danger rounded-md border px-3 py-2 text-sm"
        >
          {state.formError}
        </p>
      ) : null}
      {state.ok && state.message ? (
        <p
          role="status"
          className="border-success/40 bg-success-surface text-success rounded-md border px-3 py-2 text-sm"
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function LinkReferenceForm({
  action,
  products,
  hasValues,
  hasAllergens,
  hasArabicName,
}: {
  action: Action;
  products: Option[];
  hasValues: boolean;
  hasAllergens: boolean;
  hasArabicName: boolean;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("library.link")} pendingLabel={t("common.saving")}>
      <SelectField
        name="productId"
        label={t("library.product")}
        options={products}
        placeholder={t("common.select")}
        required
      />
      <div className="space-y-2">
        {hasValues ? (
          <CheckboxField name="nutrition" label={t("library.useValues")} defaultChecked />
        ) : null}
        {hasAllergens ? (
          <CheckboxField name="allergens" label={t("library.useAllergens")} defaultChecked />
        ) : null}
        {hasArabicName ? (
          <CheckboxField name="arabicName" label={t("library.useArabicName")} defaultChecked />
        ) : null}
      </div>
    </ActionForm>
  );
}
