"use client";

import { useTranslations } from "next-intl";
import type { ActionState } from "@/components/forms/action-state";
import { ActionForm } from "@/components/forms/fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function PostRevaluationForm({ action }: { action: Action }) {
  const t = useTranslations("revaluation");
  return (
    <ActionForm action={action} submitLabel={t("post")} pendingLabel={t("posting")} idempotent>
      <p className="text-muted text-sm">{t("postHint")}</p>
    </ActionForm>
  );
}
