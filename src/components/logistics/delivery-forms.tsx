"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, TextField } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Where a delivery order goes (ADR-117): kept for this delivery only, erased 30 days after. */
export function HomeDeliveryForm({ action }: { action: Action }) {
  const t = useTranslations();
  const optional = t("common.optional");
  return (
    <ActionForm
      action={action}
      submitLabel={t("homeDelivery.create")}
      pendingLabel={t("common.saving")}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="contactName"
          label={t("homeDelivery.contactName")}
          optionalLabel={optional}
        />
        <TextField name="phone" label={t("homeDelivery.phone")} dir="ltr" required />
        <TextField name="address" label={t("homeDelivery.address")} required />
        <TextField
          name="directions"
          label={t("homeDelivery.directions")}
          optionalLabel={optional}
        />
      </div>
    </ActionForm>
  );
}

export function DeliveredForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("homeDelivery.delivered")}
      pendingLabel={t("common.saving")}
    >
      <TextField
        name="recipientName"
        label={t("homeDelivery.recipient")}
        optionalLabel={t("common.optional")}
      />
    </ActionForm>
  );
}
