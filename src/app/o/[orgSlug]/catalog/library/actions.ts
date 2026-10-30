"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import { importLibraryFile, linkReferenceFood } from "@/modules/nutrition/library";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

const MAX_UPLOAD_BYTES = 900_000;

export async function importLibraryAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_UPLOAD_BYTES)
    return { ok: false, seq: (previous.seq ?? 0) + 1, formError: t("library.fileRequired") };
  const content = await file.text();
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await importLibraryFile(ctx, {
      source: String(formData.get("source") ?? ""),
      fileName: file.name,
      content,
    });
    return {
      message: r.alreadyImported
        ? t("library.alreadyImported")
        : t("library.imported", { created: r.created, updated: r.updated, skipped: r.skipped }),
    };
  });
}

export async function linkReferenceAction(
  orgSlug: string,
  referenceId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations();
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await linkReferenceFood(ctx, referenceId, formValues(formData));
    const parts = [
      r.nutrition ? t("library.linkedValues") : null,
      r.allergens.length > 0 ? t("library.linkedAllergens", { count: r.allergens.length }) : null,
      r.arabicName ? t("library.linkedName") : null,
      r.conflicts.length > 0
        ? t("library.conflicts", {
            allergens: r.conflicts
              .map((c) => t(`nutrition.allergenNames.${c as "MILK"}`))
              .join(", "),
          })
        : null,
    ].filter(Boolean);
    return { message: parts.length > 0 ? parts.join(" ") : t("library.linkedNothing") };
  });
}
