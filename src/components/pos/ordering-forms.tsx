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
  registers,
  onlinePayments,
}: {
  action: Action;
  branches: Array<{ value: string; label: string }>;
  registers: Array<{ value: string; label: string }>;
  /** A payment provider is set up (Settings → Online payments). */
  onlinePayments: boolean;
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
      <fieldset className="border-border space-y-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t("ordering.payment")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            name="paymentMode"
            label={t("ordering.paymentMode")}
            hint={onlinePayments ? t("ordering.paymentModeHint") : t("ordering.noProvider")}
            options={(["COUNTER", ...(onlinePayments ? ["ONLINE", "CHOICE"] : [])] as const).map(
              (m) => ({ value: m, label: t(`ordering.paymentModes.${m}`) }),
            )}
          />
          <SelectField
            name="registerId"
            label={t("ordering.paymentRegister")}
            hint={t("ordering.paymentRegisterHint")}
            options={registers}
            placeholder="—"
          />
        </div>
      </fieldset>
      <fieldset className="border-border space-y-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t("ordering.pickupTimes")}</legend>
        <CheckboxField name="scheduling" label={t("ordering.scheduling")} />
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            name="openFrom"
            label={t("ordering.openFrom")}
            hint={t("ordering.timeHint")}
            dir="ltr"
            optionalLabel={t("common.optional")}
          />
          <TextField
            name="openTo"
            label={t("ordering.openTo")}
            dir="ltr"
            optionalLabel={t("common.optional")}
          />
          <SelectField
            name="slotMinutes"
            label={t("ordering.slotMinutes")}
            options={[5, 10, 15, 20, 30, 60].map((m) => ({ value: String(m), label: String(m) }))}
            defaultValue="15"
          />
          <TextField
            name="leadMinutes"
            label={t("ordering.leadMinutes")}
            hint={t("ordering.leadMinutesHint")}
            defaultValue="20"
            dir="ltr"
            inputMode="numeric"
          />
          <TextField
            name="slotCapacity"
            label={t("ordering.slotCapacity")}
            hint={t("ordering.slotCapacityHint")}
            dir="ltr"
            inputMode="numeric"
            optionalLabel={t("common.optional")}
          />
          <TextField
            name="daysAhead"
            label={t("ordering.daysAhead")}
            hint={t("ordering.daysAheadHint")}
            defaultValue="0"
            dir="ltr"
            inputMode="numeric"
          />
        </div>
      </fieldset>
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
