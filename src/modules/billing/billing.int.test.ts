import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordUsage, saveUsageLimits } from "@/modules/usage/service";
import { businessDate } from "@/modules/inventory/rules";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  archivePlan,
  assignPlan,
  generateStatements,
  issueStatement,
  listStatements,
  savePlan,
  type PlatformOperator,
} from "./platform";
import { myBilling, warnUsageLimits } from "./service";

/** Plans and prices from the platform operator, statements and limit warnings (ADR-147). */

let ctx: TenantContext;
let other: TenantContext;
const op: PlatformOperator = {
  id: "00000000-0000-7000-8000-000000000001",
  email: "ops@example.com",
};
const month = () => businessDate("Africa/Cairo").slice(0, 7);
const code = `T${Date.now().toString(36).toUpperCase()}`;

beforeAll(async () => {
  ({ ctx } = await createTenant("billing"));
  ({ ctx: other } = await createTenant("billing-other"));
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("plans and statements (ADR-147)", () => {
  it("bills each organization on its plan from its own metered usage, and fixes it once issued", async () => {
    const plan = await savePlan(op, {
      code,
      name: "Pro",
      currency: "SAR",
      monthlyFee: "499",
      pricing: { "agent.actions": { included: "2", unitPrice: "0.5" } },
    });
    await assignPlan(op, ctx.organizationId, plan.id);
    await recordUsage(ctx.organizationId, "agent.actions", 12, "REPLENISHMENT");
    await recordUsage(other.organizationId, "agent.actions", 999, "REPLENISHMENT"); // no plan: no statement
    const r = await generateStatements(op, month());
    expect(r.made).toBeGreaterThanOrEqual(1);
    const mine = (await listStatements(op, month())).find(
      (s) => s.organizationId === ctx.organizationId,
    )!;
    expect(mine.total.toString()).toBe("504");
    expect(mine.status).toBe("DRAFT");
    expect(
      (await listStatements(op, month())).some((s) => s.organizationId === other.organizationId),
    ).toBe(false);

    // The organization sees its plan and statements; others in it without settings rights do not.
    const view = await myBilling(ctx);
    expect([view.plan?.name, view.statements[0].total.toString()]).toEqual(["Pro", "504"]);
    const cook = (await addMember(ctx, "kitchen", {}, "billing-cook")).ctx;
    await expectAppError(myBilling(cook), "FORBIDDEN");

    // A draft follows new usage; an issued statement does not change.
    await recordUsage(ctx.organizationId, "agent.actions", 2, "REPLENISHMENT");
    await generateStatements(op, month());
    expect((await myBilling(ctx)).statements[0].total.toString()).toBe("505");
    await issueStatement(op, mine.id);
    await recordUsage(ctx.organizationId, "agent.actions", 100, "REPLENISHMENT");
    await generateStatements(op, month());
    const fixed = (await myBilling(ctx)).statements[0];
    expect([fixed.status, fixed.total.toString(), fixed.issuedBy]).toEqual([
      "ISSUED",
      "505",
      op.email,
    ]);
    await expectAppError(issueStatement(op, mine.id), "BUSINESS_RULE_VIOLATION");
    await expect(
      getDb().billingStatement.update({ where: { id: mine.id }, data: { total: "1" } }),
    ).rejects.toThrow();
    // A plan in use cannot be archived.
    await expectAppError(archivePlan(op, plan.id), "BUSINESS_RULE_VIOLATION");
    await expectAppError(generateStatements(op, "2026-13"), "BUSINESS_RULE_VIOLATION");
  });

  it("warns settings managers once at 80 % and once at the limit", async () => {
    await saveUsageLimits(ctx, { mcpCallsPerDay: "10" });
    await recordUsage(ctx.organizationId, "mcp.calls", 8, "list_sites");
    await warnUsageLimits();
    await warnUsageLimits(); // once per period
    const count = (kind: string) =>
      getDb().notification.count({ where: { organizationId: ctx.organizationId, kind } });
    expect(await count("USAGE_LIMIT_NEAR")).toBe(1);
    expect(await count("USAGE_LIMIT_REACHED")).toBe(0);
    await recordUsage(ctx.organizationId, "mcp.calls", 2, "list_sites");
    await warnUsageLimits();
    expect(await count("USAGE_LIMIT_REACHED")).toBe(1);
  });
});
