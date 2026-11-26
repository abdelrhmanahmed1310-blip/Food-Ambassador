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
import {
  decideProposal,
  getRun,
  liftProposalPause,
  pausedProposals,
  runAgentNow,
  updateAgent,
} from "./service";

/** Rejection reasons pause repeat proposals (ADR-155). */

let ctx: TenantContext;

beforeAll(async () => {
  ({ ctx } = await createTenant("agent-pause"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const tomato = (
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
  const r = await createRecipe(ctx, {
    code: "SALAD",
    name: "Salad",
    type: "DISH",
    yieldQuantity: "1",
    yieldUomId: units.each,
    portions: "1",
  });
  await addIngredient(ctx, r!.versionId, {
    item: `product:${tomato}`,
    quantity: "0.5",
    uomId: units.kg,
  });
  await activateVersion(ctx, r!.versionId);
  await addRecipePrice(ctx, r!.id, { price: "25", effectiveFrom: businessDate(ctx.timeZone) });
  await updateAgent(ctx, "MENU_MARGIN", { enabled: true, autonomy: "SUGGEST", runHour: 5 });
});

afterAll(async () => {
  await getDb().$disconnect();
});

const openProposal = () =>
  getDb().agentProposal.findFirst({
    where: { organizationId: ctx.organizationId, status: "OPEN", kind: "PRICE_CHANGE" },
  });

describe("rejection reasons pause repeat proposals (ADR-155)", () => {
  it("stops proposing a dish rejected twice as not needed, until someone lifts it", async () => {
    await runAgentNow(ctx, "MENU_MARGIN");
    const first = (await openProposal())!;
    await decideProposal(ctx, first.id, { decision: "REJECT", reason: "NOT_NEEDED" });

    // One rejection does not pause it; another reason does not count.
    await runAgentNow(ctx, "MENU_MARGIN");
    const second = (await openProposal())!;
    await decideProposal(ctx, second.id, { decision: "REJECT", reason: "WRONG_AMOUNT" });
    await runAgentNow(ctx, "MENU_MARGIN");
    const third = (await openProposal())!;
    expect(third).toBeTruthy();
    await decideProposal(ctx, third.id, { decision: "REJECT", reason: "ALREADY_DONE" });

    // Two pausing rejections within 30 days: held back, and the run says so.
    const paused = await runAgentNow(ctx, "MENU_MARGIN");
    expect(await openProposal()).toBeNull();
    const run = await getRun(ctx, paused.runId);
    expect(run.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PAUSED_BY_REJECTIONS", params: { count: 1 } }),
      ]),
    );

    // Listed for whoever could decide it, with the latest rejection to lift (ADR-161).
    expect(await pausedProposals(ctx)).toEqual([
      expect.objectContaining({ proposalId: third.id, agent: "MENU_MARGIN", kind: "PRICE_CHANGE" }),
    ]);
    const viewer = (await addMember(ctx, "kitchen", {}, "pause-viewer")).ctx;
    expect(await pausedProposals(viewer).catch(() => [])).toEqual([]);

    // Only a pausing rejection can be lifted, and only by someone who could decide it.
    await expectAppError(liftProposalPause(ctx, second.id), "BUSINESS_RULE_VIOLATION");
    const cook = (await addMember(ctx, "kitchen", {}, "pause-cook")).ctx;
    await expectAppError(liftProposalPause(cook, third.id), "FORBIDDEN");
    expect(await liftProposalPause(ctx, third.id)).toEqual({ lifted: 2 });
    expect(await pausedProposals(ctx)).toEqual([]);
    expect(
      await getDb().auditEvent.count({
        where: { organizationId: ctx.organizationId, action: "agent.pause_lifted" },
      }),
    ).toBe(1);
    await expectAppError(liftProposalPause(ctx, first.id), "BUSINESS_RULE_VIOLATION");

    await runAgentNow(ctx, "MENU_MARGIN");
    expect(await openProposal()).toBeTruthy();
    // The database keeps the lift to rejected proposals.
    await expect(
      getDb().agentProposal.update({
        where: { id: (await openProposal())!.id },
        data: { pauseLiftedAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});
