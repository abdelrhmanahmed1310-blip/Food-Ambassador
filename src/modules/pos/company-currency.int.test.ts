import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { salesDashboard } from "@/modules/analytics/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { setExchangeRate } from "@/modules/fx/service";
import { postOpeningBalance } from "@/modules/inventory/operations";
import { businessDate } from "@/modules/inventory/rules";
import {
  addMenuItemPrice,
  addModifierOption,
  attachModifierGroup,
  createMenuCategory,
  createMenuItem,
  createModifierGroup,
} from "@/modules/menu/service";
import { createCompany } from "@/modules/organizations/companies";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { createTenant, expectAppError } from "../../../test/support/factories";
import { adjustPoints, createCustomer, saveLoyaltySettings } from "./customers";
import { sellGiftCard } from "./gift-cards";
import {
  createRegister,
  getOrder,
  openShift,
  sellableMenu,
  submitOrder,
  tillData,
} from "./service";

/** The point of sale of a company keeping its books in its own currency (ADR-086, step 3c). */

let ctx: TenantContext;
let egy: string;
let caiBranch: string;
let ruhTill: string;
let caiTill: string;
let burger: string;
let cheese: string;
let noOnion: string;
const today = () => businessDate(ctx.timeZone);
const sale = (registerId: string, extra: Record<string, unknown> = {}, amount = "300") =>
  submitOrder(ctx, {
    orderId: randomUUID(),
    registerId,
    channel: "DINE_IN",
    lines: [{ itemId: burger, quantity: "1", optionIds: [] }],
    payments: [{ method: "CASH", amount }],
    ...extra,
  });

beforeAll(async () => {
  ({ ctx } = await createTenant("co-pos", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  egy = (
    await createCompany(ctx, {
      code: "EGY",
      name: "Egypt",
      legalName: "Egypt Foods",
      currency: "EGP",
    })
  ).id;
  const ruhBranch = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" }))
    .id;
  caiBranch = (
    await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT", companyId: egy })
  ).id;
  const ruh = (
    await createWarehouse(ctx, {
      branchId: ruhBranch,
      code: "RUH-K",
      name: "K",
      type: "KITCHEN_STORE",
    })
  ).id;
  const cai = (
    await createWarehouse(ctx, {
      branchId: caiBranch,
      code: "CAI-K",
      name: "K",
      type: "KITCHEN_STORE",
    })
  ).id;
  const patty = (
    await createProduct(ctx, {
      sku: "PATTY",
      nameEn: "Patty",
      type: "FINISHED_GOOD",
      baseUomId: each,
    })
  ).id;
  for (const [w, cost] of [
    [ruh, "10"],
    [cai, "40"],
  ])
    await postOpeningBalance(ctx, {
      warehouseId: w,
      productId: patty,
      quantity: "50",
      uomId: each,
      unitCost: cost,
    });
  const cat = (await createMenuCategory(ctx, { name: "Mains" })).id;
  burger = (
    await createMenuItem(ctx, {
      code: "BURGER",
      name: "Burger",
      categoryId: cat,
      kind: "ITEM",
      productId: patty,
    })
  ).id;
  // A price for all branches (SAR) and Cairo's own (EGP).
  await addMenuItemPrice(ctx, burger, { channel: "DINE_IN", price: "30", effectiveFrom: today() });
  await addMenuItemPrice(ctx, burger, {
    channel: "DINE_IN",
    price: "300",
    effectiveFrom: today(),
    branchId: caiBranch,
  });
  const extras = (
    await createModifierGroup(ctx, { name: "Extras", minSelect: "0", maxSelect: "2" })
  ).id;
  await addModifierOption(ctx, extras, { name: "Cheese", priceDelta: "2" });
  await addModifierOption(ctx, extras, { name: "No onion", priceDelta: "0" });
  await attachModifierGroup(ctx, burger, { groupId: extras });
  const options = await getDb().modifierOption.findMany({ where: { groupId: extras } });
  cheese = options.find((o) => o.name === "Cheese")!.id;
  noOnion = options.find((o) => o.name === "No onion")!.id;
  ruhTill = (
    await createRegister(ctx, { branchId: ruhBranch, warehouseId: ruh, code: "RUH1", name: "Till" })
  ).id;
  caiTill = (
    await createRegister(ctx, { branchId: caiBranch, warehouseId: cai, code: "CAI1", name: "Till" })
  ).id;
  await openShift(ctx, ruhTill, { openingFloat: "0" });
  await openShift(ctx, caiTill, { openingFloat: "0" });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("the point of sale in a company's own currency (ADR-086)", () => {
  it("the Cairo till sells in EGP at Cairo's own prices", async () => {
    expect((await tillData(ctx, caiTill)).currency).toBe("EGP");
    expect((await tillData(ctx, ruhTill)).currency).toBe("SAR");
    const menu = await sellableMenu(ctx, caiBranch, today());
    const item = menu.find((m) => m.channel === "DINE_IN")!.items.find((i) => i.id === burger)!;
    expect(item.price).toBe("300");
    // Options that change the price (in SAR) are not offered in Cairo.
    expect(item.groups[0].options.map((o) => o.name)).toEqual(["No onion"]);

    const o = await getOrder(ctx, (await sale(caiTill)).id);
    expect([o.grossAmount.toFixed(), o.costAmount?.toFixed()]).toEqual(["300", "40"]);
    expect((await sale(ruhTill, {}, "30")).gross.toFixed()).toBe("30");
  });

  it("refuses what is valued in the group's currency", async () => {
    await expectAppError(
      sale(caiTill, { lines: [{ itemId: burger, quantity: "1", optionIds: [cheese] }] }),
      "BUSINESS_RULE_VIOLATION",
    );
    // Without a price change, the option is fine.
    await sale(caiTill, { lines: [{ itemId: burger, quantity: "1", optionIds: [noOnion] }] });

    await saveLoyaltySettings(ctx, {
      enabled: "on",
      earnRate: "1",
      pointValue: "0.05",
      minRedeemPoints: "20",
    });
    const customerId = (await createCustomer(ctx, { name: "Mona", phone: "0501234567" })).id;
    await adjustPoints(ctx, customerId, { points: "100", reason: "Welcome" });
    await expectAppError(
      sale(caiTill, { customerId, loyaltyPoints: 20 }),
      "BUSINESS_RULE_VIOLATION",
    );
    // Buying in Cairo earns no points (points are worth SAR).
    await sale(caiTill, { customerId });
    expect(
      (await getDb().posCustomer.findUniqueOrThrow({ where: { id: customerId } })).pointsBalance,
    ).toBe(100);

    // A gift card sold in Riyadh (SAR) is not spent in Cairo.
    const card = await sellGiftCard(ctx, { registerId: ruhTill, amount: "50", method: "CASH" });
    await expectAppError(
      sale(caiTill, {
        payments: [{ method: "GIFT_CARD", amount: "300", giftCardCode: card.code }],
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });

  it("the overview converts Cairo's sales; the Egyptian company alone stays in EGP", async () => {
    const before = await salesDashboard(ctx);
    expect(before!.missingRates).toEqual(["EGP"]);
    expect(before!.today.net.toFixed()).toBe("30"); // Cairo left out: no EGP rate yet
    await setExchangeRate(ctx, { currency: "EGP", rateDate: today(), rate: "0.075" });
    const group = await salesDashboard(ctx);
    // 30 SAR + 3 Cairo orders × 300 EGP × 0.075 = 30 + 67.5.
    expect([group!.currency, group!.today.net.toFixed()]).toEqual(["SAR", "97.5"]);
    const egypt = await salesDashboard(ctx, egy);
    expect([egypt!.currency, egypt!.today.net.toFixed()]).toEqual(["EGP", "900"]);
  });
});
