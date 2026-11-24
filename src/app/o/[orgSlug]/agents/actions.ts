"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import type { AgentKindCode } from "@/modules/agents/rules";
import {
  decideProposal,
  explainAgentRun,
  runAgentNow,
  updateAgent,
} from "@/modules/agents/service";
import { tenantMutation } from "@/server/actions/tenant";

type S = ActionState;

/** Agent settings from the form (ADR-140). */
export async function saveAgentAction(
  orgSlug: string,
  kind: AgentKindCode,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("common");
  const v = (k: string) => String(formData.get(k) ?? "");
  const SETTINGS: Record<AgentKindCode, () => Record<string, unknown>> = {
    REPLENISHMENT: () => ({
      warehouseIds: formData.getAll("warehouseIds").map(String),
      basis: v("basis") || "MIN_MAX",
    }),
    DAILY_CLOSE: () => ({
      branchIds: formData.getAll("branchIds").map(String),
      cashTolerance: v("cashTolerance") || "0",
      voidAlertPercent: v("voidAlertPercent") || "5",
      salesDropPercent: v("salesDropPercent") || "30",
    }),
    INVOICE_MATCHING: () => ({
      minCreditAmount: v("minCreditAmount") || "0",
      uninvoicedAfterDays: v("uninvoicedAfterDays") || "14",
    }),
    FOOD_SAFETY: () => ({
      branchIds: formData.getAll("branchIds").map(String),
      complianceBelowPercent: v("complianceBelowPercent") || "80",
      expiringWithinDays: v("expiringWithinDays") || "2",
    }),
    MENU_MARGIN: () => ({ effectiveInDays: v("effectiveInDays") || "1" }),
  };
  const settings = SETTINGS[kind]();
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await updateAgent(ctx, kind, {
      enabled: formData.get("enabled") === "on",
      autonomy: v("autonomy"),
      runHour: v("runHour"),
      settings,
    });
    return { message: t("savedSuccessfully") };
  });
}

export async function runAgentNowAction(
  orgSlug: string,
  kind: AgentKindCode,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("agents");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await runAgentNow(ctx, kind);
    return r.status === "SUCCEEDED"
      ? { message: t("ranOk") }
      : { ok: false, formError: t("ranFailed", { error: r.error ?? "" }) };
  });
}

export async function decideProposalAction(
  orgSlug: string,
  proposalId: string,
  decision: "APPROVE" | "REJECT",
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("agents");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await decideProposal(ctx, proposalId, {
      decision,
      note: String(formData.get("note") ?? "") || undefined,
    });
    return {
      message:
        decision === "REJECT"
          ? t("rejected")
          : r.createdOrders.length
            ? t("approvedDrafts", { count: r.createdOrders.length })
            : t("approvedSubmitted"),
    };
  });
}

/** Ask Claude to explain a run (again), in English and Arabic (ADR-141). */
export async function explainRunAction(
  orgSlug: string,
  runId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("agents");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await explainAgentRun(ctx, runId);
    return r.explained ? { message: t("explained") } : { ok: false, formError: t("explainFailed") };
  });
}
