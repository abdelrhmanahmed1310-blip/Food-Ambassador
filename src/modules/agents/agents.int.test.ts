import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { saveFeatureSettings, getFeatureSettings } from "@/modules/features/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createRegister, openShift, submitOrder, voidOrder } from "@/modules/pos/service";
import { saveReorderRule } from "@/modules/procurement/reorder";
import { createSupplier, saveSupplierProduct } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import { resolveTenantContext, type TenantContext } from "@/modules/tenancy/context";
import { withSystemTx } from "@/server/db/transactions";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  decideProposal,
  dueAgents,
  getRun,
  listAgents,
  listProposals,
  runAgent,
  runAgentNow,
  updateAgent,
} from "./service";

/** AgaaS Phase 0: the replenishment and daily close agents (ADR-140). */

let ctx: TenantContext;
let branchId: string;
let kitchen: string;
let rice: string;
let oil: string;

const replenishment = (autonomy: "SUGGEST" | "DRAFT", enabled = true) =>
  updateAgent(ctx, "REPLENISHMENT", {
    enabled,
    autonomy,
    runHour: "6",
    settings: { basis: "MIN_MAX" },
  });

beforeAll(async () => {
  ({ ctx } = await createTenant("agents"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" })).id;
  kitchen = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  rice = (
    await createProduct(ctx, {
      sku: "RICE",
      nameEn: "Rice",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  oil = (
    await createProduct(ctx, {
      sku: "OIL",
      nameEn: "Oil",
      type: "RAW_MATERIAL",
      baseUomId: units.l,
    })
  ).id;
  const mills = (await createSupplier(ctx, { code: "MILLS", name: "Mills" })).id;
  await saveSupplierProduct(ctx, mills, {
    productId: rice,
    purchaseUomId: units.kg,
    lastUnitPrice: "40",
    preferred: "on",
  });
  // Rice is below its minimum (none in stock); oil too, but it has no supplier.
  for (const [productId, uomId] of [
    [rice, units.kg],
    [oil, units.l],
  ])
    await saveReorderRule(ctx, {
      warehouseId: kitchen,
      productId,
      uomId,
      minQuantity: "10",
      maxQuantity: "50",
    });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("agent settings (ADR-140)", () => {
  it("lists both agents off, switches on as the person doing it, and needs settings rights", async () => {
    const agents = await listAgents(ctx);
    expect(agents.map((a) => [a.kind, a.enabled])).toEqual([
      ["REPLENISHMENT", false],
      ["DAILY_CLOSE", false],
    ]);
    await replenishment("SUGGEST");
    const on = (await listAgents(ctx)).find((a) => a.kind === "REPLENISHMENT")!;
    expect([on.enabled, on.runAsUserId, on.autonomy]).toEqual([true, ctx.userId, "SUGGEST"]);
    await expectAppError(
      updateAgent(ctx, "REPLENISHMENT", { enabled: true, autonomy: "ACT", runHour: "6" }),
      "VALIDATION_FAILED",
    );
    const analyst = (await addMember(ctx, "analyst", {}, "agents-analyst")).ctx;
    await expectAppError(listAgents(analyst), "FORBIDDEN");
    // Analysts see daily close reports (they see the POS) but decide nothing.
    expect((await listProposals(analyst)).items).toEqual([]);
  });
});

describe("replenishment agent (ADR-140)", () => {
  it("suggests orders per supplier, reports what it cannot price, and replaces its own last suggestions", async () => {
    await replenishment("SUGGEST");
    const first = await runAgentNow(ctx, "REPLENISHMENT");
    expect(first.error).toBeUndefined();
    const run = await getRun(ctx, first.runId);
    expect(run.summary).toMatchObject({ warehouses: 1, lines: 1, proposals: 1, drafts: 0 });
    expect(run.findings).toEqual([
      expect.objectContaining({ code: "NO_SUPPLIER", params: { warehouse: "KIT", sku: "OIL" } }),
    ]);
    expect(run.toolCalls).toBeGreaterThan(0);
    // Nothing was created: suggestions only.
    expect(
      await getDb().purchaseOrder.count({ where: { organizationId: ctx.organizationId } }),
    ).toBe(0);
    const second = await runAgentNow(ctx, "REPLENISHMENT");
    const open = (await listProposals(ctx)).items;
    expect(open.map((p) => [p.kind, p.runId])).toEqual([["REORDER", second.runId]]);
    expect((await listProposals(ctx, { status: "SUPERSEDED" })).items).toHaveLength(1);
    // Approving creates the draft order for the approver, priced at the supplier's last price.
    const r = await decideProposal(ctx, open[0].id, { decision: "APPROVE" });
    expect(r.createdOrders).toHaveLength(1);
    const order = await getDb().purchaseOrder.findUniqueOrThrow({
      where: { id: r.createdOrders[0] },
    });
    expect([order.status, order.totalAmount.toString()]).toEqual(["DRAFT", "2000"]);
    await expectAppError(
      decideProposal(ctx, open[0].id, { decision: "REJECT" }),
      "BUSINESS_RULE_VIOLATION",
    );
    // Clean up for the next test: cancel that draft.
    const { cancelOrder } = await import("@/modules/procurement/orders");
    await cancelOrder(ctx, order.id, { reason: "test" });
  });

  it("prepares draft purchase orders; approving sends one into approval, rejecting cancels the other", async () => {
    await replenishment("DRAFT");
    const run = await runAgentNow(ctx, "REPLENISHMENT");
    const proposals = (await listProposals(ctx)).items.filter((p) => p.runId === run.runId);
    expect(proposals.map((p) => [p.kind, p.entityType])).toEqual([
      ["PURCHASE_ORDER", "purchase_order"],
    ]);
    const draft = await getDb().purchaseOrder.findUniqueOrThrow({
      where: { id: proposals[0].entityId! },
    });
    expect(draft.status).toBe("DRAFT");
    // Its changes carry the run's id in the audit log.
    const audited = await getDb().auditEvent.count({
      where: { organizationId: ctx.organizationId, requestId: `agent-run:${run.runId}` },
    });
    expect(audited).toBeGreaterThan(0);
    // A second run drafts nothing more: the draft counts as on order.
    const again = await runAgentNow(ctx, "REPLENISHMENT");
    expect((await getRun(ctx, again.runId)).summary).toMatchObject({ proposals: 0 });
    await decideProposal(ctx, proposals[0].id, { decision: "APPROVE" });
    const sent = await getDb().purchaseOrder.findUniqueOrThrow({ where: { id: draft.id } });
    expect(sent.status).not.toBe("DRAFT");
    expect((await listProposals(ctx, { status: "APPROVED" })).items.map((p) => p.id)).toContain(
      proposals[0].id,
    );
  });

  it("fails a run, and says why, when its person lost access or agents are switched off", async () => {
    const buyer = await addMember(ctx, "procurement", {}, "agents-buyer");
    // Switched on by the buyer: it runs with the buyer's access.
    await updateAgent(buyer.ctx, "REPLENISHMENT", {
      enabled: false,
      autonomy: "SUGGEST",
      runHour: "6",
    }).catch(() => undefined);
    await getDb().agent.updateMany({
      where: { organizationId: ctx.organizationId, kind: "REPLENISHMENT" },
      data: { runAsUserId: buyer.user.id, enabled: true },
    });
    await getDb().organizationMembership.updateMany({
      where: { organizationId: ctx.organizationId, userId: buyer.user.id },
      data: { status: "REMOVED" },
    });
    const lost = await runAgentNow(ctx, "REPLENISHMENT");
    expect(lost.status).toBe("FAILED");
    expect((await getRun(ctx, lost.runId)).error).toMatch(/no access/);
    // Saving it again, switched on, makes the person saving it its person.
    await replenishment("SUGGEST");
    expect(
      (
        await getDb().agent.findFirstOrThrow({
          where: { organizationId: ctx.organizationId, kind: "REPLENISHMENT" },
        })
      ).runAsUserId,
    ).toBe(ctx.userId);
    const form: Record<string, string> = {};
    for (const m of await getFeatureSettings(ctx)) {
      if (m.key !== "agents") form[`module:${m.key}`] = "on";
      for (const f of m.features) form[`feature:${f.key}`] = "on";
    }
    await saveFeatureSettings(ctx, form);
    const fresh = (await withSystemTx((tx) =>
      resolveTenantContext(tx, ctx.userId, ctx.organizationSlug),
    ))!;
    await expectAppError(runAgentNow(fresh, "REPLENISHMENT"), "FORBIDDEN");
    form["module:agents"] = "on";
    await saveFeatureSettings(ctx, form);
  });
});

describe("daily close agent (ADR-140)", () => {
  it("reports a shift left open and voids for the day checked, with the day per branch", async () => {
    const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
    const can = (
      await createProduct(ctx, {
        sku: "COLA",
        nameEn: "Cola",
        type: "FINISHED_GOOD",
        baseUomId: units.each,
      })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId: kitchen,
      productId: can,
      quantity: "50",
      uomId: units.each,
      unitCost: "1",
    });
    const cat = (await createMenuCategory(ctx, { name: "Drinks" })).id;
    const item = (await createMenuItem(ctx, {
      code: "COLA",
      name: "Cola",
      categoryId: cat,
      kind: "ITEM",
      productId: can,
    }))!.id;
    const today = businessDate(ctx.timeZone);
    await addMenuItemPrice(ctx, item, {
      channel: "TAKEAWAY",
      price: "10",
      effectiveFrom: addDays(today, -30),
    });
    const register = (
      await createRegister(ctx, { branchId, warehouseId: kitchen, code: "TILL1", name: "Till 1" })
    ).id;
    await openShift(ctx, register, { openingFloat: "0" });
    const sell = () =>
      submitOrder(ctx, {
        orderId: randomUUID(),
        registerId: register,
        channel: "TAKEAWAY",
        lines: [{ itemId: item, quantity: "1", optionIds: [] }],
        payments: [{ method: "CASH", amount: "10" }],
      });
    await sell();
    const voided = await sell();
    await voidOrder(ctx, voided.id, { reason: "Wrong item" });
    // The shift stays open. The check runs for today (scheduled runs check
    // yesterday; the day is a parameter of the same code).
    await updateAgent(ctx, "DAILY_CLOSE", {
      enabled: true,
      autonomy: "SUGGEST",
      runHour: "6",
      settings: {},
    });
    const agent = await getDb().agent.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, kind: "DAILY_CLOSE" },
    });
    const r = await runAgent(ctx.organizationId, agent.id, "MANUAL", ctx.userId, { date: today });
    expect(r.error).toBeUndefined();
    const run = await getRun(ctx, r.runId);
    expect(run.businessDate?.toISOString().slice(0, 10)).toBe(today);
    expect(run.findings.map((f) => `${f.severity}:${f.code}`)).toEqual([
      "CRITICAL:SHIFT_LEFT_OPEN",
      "WARNING:VOIDS",
    ]);
    expect(run.summary).toMatchObject({
      branches: 1,
      figures: [expect.objectContaining({ code: "RUH", orders: 1, sales: "10.00", voids: 1 })],
    });
    // The run notified the person it runs as.
    expect(
      await getDb().notification.count({
        where: { organizationId: ctx.organizationId, kind: "AGENT_DAILY_CLOSE" },
      }),
    ).toBeGreaterThan(0);
  });

  it("is due once its hour has come in the organization's time zone", async () => {
    const at = (hour: number) => () => ({ date: "2026-11-23", hour });
    const late = await dueAgents(new Date(), at(23));
    expect(late.filter((a) => a.organizationId === ctx.organizationId).length).toBe(2);
    const early = await dueAgents(new Date(), at(2));
    expect(early.filter((a) => a.organizationId === ctx.organizationId)).toEqual([]);
  });
});
