"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ActionState } from "@/components/forms/action-state";
import { initialActionState } from "@/components/forms/action-state";
import {
  ActionForm,
  CheckboxGroup,
  CopyField,
  FormStateContext,
  SelectField,
  SubmitButton,
  TextField,
  useFormState,
} from "@/components/forms/fields";
import { inputClass } from "@/components/ui/styles";

type Option = { value: string; label: string };
type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Shown once after create or rotate: the secret is not retrievable later. */
function SecretOnce({ secret, endpoint }: { secret: string; endpoint?: string }) {
  const t = useTranslations("integrations");
  return (
    <div className="border-warning/40 bg-warning-surface space-y-3 rounded-md border p-3">
      {endpoint ? (
        <CopyField
          value={endpoint}
          label={t("endpoint")}
          copyLabel={t("copy")}
          copiedLabel={t("copied")}
        />
      ) : null}
      <CopyField
        value={secret}
        label={t("signingSecret")}
        copyLabel={t("copy")}
        copiedLabel={t("copied")}
      />
      <p className="text-sm">{t("secretOnce")}</p>
    </div>
  );
}

function CreatedNotice({ orgSlug }: { orgSlug: string }) {
  const t = useTranslations("integrations");
  const state = useFormState();
  if (!state.ok || !state.data?.secret) return null;
  return (
    <div className="space-y-2">
      <SecretOnce secret={state.data.secret} endpoint={state.data.endpoint} />
      <Link
        className="text-primary text-sm underline"
        href={`/o/${orgSlug}/settings/integrations/${state.data.connectorId}`}
      >
        {t("openConnector")}
      </Link>
    </div>
  );
}

export function CreateConnectorForm({
  action,
  orgSlug,
  warehouses,
  events,
}: {
  action: Action;
  orgSlug: string;
  warehouses: Option[];
  events: string[];
}) {
  const t = useTranslations();
  const [kind, setKind] = useState("INBOUND_SALES_WEBHOOK");
  return (
    <ActionForm
      action={action}
      submitLabel={t("integrations.create")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="connector-kind" className="mb-1 block text-sm font-medium">
            {t("integrations.kind")}
          </label>
          <select
            id="connector-kind"
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className={inputClass}
          >
            <option value="INBOUND_SALES_WEBHOOK">
              {t("integrations.kinds.INBOUND_SALES_WEBHOOK")}
            </option>
            <option value="OUTBOUND_WEBHOOK">{t("integrations.kinds.OUTBOUND_WEBHOOK")}</option>
          </select>
        </div>
        <TextField name="name" label={t("integrations.name")} required />
      </div>
      {kind === "INBOUND_SALES_WEBHOOK" ? (
        <SelectField
          name="warehouseId"
          label={t("integrations.warehouse")}
          options={warehouses}
          placeholder="—"
          required
        />
      ) : (
        <>
          <TextField
            name="url"
            label={t("integrations.url")}
            dir="ltr"
            hint={t("integrations.urlHint")}
            required
          />
          <CheckboxGroup
            name="events"
            legend={t("integrations.events")}
            options={events.map((e) => ({ value: e, label: e }))}
          />
        </>
      )}
      <CreatedNotice orgSlug={orgSlug} />
    </ActionForm>
  );
}

export function RotateSecretForm({ action }: { action: Action }) {
  const t = useTranslations("integrations");
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <FormStateContext value={state}>
      <form
        action={formAction}
        className="space-y-3"
        onSubmit={(e) => {
          if (!window.confirm(t("rotateConfirm"))) e.preventDefault();
        }}
      >
        {state.formError ? (
          <p role="alert" className="text-danger text-sm">
            {state.formError}
          </p>
        ) : null}
        <SubmitButton label={t("rotate")} variant="secondary" />
      </form>
      {state.ok && state.data?.secret ? (
        <div className="mt-3">
          <SecretOnce secret={state.data.secret} />
        </div>
      ) : null}
    </FormStateContext>
  );
}
