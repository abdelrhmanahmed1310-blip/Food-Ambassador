import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createRegister, getOrder, openShift } from "@/modules/pos/service";
import { addTabLines, createFloor, createTable, getTab, openTab } from "@/modules/pos/tables";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  cancelPaymentLink,
  createPaymentLink,
  linksForTab,
  refreshPaymentLink,
  savePaymentProvider,
} from "./links";
import type { Fetch } from "./moyasar";

/**
 * SIMULATED MOYASAR: the gateway is not reachable from the development
 * environment; these tests check this application's flow, not Moyasar.
 */
const invoices = new Map<string, { amount: number; status: string; payments: unknown[] }>();
const seen: Array<{ url: string; auth: string; body: Record<string, unknown> | null }> = [];
let next = 0;
const fakeMoyasar: Fetch = async (url, init) => {
  const headers = init.headers as Record<string, string>;
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  seen.push({ url, auth: headers.Authorization, body });
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (!headers.Authorization?.startsWith("Basic ")) return json(401, {});
  if (url.endsWith("/invoices") && init.method === "POST") {
    const id = `inv-${++next}`;
    invoices.set(id, { amount: Number(body!.amount), status: "initiated", payments: [] });
    return json(201, {
      id,
      status: "initiated",
      amount: body!.amount,
      url: `https://checkout.moyasar.com/invoices/${id}`,
    });
  }
  const m = /\/invoices\/(.+)$/.exec(url);
  if (m && invoices.has(m[1])) return json(200, { id: m[1], ...invoices.get(m[1]) });
  return json(404, {});
};
const pay = (id: string, amount?: number) => {
  const inv = invoices.get(id)!;
  inv.status = "paid";
  if (amount) inv.amount = amount;
  inv.payments = [
    { id: `pay-${id}`, status: "paid", source: { company: "mada", number: "4464-04XX-XXXX-1234" } },
  ];
};

let ctx: TenantContext;
let register: string;
let table: string;
let burger: string;
let cola: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("paylinks", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branchId = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  const wh = (
    await createWarehouse(ctx, { branchId, code: "K", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  const product = async (sku: string) => {
    const id = (
      await createProduct(ctx, { sku, nameEn: sku, type: "FINISHED_GOOD", baseUomId: units.each })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId: wh,
      productId: id,
      quantity: "50",
      uomId: units.each,
      unitCost: "5",
    });
    return id;
  };
  const cat = (await createMenuCategory(ctx, { name: "Mains" })).id;
  const today = businessDate("Asia/Riyadh");
  burger = (
    await createMenuItem(ctx, {
      code: "B",
      name: "Burger",
      categoryId: cat,
      kind: "ITEM",
      productId: await product("PATTY"),
    })
  ).id;
  cola = (
    await createMenuItem(ctx, {
      code: "C",
      name: "Cola",
      categoryId: cat,
      kind: "ITEM",
      productId: await product("CAN"),
    })
  ).id;
  await addMenuItemPrice(ctx, burger, { channel: "DINE_IN", price: "57.50", effectiveFrom: today });
  await addMenuItemPrice(ctx, cola, { channel: "DINE_IN", price: "11.50", effectiveFrom: today });
  const floor = (await createFloor(ctx, { branchId, warehouseId: wh, name: "Hall" })).id;
  table = (await createTable(ctx, floor, { code: "T1", seats: "4", gridX: "0", gridY: "0" })).id;
  register = (await createRegister(ctx, { branchId, warehouseId: wh, code: "TILL", name: "Till" }))
    .id;
  await openShift(ctx, register, { openingFloat: "0" });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("pay by QR at the table (simulated Moyasar, ADR-066)", () => {
  it("needs a provider key of the right kind, set by an admin", async () => {
    const tab = await openTab(ctx, { tableId: table, guests: "2" });
    await addTabLines(ctx, tab.id, {
      lines: [
        { itemId: burger, quantity: "2" },
        { itemId: cola, quantity: "1" },
      ],
    });
    await expectAppError(
      createPaymentLink(ctx, tab.id, { registerId: register, expectedTotal: "126.5" }, fakeMoyasar),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      savePaymentProvider(ctx, { mode: "LIVE", secretKey: "sk_test_abcdefghij" }),
      "VALIDATION_FAILED",
    );
    const waiter = (await addMember(ctx, "waiter")).ctx;
    await expectAppError(
      savePaymentProvider(waiter, { mode: "TEST", secretKey: "sk_test_abcdefghij" }),
      "FORBIDDEN",
    );
    await savePaymentProvider(ctx, { mode: "TEST", secretKey: "sk_test_abcdefghij" });
    const sealed = await getDb().paymentProviderSettings.findUniqueOrThrow({
      where: { organizationId: ctx.organizationId },
    });
    expect(sealed.secretKeySealed).not.toContain("sk_test");
  });

  it("charges the check's total in halalas and records the payment once when paid", async () => {
    const tab = (
      await getDb().posTab.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, status: "OPEN" },
      })
    ).id;
    await expectAppError(
      createPaymentLink(ctx, tab, { registerId: register, expectedTotal: "100" }, fakeMoyasar),
      "BUSINESS_RULE_VIOLATION", // the total changed
    );
    const link = await createPaymentLink(
      ctx,
      tab,
      { registerId: register, expectedTotal: "126.5" },
      fakeMoyasar,
    );
    expect(link.url).toMatch(/^https:\/\/checkout\.moyasar\.com\//);
    const created = seen.at(-1)!;
    expect(created.body).toMatchObject({ amount: 12650, currency: "SAR" });
    expect(Buffer.from(created.auth.replace("Basic ", ""), "base64").toString()).toBe(
      "sk_test_abcdefghij:",
    );

    expect((await refreshPaymentLink(ctx, link.id, fakeMoyasar)).status).toBe("CREATED");
    const invoiceId = (await getDb().paymentLink.findUniqueOrThrow({ where: { id: link.id } }))
      .providerInvoiceId;
    pay(invoiceId);
    const recorded = await refreshPaymentLink(ctx, link.id, fakeMoyasar);
    expect(recorded.status).toBe("RECORDED");
    expect((await getTab(ctx, tab)).status).toBe("CLOSED");
    const order = await getOrder(
      ctx,
      (await getDb().paymentLink.findUniqueOrThrow({ where: { id: link.id } })).orderId,
    );
    expect(order.payments[0]).toMatchObject({
      method: "CARD",
      cardScheme: "MADA",
      cardLast4: "1234",
      reference: `moyasar:pay-${invoiceId}`,
    });
    expect(order.grossAmount.toFixed()).toBe("126.5");
    // Checking again records nothing more.
    expect((await refreshPaymentLink(ctx, link.id, fakeMoyasar)).status).toBe("RECORDED");
    expect(
      await getDb().posOrder.count({ where: { organizationId: ctx.organizationId, tabId: tab } }),
    ).toBe(1);
  });

  it("pays part of a check, refuses a different amount, and cancels an unpaid link", async () => {
    const tab = await openTab(ctx, { tableId: table, guests: "2" });
    await addTabLines(ctx, tab.id, {
      lines: [
        { itemId: burger, quantity: "1" },
        { itemId: cola, quantity: "2" },
      ],
    });
    const colaLine = (await getTab(ctx, tab.id)).lines.find((l) => l.name === "Cola")!;
    const part = await createPaymentLink(
      ctx,
      tab.id,
      {
        registerId: register,
        lines: [{ tabLineId: colaLine.id, quantity: "1" }],
        expectedTotal: "11.5",
      },
      fakeMoyasar,
    );
    const partId = (await getDb().paymentLink.findUniqueOrThrow({ where: { id: part.id } }))
      .providerInvoiceId;
    pay(partId);
    await refreshPaymentLink(ctx, part.id, fakeMoyasar);
    expect(
      (await getTab(ctx, tab.id)).lines.find((l) => l.name === "Cola")!.paidQuantity.toFixed(),
    ).toBe("1");

    const rest = await createPaymentLink(
      ctx,
      tab.id,
      { registerId: register, expectedTotal: "69" },
      fakeMoyasar,
    );
    const restId = (await getDb().paymentLink.findUniqueOrThrow({ where: { id: rest.id } }))
      .providerInvoiceId;
    pay(restId, 100);
    await expectAppError(refreshPaymentLink(ctx, rest.id, fakeMoyasar), "BUSINESS_RULE_VIOLATION");
    const other = await createPaymentLink(
      ctx,
      tab.id,
      { registerId: register, expectedTotal: "69" },
      fakeMoyasar,
    );
    await cancelPaymentLink(ctx, other.id);
    await expectAppError(cancelPaymentLink(ctx, other.id), "BUSINESS_RULE_VIOLATION");
    expect((await linksForTab(ctx, tab.id)).map((l) => l.status)).toEqual([
      "CANCELLED",
      "CREATED",
      "RECORDED",
    ]);
    const stranger = (await createTenant("paylinks-other")).ctx;
    await expectAppError(refreshPaymentLink(stranger, rest.id, fakeMoyasar), "NOT_FOUND");
  });
});
