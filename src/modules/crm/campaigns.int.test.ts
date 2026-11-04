import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  cancelCampaign,
  getCampaign,
  launchCampaign,
  listCampaigns,
  saveCampaign,
  sendDueCampaigns,
  unsubscribe,
  unsubscribePage,
} from "./campaigns";
import { setTestProvider, type OutgoingMessage } from "./messaging";
import { saveSegment } from "./segments";

/** Campaigns, provider-neutral (ADR-119). Sending uses a recording stand-in provider. */

let ctx: TenantContext;
let register: string;
let shiftId: string;
let item: string;
let segmentId: string;
const people: Record<string, string> = {};
const outbox: OutgoingMessage[] = [];

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

async function sell(customerId: string) {
  await submitOrder(ctx, {
    orderId: randomUUID(),
    registerId: register,
    shiftId,
    channel: "TAKEAWAY",
    lines: [{ itemId: item, quantity: "1" }],
    payments: [{ method: "CARD", amount: "25" }],
    customerId,
  });
}

beforeAll(async () => {
  ({ ctx } = await createTenant("campaigns"));
  const today = businessDate(ctx.timeZone);
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  const branchId = (await createBranch(ctx, { code: "OLY", name: "Olaya", type: "RESTAURANT" })).id;
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
    ["Sara Al Harbi", "+966501110001", true],
    ["Omar", "+966501110002", true],
    ["Lina", "+966501110003", false],
  ] as const)
    people[key] = (
      await createCustomer(ctx, { name: key, phone, marketingConsent: consent ? "on" : "" })
    ).id;
  for (const id of Object.values(people)) await sell(id);
  segmentId = (await saveSegment(ctx, { name: "Everyone", rules: { minOrders: "1" } })).id;
}, 120_000);

afterAll(() => setTestProvider(ctx.organizationId, "SMS", null));

describe("campaigns (ADR-119)", () => {
  it("drafts a message and shows who it would reach and what it costs in SMS parts", async () => {
    await expectAppError(
      saveCampaign(ctx, { name: "x", channel: "SMS", segmentId, body: "Hi {phone}" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      saveCampaign(ctx, { name: "x", channel: "EMAIL", segmentId, body: "Hi" }),
      "VALIDATION_FAILED",
    );
    const c = await saveCampaign(ctx, {
      name: "Weekend offer",
      channel: "SMS",
      segmentId,
      body: "Hi {name}, 20% off wraps this weekend",
    });
    const view = await getCampaign(ctx, c.id);
    // Lina did not agree to offers.
    expect(view.audience).toEqual({
      inSegment: 3,
      consenting: 2,
      reachable: 2,
      recentlyMessaged: 0,
      willReceive: 2,
    });
    expect(view.sample).toMatch(
      /^Hi Sara, 20% off wraps this weekend\nStop offers: https?:\/\/.+\/unsubscribe\//,
    );
    expect(view.sms).toMatchObject({ encoding: "GSM-7", parts: 1 });
    expect(view.provider).toBeNull();
  });

  it("cannot be launched while no provider is connected for the channel", async () => {
    const c = (await listCampaigns(ctx)).campaigns[0];
    await expectRule(launchCampaign(ctx, c.id), "CHANNEL_NOT_CONNECTED");
    expect((await getCampaign(ctx, c.id)).status).toBe("DRAFT");
  });

  it("sends to consenting guests through the provider, with an unsubscribe link, and counts who came back", async () => {
    setTestProvider(ctx.organizationId, "SMS", {
      name: "Recording stand-in",
      send: async (m) => {
        outbox.push(m);
        if (m.to === "+966501110002" && outbox.filter((x) => x.to === m.to).length === 1)
          throw new Error("Number unreachable");
        return { providerMessageId: `msg-${outbox.length}` };
      },
    });
    const c = (await listCampaigns(ctx)).campaigns[0];
    const manager = await addMember(ctx, "branch_manager");
    await expectAppError(launchCampaign(manager.ctx, c.id), "FORBIDDEN");
    expect(await launchCampaign(ctx, c.id)).toEqual({ recipients: 2, skipped: 0 });
    await expectRule(
      saveCampaign(ctx, { name: "x", channel: "SMS", segmentId, body: "x" }, c.id),
      "CAMPAIGN_NOT_DRAFT",
    );
    expect(await sendDueCampaigns()).toEqual({ sent: 1, failed: 1, skipped: 0 });
    expect(outbox.map((m) => [m.to, m.text.split("\n")[0]]).sort()).toEqual([
      ["+966501110001", "Hi Sara, 20% off wraps this weekend"],
      ["+966501110002", "Hi Omar, 20% off wraps this weekend"],
    ]);
    // Sara comes back.
    await sell(people["Sara Al Harbi"]);
    const view = await getCampaign(ctx, c.id);
    expect(view.status).toBe("SENT");
    expect(view.results).toMatchObject({ total: 2, sent: 1, failed: 1, returned: 1, orders: 1 });
    expect(view.results?.revenue.toFixed(2)).toBe("25.00");
    // No contact details are kept on recipients.
    const rows = await getDb().campaignRecipient.findMany({ where: { campaignId: c.id } });
    expect(JSON.stringify(rows)).not.toContain("+9665011");

    // Sara stops offers from the link in her message.
    const link = outbox
      .find((m) => m.to === "+966501110001")!
      .text.split(" ")
      .pop()!;
    const token = new URL(link).pathname.split("/").pop()!;
    expect(await unsubscribePage(`${token.split(".")[0]}.forged0000000000000000`)).toBeNull();
    expect(await unsubscribePage(token)).toEqual({
      organizationName: expect.any(String),
      done: false,
    });
    await unsubscribe(token);
    expect(await unsubscribePage(token)).toMatchObject({ done: true });
    const sara = await getDb().posCustomer.findUniqueOrThrow({
      where: { id: people["Sara Al Harbi"] },
    });
    expect(sara.marketingConsent).toBe(false);
    expect((await getCampaign(ctx, c.id)).results?.optedOut).toBe(1);
  });

  it("leaves out guests messaged recently, and is cancelled before sending", async () => {
    const next = await saveCampaign(ctx, {
      name: "Again",
      channel: "SMS",
      segmentId,
      body: "Hi {name}",
      skipIfMessagedWithinDays: "7",
    });
    // Sara withdrew; Omar's message failed, so he was not messaged.
    expect((await getCampaign(ctx, next.id)).audience).toMatchObject({
      consenting: 1,
      recentlyMessaged: 0,
      willReceive: 1,
    });
    await launchCampaign(ctx, next.id, {
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect((await sendDueCampaigns()).sent).toBe(0);
    await cancelCampaign(ctx, next.id);
    const view = await getCampaign(ctx, next.id);
    expect([view.status, view.results?.skipped]).toEqual(["CANCELLED", 1]);
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(listCampaigns(cashier.ctx), "FORBIDDEN");
    const { ctx: other } = await createTenant("campaigns-other");
    await expectAppError(getCampaign(other, next.id), "NOT_FOUND");
  });
});
