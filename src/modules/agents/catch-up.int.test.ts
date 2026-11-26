import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { createTenant } from "../../../test/support/factories";
import { runScheduledAgent, updateAgent } from "./service";

/** The daily close catches up skipped days (ADR-159). */

let ctx: TenantContext;

beforeAll(async () => {
  ({ ctx } = await createTenant("agent-catch-up"));
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("catch-up daily close (ADR-159)", () => {
  it("checks every day since the last one checked, once each", async () => {
    await updateAgent(ctx, "DAILY_CLOSE", { enabled: true, autonomy: "SUGGEST", runHour: 5 });
    const db = getDb();
    const agent = await db.agent.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, kind: "DAILY_CLOSE" },
    });
    const yesterday = addDays(businessDate(ctx.timeZone), -1);
    // Last checked four days before today; a failed run on a later day does not count.
    await db.agentRun.create({
      data: {
        organizationId: ctx.organizationId,
        agentId: agent.id,
        trigger: "SCHEDULE",
        status: "SUCCEEDED",
        businessDate: new Date(addDays(yesterday, -3)),
        finishedAt: new Date(),
      },
    });
    await db.agentRun.create({
      data: {
        organizationId: ctx.organizationId,
        agentId: agent.id,
        trigger: "SCHEDULE",
        status: "FAILED",
        businessDate: new Date(addDays(yesterday, -1)),
        finishedAt: new Date(),
        error: "test",
      },
    });

    const runs = await runScheduledAgent(ctx.organizationId, agent.id, ctx.userId);
    expect(runs.map((r) => r.status)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
    const days = await db.agentRun.findMany({
      where: { id: { in: runs.map((r) => r.runId) } },
      orderBy: { startedAt: "asc" },
      select: { businessDate: true, trigger: true },
    });
    expect(days.map((d) => d.businessDate!.toISOString().slice(0, 10))).toEqual([
      addDays(yesterday, -2),
      addDays(yesterday, -1),
      yesterday,
    ]);
    expect(new Set(days.map((d) => d.trigger))).toEqual(new Set(["SCHEDULE"]));
    // Nothing left to check.
    expect(await runScheduledAgent(ctx.organizationId, agent.id, ctx.userId)).toEqual([]);
  });
});
