"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  confirmReferenceLinks,
  importReferenceLinks,
  type BulkLinkResult,
} from "@/modules/nutrition/product-reference";
import { translateRowErrors } from "@/server/actions/import-errors";
import { tenantMutation } from "@/server/actions/tenant";

async function summary(r: BulkLinkResult) {
  const t = await getTranslations("productReference");
  return [
    t("bulkLinked", { count: r.linked }),
    r.valuesCopied ? t("bulkValues", { count: r.valuesCopied }) : null,
    r.specKept ? t("bulkSpecKept", { count: r.specKept }) : null,
    r.allergenConflicts ? t("bulkConflicts", { count: r.allergenConflicts }) : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Confirm the chosen suggestions (ADR-136): fields named pick:<productId> = library food id. */
export async function confirmMatchesAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("productReference");
  const pairs = [...formData.entries()]
    .filter(([k, v]) => k.startsWith("pick:") && typeof v === "string" && v)
    .map(([k, v]) => ({ productId: k.slice(5), foodId: String(v) }));
  if (pairs.length === 0)
    return { ok: false, seq: (previous.seq ?? 0) + 1, formError: t("nothingChosen") };
  return tenantMutation(orgSlug, previous, formData, async (ctx) => ({
    message: await summary(await confirmReferenceLinks(ctx, pairs)),
  }));
}

const MAX_UPLOAD_BYTES = 900_000;

/** Link existing products from a CSV: sku, reference_source, reference_id (ADR-136). */
export async function importLinksAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_UPLOAD_BYTES)
    return { ok: false, seq: (previous.seq ?? 0) + 1, formError: t("import.fileRequired") };
  const text = await file.text();
  return tenantMutation(orgSlug, previous, formData, async (ctx): Promise<Partial<ActionState>> => {
    const r = await importReferenceLinks(ctx, text);
    if (!r.ok)
      return {
        ok: false,
        formError: t("import.rejected", { count: r.errors.length }),
        data: { errors: JSON.stringify(await translateRowErrors(r.errors)) },
      };
    return { message: await summary(r) };
  });
}
