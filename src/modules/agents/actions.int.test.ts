import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { saveReorderRule } from "@/modules/procurement/reorder";
import { createSupplier, saveSupplierProduct } from "@/modules/procurement/suppliers";
import { addRecipePrice, listRecipePrices, updateRecipeSettings } from "@/modules/recipes/menu";
import { activateVersion, addIngredient, createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  decideProposal,
  executeDueActions,
  runAgentNow,
  setAgentActionsPaused,
  stopScheduledAction,
  updateAgent,
} from "./service";

/** Agents acting within limits, after a hold a person can stop, with a kill switch (ADR-145). */

let ctx: TenantContext;
let units: Record<string, string>;
let warehouseId: string;
let tomato: string;
const HOUR = 3_600_000;

const proposals = (kind: string) =>
  getDb().agentProposal.findMany({
    where: { organizationId: ctx.organizationId, kind },
    orderBy: { createdAt: "asc" },
  });

/** A one-portion dish of tomato at 20 a kg, sold at 25, against the 30 % target. */
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
  return r!.id;
}

const menuMargin = (autonomy: "SUGGEST" | "ACT", holdHours = "24") =>
  updateAgent(ctx, "MENU_MARGIN", {
    enabled: true,
    autonomy,
    runHour: "6",
    settings: { effectiveInDays: "1", maxIncreasePercent: "5", maxActionsPerRun: "3", holdHours },
  });

const statusOf = async (dishId: string) =>
  (await proposals("PRICE_CHANGE")).filter((p) => p.entityId === dishId).map((p) => p.status);

beforeAll(async () => {
  ({ ctx } = await createTenant("agent-actions"));
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  warehouseId = (
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

describe("acting within limits (ADR-145)", () => {
  it("submits a draft order itself only within the order and daily amounts", async () => {
    const rice = (
      await createProduct(ctx, {
        sku: "RICE",
        nameEn: "Rice",
        type: "RAW_MATERIAL",
        baseUomId: units.kg,
      })
    ).id;
    const mills = (await createSupplier(ctx, { code: "MILLS", name: "Mills" })).id;
    await saveSupplierProduct(ctx, mills, {
      productId: rice,
      purchaseUomId: units.kg,
      lastUnitPrice: "40",
      preferred: "on",
    });
    await saveReorderRule(ctx, {
      warehouseId,
      productId: rice,
      uomId: units.kg,
      minQuantity: "10",
      maxQuantity: "50",
    });
    const replenish = (maxOrderAmount: string) =>
      updateAgent(ctx, "REPLENISHMENT", {
        enabled: true,
        autonomy: "ACT",
        runHour: "6",
        settings: { basis: "MIN_MAX", maxOrderAmount, maxDailyAmount: "5000", holdHours: "0" },
      });
    // 50 kg at 40 = 2000: above a 1000 limit, so it stays a draft for a person.
    await replenish("1000");
    await runAgentNow(ctx, "REPLENISHMENT");
    let [p] = await proposals("PURCHASE_ORDER");
    expect([p.status, p.actedByAgent]).toEqual(["OPEN", false]);
    await decideProposal(ctx, p.id, { decision: "REJECT" }); // cancels the draft
    // Within 5000 and no hold: submitted at once into the normal approval chain.
    await replenish("5000");
    const run = await runAgentNow(ctx, "REPLENISHMENT");
    p = (await proposals("PURCHASE_ORDER")).at(-1)!;
    expect([p.status, p.actedByAgent]).toEqual(["APPROVED", true]);
    const order = await getDb().purchaseOrder.findUniqueOrThrow({ where: { id: p.entityId! } });
    expect(order.status).not.toBe("DRAFT");
    const audit = await getDb().auditEvent.findFirstOrThrow({
      where: {
        organizationId: ctx.organizationId,
        action: "agent.action_carried_out",
        entityId: p.id,
      },
    });
    expect([audit.actorUserId, audit.requestId]).toEqual([ctx.userId, `agent-run:${run.runId}`]);
    expect(
      await getDb().notification.count({
        where: { organizationId: ctx.organizationId, kind: "AGENT_ACTIONS" },
      }),
    ).toBeGreaterThan(0);
  });

  it("schedules small price rises after a hold and carries them out when it is over", async () => {
    const small = await dish("SMALL", "0.39"); // 7.80 a portion: 26.00 meets 30 % (+4 %)
    const large = await dish("LARGE", "0.5"); // 10.00 a portion: 33.34 (+33 %), beyond 5 %
    await menuMargin("ACT");
    await runAgentNow(ctx, "MENU_MARGIN");
    expect(await statusOf(small)).toEqual(["SCHEDULED"]);
    expect(await statusOf(large)).toEqual(["OPEN"]);
    // Not due yet.
    expect(await executeDueActions(new Date())).toEqual({ done: 0, returned: 0 });
    expect(await executeDueActions(new Date(Date.now() + 25 * HOUR))).toEqual({
      done: 1,
      returned: 0,
    });
    const [p] = (await proposals("PRICE_CHANGE")).filter((x) => x.entityId === small);
    expect([p.status, p.actedByAgent]).toEqual(["APPROVED", true]);
    expect((await listRecipePrices(ctx, small))[0].price.toString()).toBe("26");
    const audit = await getDb().auditEvent.findFirstOrThrow({
      where: {
        organizationId: ctx.organizationId,
        action: "agent.action_carried_out",
        entityId: p.id,
      },
    });
    expect(audit.requestId).toBe(`agent-act:${p.id}`);
  });

  it("lets the people who could decide stop a scheduled action", async () => {
    const stopMe = await dish("STOP", "0.385"); // 25.67 (+2.7 %)
    await runAgentNow(ctx, "MENU_MARGIN");
    const [p] = (await proposals("PRICE_CHANGE")).filter((x) => x.entityId === stopMe);
    expect(p.status).toBe("SCHEDULED");
    const cook = (await addMember(ctx, "kitchen", {}, "actions-cook")).ctx;
    await expectAppError(stopScheduledAction(cook, p.id), "FORBIDDEN");
    await stopScheduledAction(ctx, p.id);
    expect(await statusOf(stopMe)).toEqual(["OPEN"]);
    await expectAppError(stopScheduledAction(ctx, p.id), "BUSINESS_RULE_VIOLATION");
    expect(await executeDueActions(new Date(Date.now() + 25 * HOUR))).toEqual({
      done: 0,
      returned: 0,
    });
  });

  it("pauses everything with the kill switch, and hands back actions of an agent that stopped acting", async () => {
    const paused = await dish("PAUSE", "0.38"); // 25.34 (+1.4 %)
    await runAgentNow(ctx, "MENU_MARGIN");
    expect(await statusOf(paused)).toEqual(["SCHEDULED"]);
    await setAgentActionsPaused(ctx, true);
    expect(await statusOf(paused)).toEqual(["OPEN"]);
    // While paused, nothing new is scheduled.
    const whilePaused = await dish("WHILE", "0.384");
    await runAgentNow(ctx, "MENU_MARGIN");
    expect(await statusOf(whilePaused)).toEqual(["OPEN"]);
    const analyst = (await addMember(ctx, "analyst", {}, "actions-analyst")).ctx;
    await expectAppError(setAgentActionsPaused(analyst, false), "FORBIDDEN");
    await setAgentActionsPaused(ctx, false);

    const later = await dish("LATER", "0.383");
    await runAgentNow(ctx, "MENU_MARGIN");
    expect(await statusOf(later)).toEqual(["SCHEDULED"]);
    await menuMargin("SUGGEST");
    expect(await executeDueActions(new Date(Date.now() + 25 * HOUR))).toEqual({
      done: 0,
      returned: 1,
    });
    expect(await statusOf(later)).toEqual(["OPEN"]);
    // Only the agents that can act offer it.
    await expectAppError(
      updateAgent(ctx, "INVOICE_MATCHING", {
        enabled: false,
        autonomy: "ACT",
        runHour: "6",
        settings: {},
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });
});
