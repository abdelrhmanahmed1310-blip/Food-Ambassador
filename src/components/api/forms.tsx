"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import {
  ActionForm,
  CheckboxGroup,
  CopyField,
  SelectField,
  TextField,
  useFormState,
} from "@/components/forms/fields";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** The new key, shown once: it cannot be read again later (ADR-090). */
function NewKey() {
  const t = useTranslations("api");
  const state = useFormState();
  if (!state.ok || !state.data?.key) return null;
  return (
    <div
      className="border-warning/40 bg-warning-surface space-y-3 rounded-md border p-3"
      data-testid="api-key-once"
    >
      <CopyField
        value={state.data.key}
        label={t("key")}
        copyLabel={t("copy")}
        copiedLabel={t("copied")}
      />
      <p className="text-sm">{t("keyOnce")}</p>
    </div>
  );
}

export function CreateApiKeyForm({
  action,
  scopes,
  companies,
}: {
  action: Action;
  scopes: Option[];
  companies: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("api.create")}
      pendingLabel={t("common.saving")}
      idempotent
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="name" label={t("api.name")} hint={t("api.nameHint")} required />
        {companies.length > 1 ? (
          <SelectField
            name="companyId"
            label={t("api.company")}
            placeholder={t("api.allCompanies")}
            options={companies}
          />
        ) : null}
      </div>
      <CheckboxGroup name="scopes" legend={t("api.scopes")} options={scopes} />
      <NewKey />
    </ActionForm>
  );
}
