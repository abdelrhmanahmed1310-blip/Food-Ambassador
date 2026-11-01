"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import {
  ActionForm,
  CheckboxField,
  SelectField,
  TextField,
  useFormState,
} from "@/components/forms/fields";
import { SecretOnce } from "@/components/integrations/forms";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;
type Option = { value: string; label: string };

function Created() {
  const state = useFormState();
  if (!state.ok || !state.data?.secret) return null;
  return <SecretOnce secret={state.data.secret} endpoint={state.data.endpoint} />;
}

/** A delivery platform connector for one register (ADR-069). */
export function DeliveryConnectorForm({
  action,
  platforms,
  registers,
}: {
  action: Action;
  platforms: Option[];
  registers: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("delivery.addConnector")}
      pendingLabel={t("common.saving")}
    >
      <Created />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="name" label={t("delivery.connectorName")} required />
        <SelectField name="platform" label={t("delivery.platform")} options={platforms} required />
        <SelectField
          name="registerId"
          label={t("delivery.register")}
          hint={t("delivery.registerHint")}
          options={registers}
          required
        />
      </div>
      <CheckboxField name="autoAccept" label={t("delivery.autoAccept")} />
    </ActionForm>
  );
}

/** Map one platform id to a menu item or option. */
export function MapForm({
  action,
  kind,
  externalId,
  options,
  label,
}: {
  action: Action;
  kind: "ITEM" | "OPTION";
  externalId: string;
  options: Option[];
  label: string;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("delivery.map")}
      pendingLabel={t("common.saving")}
      className="flex flex-wrap items-end gap-3"
    >
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="externalId" value={externalId} />
      <div className="min-w-60">
        <SelectField name="targetId" label={label} options={options} placeholder="—" required />
      </div>
    </ActionForm>
  );
}

/** Map a platform id typed by hand (before the first order arrives). */
export function ManualMapForm({
  action,
  items,
  options,
}: {
  action: Action;
  items: Option[];
  options: Option[];
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("delivery.map")} pendingLabel={t("common.saving")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="kind"
          label={t("delivery.mapKind")}
          options={[
            { value: "ITEM", label: t("delivery.mapKinds.ITEM") },
            { value: "OPTION", label: t("delivery.mapKinds.OPTION") },
          ]}
          required
        />
        <TextField name="externalId" label={t("delivery.externalId")} dir="ltr" required />
        <SelectField
          name="targetId"
          label={t("delivery.target")}
          options={[...items, ...options]}
          placeholder="—"
          required
        />
      </div>
    </ActionForm>
  );
}

export function RejectForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("delivery.reject")}
      submitVariant="danger"
      pendingLabel={t("common.saving")}
      className="flex flex-wrap items-end gap-2"
    >
      <TextField name="reason" label={t("delivery.rejectReason")} required />
    </ActionForm>
  );
}
