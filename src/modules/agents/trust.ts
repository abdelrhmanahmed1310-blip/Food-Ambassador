import "server-only";
import { assertPermission } from "@/modules/access/authorize";
import { actorOf, recordAudit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { withTenantTx } from "@/server/db/transactions";
import { businessRuleViolation, notFound } from "@/server/errors";
import { agentPerformance } from "./performance";
import { trustStep, type TrustStep } from "./performance-rules";
import { AGENT_KINDS, type AgentKindCode, type AutonomyCode } from "./rules";
import { canRunAgent } from "./service";

/**
 * Trust from performance (DECISIONS.md ADR-151): from the agent performance
 * page an owner raises a switched-on agent to act within limits, or takes it
 * back to proposing. Raising reads the agent's record first; on a record
 * that is not READY the owner must confirm they have read it. Who raises it
 * lends it their access, as when saving its settings (ADR-140). Limits stay
 * in the agent's settings; actions already scheduled go back to people when
 * it stops acting (ADR-145).
 */

export interface AgentTrust {
  kind: AgentKindCode;
  /** Its autonomy now; null when it was never set up. */
  autonomy: AutonomyCode | null;
  step: TrustStep;
}

/** The step offered per agent, for settings managers; others get none. */
export async function agentTrustSteps(
  ctx: TenantContext,
  readiness: ReadonlyMap<AgentKindCode, "READY" | "MIXED" | "TOO_FEW">,
): Promise<AgentTrust[]> {
  const agents = await withTenantTx(ctx.organizationId, (tx) =>
    tx.agent.findMany({
      where: { organizationId: ctx.organizationId },
      select: { kind: true, enabled: true, autonomy: true },
    }),
  );
  return [...readiness.entries()].map(([kind, r]) => {
    const a = agents.find((x) => x.kind === kind);
    return {
      kind,
      autonomy: (a?.autonomy as AutonomyCode | undefined) ?? null,
      step: trustStep(
        kind,
        a ? { enabled: a.enabled, autonomy: a.autonomy as AutonomyCode } : null,
        r,
      ),
    };
  });
}

export async function changeAgentTrust(
  ctx: TenantContext,
  kind: AgentKindCode,
  input: { direction: "RAISE" | "LOWER"; recordRead?: boolean },
) {
  assertPermission(ctx.grants, "org.settings.manage");
  if (!AGENT_KINDS.includes(kind)) throw notFound("Agent");
  const summary = (await agentPerformance(ctx)).find((a) => a.kind === kind);
  if (!summary) throw notFound("Agent");
  return withTenantTx(ctx.organizationId, async (tx) => {
    const agent = await tx.agent.findFirst({
      where: { organizationId: ctx.organizationId, kind },
      select: { id: true, enabled: true, autonomy: true },
    });
    const step = trustStep(
      kind,
      agent ? { enabled: agent.enabled, autonomy: agent.autonomy as AutonomyCode } : null,
      summary.readiness,
    );
    if (step.step === "NONE")
      throw step.reason === "OFF"
        ? businessRuleViolation("AGENT_NOT_ON", "Switch the agent on first")
        : businessRuleViolation("AGENT_AUTONOMY_NOT_OFFERED", "This agent only proposes");
    if (step.step !== input.direction)
      throw businessRuleViolation(
        "AGENT_TRUST_CHANGED",
        "The agent's autonomy changed meanwhile; reload the page",
      );
    const decided = summary.totals.approved + summary.totals.rejected;
    if (step.step === "RAISE") {
      if (step.acknowledgementNeeded && !input.recordRead)
        throw businessRuleViolation(
          "AGENT_RECORD_NOT_READY",
          "Confirm you have read the agent's record before letting it act",
        );
      if (!canRunAgent(kind, ctx))
        throw businessRuleViolation(
          "AGENT_RUN_AS_NO_ACCESS",
          "Switch the agent on as someone who can do its work",
        );
    }
    await tx.agent.update({
      where: { id: agent!.id },
      data: {
        autonomy: step.to,
        // Whoever lets it act lends it their access from then on (ADR-140).
        ...(step.step === "RAISE" ? { runAsUserId: ctx.userId } : {}),
      },
    });
    await recordAudit(tx, actorOf(ctx), {
      action: step.step === "RAISE" ? "agent.trust_raised" : "agent.trust_lowered",
      entityType: "agent",
      entityId: agent!.id,
      changes: {
        kind,
        from: agent!.autonomy,
        to: step.to,
        readiness: summary.readiness,
        approvalPercent: summary.approvalPercent,
        decided,
        ...(step.step === "RAISE"
          ? { recordRead: Boolean(input.recordRead), runAs: ctx.userId }
          : {}),
      },
    });
    return { autonomy: step.to };
  });
}
