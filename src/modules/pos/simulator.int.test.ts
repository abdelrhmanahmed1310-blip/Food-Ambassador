import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { addMenuItemPrice, createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createOrderingChannel } from "@/modules/pos/ordering";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { simulatorBranches, simulatorData } from "./simulator";

/** The POS simulator reads the live menu and boards; it writes nothing (ADR-135). */

let ctx: TenantContext;
let main: string;
let north: string;
let item: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("pos-simulator"));
  main = (await createBranch(ctx, { code: "MAIN", name: "Main", type: "RESTAURANT" })).id;
  north = (await createBranch(ctx, { code: "NORTH", name: "North", type: "RESTAURANT" })).id;
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  const can = (
    await createProduct(ctx, {
      sku: "COLA",
      nameEn: "Cola can",
      type: "FINISHED_GOOD",
      baseUomId: each,
    })
  ).id;
  const category = (await createMenuCategory(ctx, { name: "Drinks" })).id;
  item = (await createMenuItem(ctx, {
    code: "cola",
    name: "Cola",
    categoryId: category,
    kind: "ITEM",
    productId: can,
    barcode: "6281000000014",
  }))!.id;
  await addMenuItemPrice(ctx, item, {
    channel: "TAKEAWAY",
    price: "5",
    effectiveFrom: addDays(businessDate(ctx.timeZone), -1),
  });
  await createOrderingChannel(ctx, {
    kind: "BOARD",
    name: "Front screen",
    branchId: main,
    channels: ["TAKEAWAY"],
    boardTheme: "DARK",
  });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("POS simulator (ADR-135)", () => {
  it("gives the branch's live menu with barcodes, its boards and the discount right", async () => {
    expect((await simulatorBranches(ctx)).map((b) => b.code)).toEqual(["MAIN", "NORTH"]);
    const data = await simulatorData(ctx, main);
    expect(data.branch.code).toBe("MAIN");
    const cola = data.channels
      .find((c) => c.channel === "TAKEAWAY")!
      .items.find((i) => i.id === item)!;
    expect(cola).toMatchObject({ name: "Cola", barcodes: ["6281000000014"] });
    expect(cola.price.toString()).toBe("5");
    expect(data.boards).toHaveLength(1);
    expect(data.boards[0]).toMatchObject({
      name: "Front screen",
      channels: ["TAKEAWAY"],
      theme: "DARK",
    });
    expect(data.boards[0].path).toMatch(/^\/board\/.+/);
    expect(data.canDiscount).toBe(true);
    // The other branch has no board.
    expect((await simulatorData(ctx, north)).boards).toEqual([]);
  });

  it("is open only to people who sell or manage the POS, at their branches", async () => {
    const cashier = (
      await addMember(ctx, "cashier", { scopeType: "BRANCH", branchId: north }, "sim-cashier")
    ).ctx;
    expect((await simulatorBranches(cashier)).map((b) => b.code)).toEqual(["NORTH"]);
    await simulatorData(cashier, north);
    await expectAppError(simulatorData(cashier, main), "FORBIDDEN");
    const analyst = (await addMember(ctx, "analyst", {}, "sim-analyst")).ctx;
    await expectAppError(simulatorBranches(analyst), "FORBIDDEN");
    await expectAppError(simulatorData(analyst, main), "FORBIDDEN");
    // Another organization's branch is not found, never shown.
    const other = (await createTenant("pos-simulator-other")).ctx;
    await expectAppError(simulatorData(other, main), "NOT_FOUND");
  });

  it("records nothing", async () => {
    const db = getDb();
    const where = { organizationId: ctx.organizationId };
    const count = () => Promise.all([db.posOrder.count({ where }), db.auditEvent.count({ where })]);
    const before = await count();
    await simulatorBranches(ctx);
    await simulatorData(ctx, main);
    expect(await count()).toEqual(before);
  });
});
