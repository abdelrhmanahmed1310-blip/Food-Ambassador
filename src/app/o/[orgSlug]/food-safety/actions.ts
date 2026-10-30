"use server";

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import {
  addCorrectiveAction,
  closeNonConformance,
  completeAction,
  raiseNonConformance,
  startInvestigation,
  verifyAction,
} from "@/modules/foodsafety/nonconformances";
import {
  addChecklistItem,
  addRecord,
  completeChecklist,
  createCheckpoint,
  createTemplate,
  removeChecklistItem,
  setCheckpointArchived,
} from "@/modules/foodsafety/service";
import { formValues } from "@/server/actions/handle";
import { tenantMutation } from "@/server/actions/tenant";

export async function addRecordAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const t = await getTranslations("foodSafety");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await addRecord(ctx, formValues(formData));
    return {
      message: r.inSpec
        ? t("recordedOk")
        : t("recordedOutOfSpec", { number: r.nonConformance?.number ?? "" }),
    };
  });
}

export async function createCheckpointAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await createCheckpoint(ctx, formValues(formData));
  });
}

export async function setCheckpointArchivedAction(
  orgSlug: string,
  checkpointId: string,
  archived: boolean,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    setCheckpointArchived(ctx, checkpointId, archived),
  );
}

export async function createTemplateAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await createTemplate(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/food-safety/checklists/${id}`);
  return state;
}

export async function addChecklistItemAction(
  orgSlug: string,
  templateId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addChecklistItem(ctx, templateId, formValues(formData)),
  );
}

export async function removeChecklistItemAction(
  orgSlug: string,
  templateId: string,
  itemId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    removeChecklistItem(ctx, templateId, itemId),
  );
}

/** "answers.<i>.<field>" keys → { answers: [...] }. */
function runInput(values: Record<string, string>) {
  const answers: Array<Record<string, string>> = [];
  const header: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const m = /^answers\.(\d{1,3})\.([A-Za-z]+)$/.exec(key);
    if (m) (answers[Number(m[1])] ??= {})[m[2]] = value;
    else header[key] = value;
  }
  return { ...header, answers: answers.filter(Boolean) };
}

export async function completeChecklistAction(
  orgSlug: string,
  templateId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await completeChecklist(ctx, templateId, runInput(formValues(formData)))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/food-safety/runs/${id}`);
  return state;
}

export async function raiseNonConformanceAction(
  orgSlug: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let id = "";
  const state = await tenantMutation(orgSlug, previous, formData, async (ctx) => {
    id = (await raiseNonConformance(ctx, formValues(formData))).id;
  });
  if (state.ok) redirect(`/o/${orgSlug}/food-safety/non-conformances/${id}`);
  return state;
}

export async function investigateAction(
  orgSlug: string,
  ncId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    startInvestigation(ctx, ncId, formValues(formData)),
  );
}

export async function addActionAction(
  orgSlug: string,
  ncId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    addCorrectiveAction(ctx, ncId, formValues(formData)),
  );
}

export async function completeActionAction(
  orgSlug: string,
  ncId: string,
  actionId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    completeAction(ctx, ncId, actionId, formValues(formData)),
  );
}

export async function verifyActionAction(
  orgSlug: string,
  ncId: string,
  actionId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    verifyAction(ctx, ncId, actionId, formValues(formData)),
  );
}

export async function closeNcAction(
  orgSlug: string,
  ncId: string,
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return tenantMutation(orgSlug, previous, formData, (ctx) =>
    closeNonConformance(ctx, ncId, formValues(formData)),
  );
}
