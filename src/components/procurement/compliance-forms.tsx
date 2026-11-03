"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { initialActionState, type ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxField, SelectField, TextField } from "@/components/forms/fields";
import { buttonClass } from "@/components/ui/styles";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export const SUPPLIER_DOCUMENT_TYPES = [
  "COMMERCIAL_REGISTRATION",
  "VAT_CERTIFICATE",
  "MUNICIPALITY_LICENSE",
  "FOOD_SAFETY_CERTIFICATE",
  "HALAL_CERTIFICATE",
  "ISO_CERTIFICATE",
  "INSURANCE",
  "CONTRACT",
  "OTHER",
] as const;

/** A licence, certificate or contract with its dates (ADR-091). */
export function SupplierDocumentForm({
  action,
  submitLabel,
  defaults = {},
}: {
  action: Action;
  submitLabel: string;
  defaults?: Partial<
    Record<"type" | "title" | "number" | "issuedOn" | "expiresOn" | "note", string>
  > & {
    requiredToBuy?: boolean;
  };
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={submitLabel} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="type"
          label={t("suppliers.compliance.documentType")}
          required
          defaultValue={defaults.type}
          options={SUPPLIER_DOCUMENT_TYPES.map((v) => ({
            value: v,
            label: t(`suppliers.compliance.documentTypes.${v}`),
          }))}
        />
        <TextField
          name="title"
          label={t("suppliers.compliance.documentTitle")}
          hint={t("suppliers.compliance.documentTitleHint")}
          defaultValue={defaults.title}
        />
        <TextField
          name="number"
          label={t("suppliers.compliance.documentNumber")}
          defaultValue={defaults.number}
          dir="ltr"
        />
        <TextField
          name="issuedOn"
          type="date"
          label={t("suppliers.compliance.issuedOn")}
          defaultValue={defaults.issuedOn}
        />
        <TextField
          name="expiresOn"
          type="date"
          label={t("suppliers.compliance.expiresOn")}
          defaultValue={defaults.expiresOn}
        />
        <TextField name="note" label={t("suppliers.note")} defaultValue={defaults.note} />
      </div>
      <CheckboxField
        name="requiredToBuy"
        label={
          <span>
            {t("suppliers.compliance.requiredToBuy")}
            <span className="text-muted block text-xs">
              {t("suppliers.compliance.requiredToBuyHint")}
            </span>
          </span>
        }
        defaultChecked={defaults.requiredToBuy}
      />
    </ActionForm>
  );
}

export function SupplierBankAccountForm({
  action,
  currencies,
}: {
  action: Action;
  currencies: Array<{ value: string; label: string }>;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("suppliers.compliance.addBankAccount")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="bankName" label={t("suppliers.compliance.bankName")} required />
        <TextField
          name="accountName"
          label={t("suppliers.compliance.accountName")}
          hint={t("suppliers.compliance.accountNameHint")}
          required
        />
        <SelectField
          name="kind"
          label={t("suppliers.compliance.accountKind")}
          required
          defaultValue="IBAN"
          options={(["IBAN", "ACCOUNT_NUMBER"] as const).map((v) => ({
            value: v,
            label: t(`suppliers.compliance.accountKinds.${v}`),
          }))}
        />
        <TextField
          name="account"
          label={t("suppliers.compliance.account")}
          required
          dir="ltr"
          autoComplete="off"
        />
        <TextField
          name="swiftBic"
          label={t("suppliers.compliance.swiftBic")}
          hint={t("suppliers.compliance.swiftHint")}
          dir="ltr"
        />
        <SelectField
          name="currency"
          label={t("suppliers.currency")}
          options={currencies}
          placeholder="—"
        />
      </div>
      <p className="text-muted text-xs">{t("suppliers.compliance.bankAccountHint")}</p>
    </ActionForm>
  );
}

/** Shows the full account number on request; each look is recorded in the audit log. */
export function RevealAccountButton({ action }: { action: Action }) {
  const t = useTranslations();
  const [state, formAction, pending] = useActionState(action, initialActionState);
  if (state.ok && state.data?.account)
    return (
      <span className="ltr-value font-mono text-sm" dir="ltr">
        {state.data.account}
      </span>
    );
  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      <button type="submit" disabled={pending} className={buttonClass("secondary")}>
        {t("suppliers.compliance.reveal")}
      </button>
      {state.formError ? (
        <span role="alert" className="text-danger text-xs">
          {state.formError}
        </span>
      ) : null}
    </form>
  );
}
