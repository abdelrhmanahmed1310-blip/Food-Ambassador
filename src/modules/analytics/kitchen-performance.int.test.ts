import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createStation } from "@/modules/pos/kitchen";
import { createRegister, openShift, submitOrder } from "@/modules/pos/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { exportKitchenCsv, kitchenPerformance } from "./kitchen-performance";

/** Kitchen display performance (ADR-108). */

let ctx: TenantContext;
let today: string;
let ticketDay: string;
let grill: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("kitchen-perf"));
  today = businessDate(ctx.timeZone);
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  const branchId = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  const warehouseId = (
    await createWarehouse(ctx, { branchId, code: "KIT", name: "Kitchen", type: "KITCHEN_STORE" })
  ).id;
  grill = (
    await createStation(ctx, {
      branchId,
      code: "GRILL",
      name: "Grill",
      targetMinutes: "10",
      isDefault: "on",
    })
  ).id;
  const productId = (
    await createProduct(ctx, {
      sku: "PATTY",
      nameEn: "Patty",
      type: "FINISHED_GOOD",
      baseUomId: each,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId,
    productId,
    quantity: "50",
    uomId: each,
    unitCost: "5",
  });
  const category = (await createMenuCategory(ctx, { name: "Mains" })).id;
  const burger = (
    await createMenuItem(ctx, {
      code: "BURGER",
      name: "Burger",
      categoryId: category,
      kind: "ITEM",
      productId,
    })
  ).id;
  await addMenuItemPrice(ctx, burger, { channel: "TAKEAWAY", price: "80", effectiveFrom: today });
  const register = (await createRegister(ctx, { branchId, warehouseId, code: "T1", name: "Till" }))
    .id;
  const shiftId = (await openShift(ctx, register, { openingFloat: "0" })).id;
  for (let i = 0; i < 3; i++)
    await submitOrder(ctx, {
      orderId: randomUUID(),
      registerId: register,
      shiftId,
      channel: "TAKEAWAY",
      lines: [{ itemId: burger, quantity: "1" }],
      payments: [{ method: "CARD", amount: "80" }],
    });
  // Exact times: one done in 5 minutes, one in 15, one still open after 20.
  const tickets = await getDb().kitchenTicket.findMany({
    where: { organizationId: ctx.organizationId, stationId: grill },
    orderBy: { createdAt: "asc" },
  });
  // Half an hour ago — moved back if that would straddle local midnight, so all tickets share one day.
  let base = Date.now() - 30 * 60_000;
  const at = (min: number) => new Date(base + min * 60_000);
  while (businessDate(ctx.timeZone, at(0)) !== businessDate(ctx.timeZone, at(16)))
    base -= 20 * 60_000;
  ticketDay = businessDate(ctx.timeZone, at(0));
  await getDb().kitchenTicket.update({
    where: { id: tickets[0].id },
    data: { createdAt: at(0), status: "DONE", bumpedAt: at(5) },
  });
  await getDb().kitchenTicket.update({
    where: { id: tickets[1].id },
    data: { createdAt: at(1), status: "DONE", bumpedAt: at(16) },
  });
  await getDb().kitchenTicket.update({ where: { id: tickets[2].id }, data: { createdAt: at(10) } });
}, 60_000);

describe("kitchen performance (ADR-108)", () => {
  it("measures sent-to-bumped times against the station target", async () => {
    const r = await kitchenPerformance(ctx, { from: ticketDay, to: ticketDay });
    const s = r.stations.find((x) => x.station.id === grill)!;
    expect([s.sent, s.tickets, s.stillOpen]).toEqual([3, 2, 1]);
    // 5 and 15 minutes: median 10, 90th percentile 14, average 10; one of two within 10 minutes.
    expect([s.medianSeconds, s.p90Seconds, s.meanSeconds]).toEqual([600, 840, 600]);
    expect(s.withinTarget?.toFixed(2)).toBe("0.50");
    // The open ticket has waited 20 minutes: late now.
    expect([s.openNow, s.lateNow, s.items, s.voidedItems]).toEqual([1, 1, 3, 0]);
    expect(r.total.sent).toBe(3);
    expect(r.hours.reduce((a, h) => a + h.sent, 0)).toBe(3);
    expect(r.days).toEqual([expect.objectContaining({ day: ticketDay, sent: 3 })]);
    const csv = await exportKitchenCsv(ctx, { from: ticketDay, to: ticketDay });
    expect(csv).toContain("CAI,GRILL,10,3,10.0,14.0,10.0,50.0,1,3,0");
  });

  it("needs sales rights and stays inside the organization", async () => {
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(kitchenPerformance(cashier.ctx, { from: today, to: today }), "FORBIDDEN");
    const { ctx: other } = await createTenant("kitchen-perf-other");
    const r = await kitchenPerformance(other, { from: today, to: today });
    expect([r.stations, r.total.sent]).toEqual([[], 0]);
  });
});
