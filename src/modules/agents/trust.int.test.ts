import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { updateAgent } from "./service";
import { agentTrustSteps, changeAgentTrust } from "./trust";

/** Trust from performance: raise to act from the record, or take back (ADR-151). */

let ctx: TenantContext;

async function rule(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    return (e as { details?: { rule?: string } }).details?.rule;
  }
  return "succeeded";
}

const autonomy = async () =>
  (
    await getDb().agent.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, kind: "MENU_MARGIN" },
      select: { autonomy: true, runAsUserId: true },
    })
  ).autonomy;

beforeAll(async () => {
  ({ ctx } = await createTenant("agent-trust"));
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("trust from performance (ADR-151)", () => {
  it("raises a switched-on agent to act only once its record is read, and takes it back", async () => {
    // Not set up, or an agent that only proposes: nothing to raise.
    expect(await rule(changeAgentTrust(ctx, "MENU_MARGIN", { direction: "RAISE" }))).toBe(
      "AGENT_NOT_ON",
    );
    expect(await rule(changeAgentTrust(ctx, "DAILY_CLOSE", { direction: "RAISE" }))).toBe(
      "AGENT_AUTONOMY_NOT_OFFERED",
    );

    await updateAgent(ctx, "MENU_MARGIN", {
      enabled: true,
      autonomy: "SUGGEST",
      runHour: 5,
      settings: {},
    });
    const before = await agentTrustSteps(ctx, new Map([["MENU_MARGIN", "TOO_FEW"]]));
    expect(before[0]).toMatchObject({
      autonomy: "SUGGEST",
      step: { step: "RAISE", to: "ACT", acknowledgementNeeded: true },
    });

    // No decisions yet: the owner must say they have read the record.
    expect(await rule(changeAgentTrust(ctx, "MENU_MARGIN", { direction: "RAISE" }))).toBe(
      "AGENT_RECORD_NOT_READY",
    );
    expect(await autonomy()).toBe("SUGGEST");
    await changeAgentTrust(ctx, "MENU_MARGIN", { direction: "RAISE", recordRead: true });
    expect(await autonomy()).toBe("ACT");
    const raised = await getDb().auditEvent.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, action: "agent.trust_raised" },
    });
    expect(raised.changes).toMatchObject({
      kind: "MENU_MARGIN",
      from: "SUGGEST",
      to: "ACT",
      readiness: "TOO_FEW",
      decided: 0,
      recordRead: true,
    });

    // A second raise from a stale page is refused.
    expect(
      await rule(changeAgentTrust(ctx, "MENU_MARGIN", { direction: "RAISE", recordRead: true })),
    ).toBe("AGENT_TRUST_CHANGED");

    // Back to proposing.
    expect((await agentTrustSteps(ctx, new Map([["MENU_MARGIN", "TOO_FEW"]])))[0].step).toEqual({
      step: "LOWER",
      to: "SUGGEST",
    });
    await changeAgentTrust(ctx, "MENU_MARGIN", { direction: "LOWER" });
    expect(await autonomy()).toBe("SUGGEST");
    expect(
      await getDb().auditEvent.count({
        where: { organizationId: ctx.organizationId, action: "agent.trust_lowered" },
      }),
    ).toBe(1);
  });

  it("is for settings managers only", async () => {
    const analyst = (await addMember(ctx, "analyst", {}, "trust-analyst")).ctx;
    await expectAppError(
      changeAgentTrust(analyst, "MENU_MARGIN", { direction: "RAISE", recordRead: true }),
      "FORBIDDEN",
    );
    expect(await autonomy()).toBe("SUGGEST");
  });
});
