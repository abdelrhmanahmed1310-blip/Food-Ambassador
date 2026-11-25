import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addRecipePrice, updateRecipeSettings } from "@/modules/recipes/menu";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { agentPerformance } from "./performance";
import { decideProposal, runAgentNow, stopScheduledAction, updateAgent } from "./service";

/** Agent performance from the records (ADR-150). */

let ctx: TenantContext;
let units: Record<string, string>;
let tomato: string;

async function dish(code: string, kg: string) {
  const r = await createRecipe(ctx, {
    code,
    name: code,
    type: "DISH",
    yieldQuantity: "1",
    yieldUomId: units.each,
    portions: "1",
  });
  await addIngredient(ctx, r!.versionId, {
    item: `product:${tomato}`,
    quantity: kg,
    uomId: units.kg,
  });
  await activateVersion(ctx, r!.versionId);
  await addRecipePrice(ctx, r!.id, { price: "25", effectiveFrom: businessDate(ctx.timeZone) });
}

beforeAll(async () => {
  ({ ctx } = await createTenant("agent-performance"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  tomato = (
    await createProduct(ctx, {
      sku: "TOMATO",
      nameEn: "Tomato",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId,
    productId: tomato,
    quantity: "100",
    uomId: units.kg,
    unitCost: "20",
  });
  await updateRecipeSettings(ctx, { targetPercent: "30" });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("agent performance (ADR-150)", () => {
  it("counts runs, findings and what happened to each proposal, this month", async () => {
    // Four dishes above target: two approved, one rejected, one scheduled then stopped.
    for (const [code, kg] of [
      ["A", "0.5"],
      ["B", "0.45"],
      ["C", "0.6"],
      ["D", "0.39"], // +4 %: within the 5 % the agent may act on
    ] as const)
      await dish(code, kg);
    await updateAgent(ctx, "MENU_MARGIN", {
      enabled: true,
      autonomy: "ACT",
      runHour: "6",
      settings: { maxIncreasePercent: "5", maxActionsPerRun: "3", holdHours: "24" },
    });
    await runAgentNow(ctx, "MENU_MARGIN");
    const ps = await getDb().agentProposal.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "asc" },
    });
    expect(ps.map((p) => p.status).sort()).toEqual(["OPEN", "OPEN", "OPEN", "SCHEDULED"]);
    const open = ps.filter((p) => p.status === "OPEN");
    await decideProposal(ctx, open[0].id, { decision: "APPROVE" });
    await decideProposal(ctx, open[1].id, { decision: "APPROVE" });
    // A rejection says why (ADR-152); "other" needs a note.
    await expectAppError(
      decideProposal(ctx, open[2].id, { decision: "REJECT" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      decideProposal(ctx, open[2].id, { decision: "REJECT", reason: "OTHER" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      decideProposal(ctx, open[2].id, { decision: "REJECT", reason: "BORED" }),
      "VALIDATION_FAILED",
    );
    await decideProposal(ctx, open[2].id, { decision: "REJECT", reason: "WRONG_AMOUNT" });
    const rejected = await getDb().agentProposal.findUniqueOrThrow({ where: { id: open[2].id } });
    expect(rejected.rejectionReason).toBe("WRONG_AMOUNT");
    // The database keeps reasons to rejected proposals.
    await expect(
      getDb().agentProposal.update({
        where: { id: open[0].id },
        data: { rejectionReason: "NOT_NEEDED" },
      }),
    ).rejects.toThrow();
    await stopScheduledAction(ctx, ps.find((p) => p.status === "SCHEDULED")!.id);

    const perf = await agentPerformance(ctx);
    const mm = perf.find((a) => a.kind === "MENU_MARGIN")!;
    const now = mm.months.at(-1)!;
    expect(mm.months).toHaveLength(6);
    expect(now).toMatchObject({
      runs: 1,
      failedRuns: 0,
      proposals: 4,
      approved: 2,
      rejected: 1,
      open: 1,
      actedByAgent: 0,
      stopped: 1,
      followUpsTaken: 0,
    });
    expect(now.findings.WARNING).toBe(4); // one ABOVE_TARGET per dish
    expect(now.medianDecisionHours).not.toBeNull();
    expect([mm.approvalPercent, mm.readiness]).toEqual([67, "TOO_FEW"]);
    // ADR-152: why people rejected, from the reasons they gave.
    expect(mm.rejectionReasons).toEqual([{ reason: "WRONG_AMOUNT", count: 1 }]);
    // Every agent the person may see is listed, even without runs.
    expect(perf.map((a) => a.kind)).toEqual([
      "REPLENISHMENT",
      "DAILY_CLOSE",
      "INVOICE_MATCHING",
      "FOOD_SAFETY",
      "MENU_MARGIN",
    ]);
  });

  it("shows each person only the agents they may see", async () => {
    const analyst = (await addMember(ctx, "analyst", {}, "perf-analyst")).ctx;
    // An analyst sees the POS, food safety and recipe costs, not purchasing or invoices.
    expect((await agentPerformance(analyst)).map((a) => a.kind)).toEqual([
      "DAILY_CLOSE",
      "FOOD_SAFETY",
      "MENU_MARGIN",
    ]);
    const cook = (await addMember(ctx, "kitchen", {}, "perf-cook")).ctx;
    await expectAppError(agentPerformance(cook), "FORBIDDEN");
    const other = (await createTenant("agent-performance-other")).ctx;
    const theirs = (await agentPerformance(other)).find((a) => a.kind === "MENU_MARGIN")!;
    expect(theirs.totals.proposals).toBe(0);
  });
});
