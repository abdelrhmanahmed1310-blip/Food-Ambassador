"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addPortion,
  createCustomNutrient,
  createFood,
  importUsdaFoods,
  refreshFood,
  setCategoryArabic,
  updateFood,
} from "@/modules/nutrition/engine/foods";
import { ProviderError } from "@/modules/nutrition/engine/providers";
import { resolveIssue, scanQuality } from "@/modules/nutrition/engine/quality";
import {
  requestSync,
  retrySyncJob,
  updateNutritionSettings,
} from "@/modules/nutrition/engine/sync";
import { businessRuleViolation } from "@/server/errors";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

/** Server actions of the nutrition pages (ADR-132); all logic is in src/modules/nutrition/engine. */

type State = ActionState;

/** USDA failures as rule violations the form can show in the person's language. */
async function usda<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ProviderError)
      throw businessRuleViolation(`USDA_${error.code}`, error.message);
    throw error;
  }
}

const ids = (raw: string) =>
  raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export async function importUsdaAction(orgSlug: string, previous: State, formData: FormData) {
  const t = await getTranslations("nutritionEngine");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await usda(importUsdaFoods(ctx, ids(String(formData.get("fdcIds") ?? ""))));
    if (r.failed.length > 0 && r.created + r.updated + r.unchanged === 0)
      throw businessRuleViolation(
        r.failed.some((f) => /configured/i.test(f.message))
          ? "USDA_NOT_CONFIGURED"
          : "USDA_IMPORT_FAILED",
        r.failed[0].message,
      );
    return {
      message: t("importDone", {
        created: r.created,
        updated: r.updated,
        unchanged: r.unchanged,
        failed: r.failed.length,
      }),
    };
  });
}

export async function createFoodAction(orgSlug: string, previous: State, formData: FormData) {
  let id: string | null = null;
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const v = formValues(formData);
    const values: Record<string, string> = {};
    for (const [k, val] of Object.entries(v))
      if (k.startsWith("v.") && val.trim() !== "") values[k.slice(2)] = val.trim();
    const food = await createFood(ctx, {
      name: v.name,
      nameAr: v.nameAr || undefined,
      brand: v.brand || undefined,
      barcode: v.barcode || undefined,
      categoryId: v.categoryId || undefined,
      basis: v.basis || undefined,
      ingredientsText: v.ingredientsText || undefined,
      reference: v.reference || undefined,
      values,
    });
    id = food.id;
  });
  if (state.ok && id) redirect(`/o/${orgSlug}/nutrition/foods/${id}`);
  return state;
}

export async function updateFoodAction(
  orgSlug: string,
  foodId: string,
  previous: State,
  formData: FormData,
) {
  const t = await getTranslations("nutritionEngine");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const v = formValues(formData);
    const input: Record<string, unknown> = {};
    if ("nameAr" in v) input.nameAr = v.nameAr;
    if ("categoryId" in v) input.categoryId = v.categoryId || null;
    if (v.verified) input.verified = v.verified === "true";
    if (v.archived) {
      input.archived = v.archived === "true";
      if (v.archiveReason) input.archiveReason = v.archiveReason;
    }
    if (v.aliasName) input.addAliases = [{ name: v.aliasName, locale: v.aliasLocale || "en" }];
    if (v.removeAliasId) input.removeAliasIds = [v.removeAliasId];
    if (v.notApplicable) input.notApplicable = { [v.notApplicable]: v.naValue !== "false" };
    await updateFood(ctx, foodId, input);
    return { message: t("saved") };
  });
}

export async function refreshFoodAction(
  orgSlug: string,
  foodId: string,
  previous: State,
  formData: FormData,
) {
  const t = await getTranslations("nutritionEngine");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await usda(refreshFood(ctx, foodId));
    return { message: t(`refreshResult.${r.result}`) };
  });
}

export async function addPortionAction(
  orgSlug: string,
  foodId: string,
  previous: State,
  formData: FormData,
) {
  const t = await getTranslations("nutritionEngine");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const v = formValues(formData);
    await addPortion(ctx, foodId, {
      description: v.description,
      descriptionAr: v.descriptionAr || undefined,
      gramWeight: v.gramWeight || undefined,
      millilitres: v.millilitres || undefined,
    });
    return { message: t("saved") };
  });
}

export async function requestSyncAction(orgSlug: string, previous: State, formData: FormData) {
  const t = await getTranslations("nutritionEngine");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const v = formValues(formData);
    const kind = v.kind;
    await requestSync(
      ctx,
      kind === "IMPORT"
        ? { kind, fdcIds: ids(v.fdcIds ?? "") }
        : kind === "REFRESH"
          ? { kind, limit: v.limit || undefined }
          : { kind },
    );
    return { message: t("syncQueued") };
  });
}

export async function retrySyncAction(
  orgSlug: string,
  jobId: string,
  previous: State,
  formData: FormData,
) {
  const t = await getTranslations("nutritionEngine");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await retrySyncJob(ctx, jobId);
    return { message: t("syncQueued") };
  });
}

export async function updateSettingsAction(orgSlug: string, previous: State, formData: FormData) {
  const t = await getTranslations("nutritionEngine");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const v = formValues(formData);
    await updateNutritionSettings(ctx, {
      autoRefresh: v.autoRefresh === "on",
      refreshDays: v.refreshDays,
    });
    return { message: t("saved") };
  });
}

export async function createNutrientAction(orgSlug: string, previous: State, formData: FormData) {
  const t = await getTranslations("nutritionEngine");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const v = formValues(formData);
    await createCustomNutrient(ctx, {
      code: v.code,
      name: v.name,
      nameAr: v.nameAr || undefined,
      unit: v.unit,
      group: v.group || undefined,
    });
    return { message: t("saved") };
  });
}

export async function setCategoryArabicAction(
  orgSlug: string,
  categoryId: string,
  previous: State,
  formData: FormData,
) {
  const t = await getTranslations("nutritionEngine");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setCategoryArabic(ctx, categoryId, { nameAr: String(formData.get("nameAr") ?? "") });
    return { message: t("saved") };
  });
}

export async function resolveIssueAction(
  orgSlug: string,
  issueId: string,
  previous: State,
  formData: FormData,
) {
  const t = await getTranslations("nutritionEngine");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await resolveIssue(ctx, issueId, {
      status: String(formData.get("status") ?? ""),
      note: String(formData.get("note") ?? ""),
    });
    return { message: t("saved") };
  });
}

export async function scanQualityAction(orgSlug: string, previous: State, formData: FormData) {
  const t = await getTranslations("nutritionEngine");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await scanQuality(ctx);
    return { message: t("scanDone", { count: r.stale + r.duplicates + r.missingSource }) };
  });
}
