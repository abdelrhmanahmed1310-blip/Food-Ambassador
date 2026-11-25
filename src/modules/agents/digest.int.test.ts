import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { createTenant } from "../../../test/support/factories";
import { weeklyAgentDigest } from "./digest";
import { nextMonday } from "./digest-rules";
import { decideProposal, runAgentNow, updateAgent } from "./service";

/** The weekly agent digest (ADR-153). */

let ctx: TenantContext;

beforeAll(async () => {
  ({ ctx } = await createTenant("agent-digest"));
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("weekly agent digest (ADR-153)", () => {
  it("tells each person last week's agent work and what waits for them, once", async () => {
    const monday = nextMonday(businessDate(ctx.timeZone));
    // Nothing set up yet: no digest.
    expect(await weeklyAgentDigest(ctx.organizationId, monday)).toEqual({
      members: 0,
      notified: 0,
    });

    await updateAgent(ctx, "DAILY_CLOSE", { enabled: true, autonomy: "SUGGEST", runHour: 5 });
    await runAgentNow(ctx, "DAILY_CLOSE");
    // A menu & margin run with one critical finding and three proposals.
    await updateAgent(ctx, "MENU_MARGIN", { enabled: true, autonomy: "SUGGEST", runHour: 5 });
    const db = getDb();
    const agent = await db.agent.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, kind: "MENU_MARGIN" },
    });
    const run = await db.agentRun.create({
      data: {
        organizationId: ctx.organizationId,
        agentId: agent.id,
        trigger: "MANUAL",
        status: "SUCCEEDED",
        finishedAt: new Date(),
        findings: [
          { severity: "CRITICAL", code: "ABOVE_TARGET", params: {} },
          { severity: "INFO", code: "NO_TARGET", params: { count: 1 } },
        ],
      },
    });
    const proposals = await Promise.all(
      ["A", "B", "C"].map((t) =>
        db.agentProposal.create({
          data: {
            organizationId: ctx.organizationId,
            agentId: agent.id,
            runId: run.id,
            kind: "PRICE_CHANGE",
            title: `Dish ${t}`,
          },
        }),
      ),
    );
    await db.agentProposal.update({
      where: { id: proposals[0].id },
      data: { status: "APPROVED", decidedAt: new Date(), decidedByUserId: ctx.userId },
    });
    await decideProposal(ctx, proposals[1].id, { decision: "REJECT", reason: "BAD_TIMING" });

    // Not a Monday: nothing.
    const tuesday = new Date(`${monday}T00:00:00Z`);
    tuesday.setUTCDate(tuesday.getUTCDate() + 1);
    expect(await weeklyAgentDigest(ctx.organizationId, tuesday.toISOString().slice(0, 10))).toEqual(
      { members: 0, notified: 0 },
    );

    const r = await weeklyAgentDigest(ctx.organizationId, monday);
    expect(r.notified).toBe(1);
    const n = await db.notification.findFirstOrThrow({
      where: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        kind: "AGENT_WEEKLY_DIGEST",
      },
    });
    expect(n.params).toMatchObject({
      runs: 2,
      failedRuns: 0,
      critical: 1,
      proposals: 3,
      approved: 1,
      rejected: 1,
      acted: 0,
      waiting: 1,
    });
    expect(n.link).toBe("/agents/inbox");
    // Once per week.
    expect((await weeklyAgentDigest(ctx.organizationId, monday)).notified).toBe(0);
  });
});
