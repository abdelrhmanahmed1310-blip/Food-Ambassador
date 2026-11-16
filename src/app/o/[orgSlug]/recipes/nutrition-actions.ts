"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  declareAllergens,
  generateLabel,
  recordNutritionProfile,
  reviewLabel,
  verifyAllergenDeclarations,
  verifyNutritionProfile,
} from "@/modules/nutrition/service";
import {
  unlinkProductReference,
  useReferenceForProduct,
} from "@/modules/nutrition/product-reference";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function recordProfileAction(
  orgSlug: string,
  productId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await recordNutritionProfile(ctx, productId, formValues(formData));
    return { message: t("savedSuccessfully") };
  });
}

export async function verifyProfileAction(
  orgSlug: string,
  productId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    verifyNutritionProfile(ctx, productId),
  );
}

export async function declareAllergensAction(
  orgSlug: string,
  productId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations("common");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const values = formValues(formData);
    const statements: Record<string, string> = {};
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      const m = /^statements\.([A-Z_]{2,20})$/.exec(k);
      if (m) statements[m[1]] = v;
      else rest[k] = v;
    }
    await declareAllergens(ctx, productId, { ...rest, statements });
    return { message: t("savedSuccessfully") };
  });
}

export async function verifyAllergensAction(
  orgSlug: string,
  productId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await verifyAllergenDeclarations(ctx, productId);
  });
}

export async function generateLabelAction(
  orgSlug: string,
  recipeId: string,
  previous: ActionState,
  formData: FormData,
) {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await generateLabel(ctx, recipeId)).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/recipes/labels/${id}`);
  return state;
}

export async function reviewLabelAction(
  orgSlug: string,
  labelId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    reviewLabel(ctx, labelId, formValues(formData)),
  );
}

/** Use a library food (or USDA record) as the product's nutrition reference (ADR-136). */
export async function useReferenceAction(
  orgSlug: string,
  productId: string,
  previous: ActionState,
  formData: FormData,
) {
  const t = await getTranslations();
  const pick = String(formData.get("pick") ?? "");
  const [kind, id] = [pick.slice(0, pick.indexOf(":")), pick.slice(pick.indexOf(":") + 1)];
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await useReferenceForProduct(
      ctx,
      productId,
      kind === "fdc" ? { fdcId: id } : { foodId: id },
    );
    const parts = [
      t("library.linkedReference"),
      r.nutrition ? t("library.linkedValues") : null,
      r.nutritionSkipped ? t(`library.skipped.${r.nutritionSkipped}`) : null,
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
    return { message: parts.join(" ") };
  });
}

export async function unlinkReferenceAction(
  orgSlug: string,
  productId: string,
  previous: ActionState,
  formData: FormData,
) {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    unlinkProductReference(ctx, productId),
  );
}
