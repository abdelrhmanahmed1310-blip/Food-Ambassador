import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createCustomer } from "@/modules/pos/customers";
import { createRegister, openShift, submitOrder } from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  escalateFeedback,
  feedbackPage,
  feedbackToken,
  listFeedback,
  reviewFeedback,
  submitFeedback,
} from "./feedback";
import {
  archiveSegment,
  exportSegmentCsv,
  listSegments,
  previewSegment,
  rfmOverview,
  saveSegment,
  segmentMembers,
} from "./segments";

/** Customer segments, RFM and guest feedback (ADR-118). */

let ctx: TenantContext;
let branchId: string;
let register: string;
let shiftId: string;
let item: string;
const people: Record<string, string> = {};
const orders: string[] = [];

async function expectRule(promise: Promise<unknown>, rule: string) {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; details?: { rule?: string } };
    expect(`${e.code}:${e.details?.rule}`).toBe(`BUSINESS_RULE_VIOLATION:${rule}`);
    return;
  }
  throw new Error(`Expected ${rule} but the call succeeded`);
}

async function sell(customerId: string | undefined, qty: number) {
  const orderId = randomUUID();
  await submitOrder(ctx, {
    orderId,
    registerId: register,
    shiftId,
    channel: "TAKEAWAY",
    lines: [{ itemId: item, quantity: String(qty) }],
    payments: [{ method: "CARD", amount: String(25 * qty) }],
    ...(customerId ? { customerId } : {}),
  });
  orders.push(orderId);
  return orderId;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("crm"));
  const today = businessDate(ctx.timeZone);
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  branchId = (await createBranch(ctx, { code: "OLY", name: "Olaya", type: "RESTAURANT" })).id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "OLY-K", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const productId = (
    await createProduct(ctx, {
      sku: "WRAP",
      nameEn: "Wrap",
      type: "FINISHED_GOOD",
      baseUomId: each,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId,
    productId,
    quantity: "500",
    uomId: each,
    unitCost: "8",
  });
  const category = (await createMenuCategory(ctx, { name: "Menu" })).id;
  item = (
    await createMenuItem(ctx, {
      code: "WRAP",
      name: "Wrap",
      categoryId: category,
      kind: "ITEM",
      productId,
    })
  ).id;
  await addMenuItemPrice(ctx, item, { channel: "TAKEAWAY", price: "25", effectiveFrom: today });
  register = (await createRegister(ctx, { branchId, warehouseId, code: "T1", name: "Till" })).id;
  shiftId = (await openShift(ctx, register, { openingFloat: "0" })).id;
  for (const [key, phone, consent] of [
    ["regular", "+966501110001", true],
    ["fan", "+966501110002", false],
    ["once", "+966501110003", true],
  ] as const)
    people[key] = (
      await createCustomer(ctx, { name: key, phone, marketingConsent: consent ? "on" : "" })
    ).id;
  for (let i = 0; i < 5; i++) await sell(people.regular, 4); // 5 orders, 500
  for (let i = 0; i < 3; i++) await sell(people.fan, 1); // 3 orders, 75
  await sell(people.once, 2); // 1 order, 50
  await sell(undefined, 1); // an anonymous guest
}, 120_000);

describe("customer segments (ADR-118)", () => {
  it("previews, saves and counts a segment, worked out from paid orders", async () => {
    expect(await previewSegment(ctx, { windowDays: "90", minOrders: "3" })).toEqual({
      count: 2,
      withConsent: 1,
    });
    await expectAppError(
      previewSegment(ctx, { windowDays: "90", minOrders: "5", maxOrders: "2" }),
      "VALIDATION_FAILED",
    );
    const vip = await saveSegment(ctx, {
      name: "Big spenders",
      rules: { windowDays: "90", minSpend: "200", consentOnly: "on", branchIds: [branchId] },
    });
    await saveSegment(ctx, { name: "Lapsed", rules: { notVisitedForDays: "60" } });
    await expectAppError(saveSegment(ctx, { name: "big spenders", rules: {} }), "CONFLICT");
    const list = await listSegments(ctx);
    expect(list.segments.map((s) => [s.name, s.count, s.withConsent])).toEqual([
      ["Big spenders", 1, 1],
      ["Lapsed", 0, 0],
    ]);
    const members = await segmentMembers(ctx, vip.id);
    expect(members.members.map((m) => [m.person.name, m.orders, m.spend.toFixed(2)])).toEqual([
      ["regular", 5, "500.00"],
    ]);
  });

  it("exports members with contact details only for those who agreed, and audits it by count", async () => {
    const all = await saveSegment(ctx, { name: "Everyone", rules: { minOrders: "1" } });
    const csv = await exportSegmentCsv(ctx, all.id);
    expect(csv).toContain("regular,'+966501110001,,yes,5,500.00");
    expect(csv).toContain("fan,,,no,3,75.00");
    const audit = await getDb().auditEvent.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, action: "customer_segment.exported" },
    });
    expect(JSON.stringify(audit.changes)).toBe(JSON.stringify({ members: 3, withContact: 2 }));
    expect(JSON.stringify(audit)).not.toContain("+9665011");
    await archiveSegment(ctx, all.id);
    await expectAppError(segmentMembers(ctx, all.id), "NOT_FOUND");
  });

  it("reads customers by recency, frequency and spend", async () => {
    const r = await rfmOverview(ctx);
    expect(r.groups.reduce((a, g) => a + g.customers, 0)).toBe(3);
  });

  it("is for those who see customers; saving and exporting for those who manage them", async () => {
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(listSegments(cashier.ctx), "FORBIDDEN");
    const analyst = await addMember(ctx, "analyst");
    await expectAppError(listSegments(analyst.ctx), "FORBIDDEN");
    const manager = await addMember(ctx, "branch_manager");
    expect((await listSegments(manager.ctx)).canManage).toBe(true);
    const { ctx: other } = await createTenant("crm-other");
    expect((await listSegments(other)).segments).toEqual([]);
  });
});

describe("guest feedback (ADR-118)", () => {
  it("takes one rating per order through the signed receipt link", async () => {
    const [first, second] = orders;
    expect(await feedbackPage(`${first}.forged-signature-000000`)).toBeNull();
    expect(await feedbackPage(feedbackToken(first))).toMatchObject({
      branchName: "Olaya",
      given: false,
      closed: false,
    });
    await expectAppError(
      submitFeedback(feedbackToken(first), { rating: "6" }),
      "VALIDATION_FAILED",
    );
    await submitFeedback(feedbackToken(first), { rating: "5", comment: "Great wraps" });
    await expectAppError(submitFeedback(feedbackToken(first), { rating: "1" }), "CONFLICT");
    expect((await feedbackPage(feedbackToken(first)))?.given).toBe(true);
    await submitFeedback(feedbackToken(second), { rating: "1", comment: "Cold and late" });
    await submitFeedback(feedbackToken(orders[2]), { rating: "2" });
    // The guest's words never change.
    const fb = await getDb().guestFeedback.findFirstOrThrow({ where: { posOrderId: second } });
    await expect(
      getDb().guestFeedback.update({ where: { id: fb.id }, data: { rating: 5 } }),
    ).rejects.toThrow();

    const r = await listFeedback(ctx);
    expect([
      r.summary.count,
      r.summary.average?.toFixed(2),
      r.summary.happyShare?.toFixed(2),
    ]).toEqual(["3", "2.67", "0.33"].map((x, i) => (i === 0 ? 3 : x)));
    expect((await attentionItems(ctx)).find((i) => i.key === "LOW_RATINGS_TO_REVIEW")?.count).toBe(
      2,
    );
  });

  it("is reviewed or turned into a complaint at its branch", async () => {
    const low = (await listFeedback(ctx, { low: "1" })).rows;
    const cold = low.find((x) => x.comment === "Cold and late")!;
    const silent = low.find((x) => x.comment === null)!;
    const complaint = await escalateFeedback(ctx, cold.id, { category: "QUALITY" });
    expect(complaint.number).toMatch(/^CMP-|^[A-Z]+-/);
    await expectRule(reviewFeedback(ctx, cold.id, { note: "again" }), "FEEDBACK_REVIEWED");
    await reviewFeedback(ctx, silent.id, { note: "Called the guest" });
    expect(
      (await attentionItems(ctx)).find((i) => i.key === "LOW_RATINGS_TO_REVIEW"),
    ).toBeUndefined();
    const after = (await listFeedback(ctx, { low: "1" })).rows.find((x) => x.id === cold.id)!;
    expect(after.complaint?.id).toBe(complaint.id);
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(listFeedback(cashier.ctx), "FORBIDDEN");
  });
});
