"use server";

import { getTranslations } from "next-intl/server";
import type { ActionState } from "@/components/forms/action-state";
import type { AgentKindCode } from "@/modules/agents/rules";
import {
  decideProposal,
  explainAgentRun,
  followUpFromInvestigation,
  investigateAgentFinding,
  liftProposalPause,
  runAgentNow,
  setAgentActionsPaused,
  stopScheduledAction,
  updateAgent,
} from "@/modules/agents/service";
import { changeAgentTrust } from "@/modules/agents/trust";
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
      maxOrderAmount: v("maxOrderAmount") || "0",
      maxDailyAmount: v("maxDailyAmount") || "0",
      holdHours: v("holdHours") || "4",
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
      maxActionsPerRun: v("maxActionsPerRun") || "3",
      holdHours: v("holdHours") || "4",
    }),
    MENU_MARGIN: () => ({
      effectiveInDays: v("effectiveInDays") || "1",
      maxIncreasePercent: v("maxIncreasePercent") || "5",
      maxActionsPerRun: v("maxActionsPerRun") || "3",
      holdHours: v("holdHours") || "24",
    }),
  };
  const settings = {
    ...SETTINGS[kind](),
    investigateCritical: formData.get("investigateCritical") === "on",
  };
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
      reason: decision === "REJECT" ? String(formData.get("reason") ?? "") || undefined : undefined,
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

/** Stop an action an agent scheduled; it goes back to the inbox (ADR-145). */
export async function stopActionAction(
  orgSlug: string,
  proposalId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("agents");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await stopScheduledAction(ctx, proposalId);
    return { message: t("stopped") };
  });
}

/** The kill switch for every agent action (ADR-145). */
export async function setActionsPausedAction(
  orgSlug: string,
  paused: boolean,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("agents");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await setAgentActionsPaused(ctx, paused);
    return { message: t(paused ? "paused" : "resumed") };
  });
}

/** Ask Claude to investigate one finding (ADR-148). */
export async function investigateAction(
  orgSlug: string,
  runId: string,
  findingIndex: number,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("agents");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    const r = await investigateAgentFinding(ctx, runId, findingIndex);
    return r.status === "OK"
      ? { message: t("investigated") }
      : { ok: false, formError: t("investigationFailed", { error: r.error ?? "" }) };
  });
}

/** Put an investigation's next step in the inbox as a follow-up (ADR-149). */
export async function followUpAction(
  orgSlug: string,
  investigationId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("agents");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await followUpFromInvestigation(ctx, investigationId);
    return { message: t("followUpAdded") };
  });
}

/** Let an agent act within limits from its record, or take it back to proposing (ADR-151). */
export async function changeTrustAction(
  orgSlug: string,
  kind: AgentKindCode,
  direction: "RAISE" | "LOWER",
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("agents");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await changeAgentTrust(ctx, kind, {
      direction,
      recordRead: formData.get("recordRead") === "on",
    });
    return { message: t(direction === "RAISE" ? "trustRaised" : "trustLowered") };
  });
}

/** Let the agent propose a record again after rejections paused it (ADR-155). */
export async function liftPauseAction(
  orgSlug: string,
  proposalId: string,
  previous: S,
  formData: FormData,
) {
  const t = await getTranslations("agents");
  return tenantMutation(orgSlug, previous, formData, async (ctx) => {
    await liftProposalPause(ctx, proposalId);
    return { message: t("pauseLifted") };
  });
}
