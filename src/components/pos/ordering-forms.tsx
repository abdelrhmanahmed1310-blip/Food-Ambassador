"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import {
  ActionForm,
  CheckboxField,
  CheckboxGroup,
  SelectField,
  TextField,
} from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** A web ordering page or a kiosk for one branch (ADR-070). */
export function OrderingChannelForm({
  action,
  branches,
}: {
  action: Action;
  branches: Array<{ value: string; label: string }>;
}) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("ordering.addChannel")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          name="kind"
          label={t("ordering.kind")}
          options={[
            { value: "WEB", label: t("ordering.kinds.WEB") },
            { value: "KIOSK", label: t("ordering.kinds.KIOSK") },
          ]}
          required
        />
        <TextField name="name" label={t("ordering.channelName")} required />
        <SelectField name="branchId" label={t("ordering.branch")} options={branches} required />
      </div>
      <CheckboxGroup
        name="channels"
        legend={t("ordering.takes")}
        options={[
          { value: "TAKEAWAY", label: t("ordering.channels.TAKEAWAY") },
          { value: "DINE_IN", label: t("ordering.channels.DINE_IN") },
        ]}
        defaultValues={["TAKEAWAY"]}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          name="maxOrderTotal"
          label={t("ordering.maxOrderTotal")}
          hint={t("ordering.maxOrderTotalHint")}
          dir="ltr"
          inputMode="decimal"
          optionalLabel={t("common.optional")}
        />
      </div>
      <CheckboxField name="autoSend" label={t("ordering.autoSend")} />
    </ActionForm>
  );
}

export function RejectGuestForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("ordering.reject")}
      submitVariant="danger"
      pendingLabel={t("common.saving")}
      className="flex flex-wrap items-end gap-2"
    >
      <TextField name="reason" label={t("ordering.rejectReason")} required />
    </ActionForm>
  );
}
