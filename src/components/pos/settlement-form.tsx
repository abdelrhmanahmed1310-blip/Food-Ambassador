"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm } from "@/components/forms/fields";

/** Upload the acquirer's settlement file (CSV). */
export function SettlementForm({
  action,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const t = useTranslations();
  return (
    <ActionForm action={action} submitLabel={t("import.upload")} pendingLabel={t("common.saving")}>
      <div>
        <label htmlFor="settlement-file" className="mb-1 block text-sm font-medium">
          {t("settlements.file")}
        </label>
        <input
          id="settlement-file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          required
          className="block text-sm"
        />
        <p className="text-muted mt-1 text-xs">{t("settlements.fileHint")}</p>
      </div>
    </ActionForm>
  );
}
