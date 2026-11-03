"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm, CheckboxGroup } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Which kinds of notification the user gets (ADR-087). */
export function NotificationPreferencesForm({
  action,
  kinds,
}: {
  action: Action;
  kinds: Array<{ kind: string; label: string; inApp: boolean }>;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("common.save")} pendingLabel={t("common.saving")}>
      <CheckboxGroup
        name="on"
        legend={t("notifications.preferences")}
        options={kinds.map((k) => ({ value: k.kind, label: k.label }))}
        defaultValues={kinds.filter((k) => k.inApp).map((k) => k.kind)}
      />
    </ActionForm>
  );
}

/** "Mark all as read". */
export function MarkAllReadForm({ action }: { action: Action }) {
  const t = useTranslations();
  return (
    <ActionForm
      action={action}
      submitLabel={t("notifications.markAllRead")}
      pendingLabel={t("common.saving")}
      submitVariant="secondary"
    >
      {null}
    </ActionForm>
  );
}
