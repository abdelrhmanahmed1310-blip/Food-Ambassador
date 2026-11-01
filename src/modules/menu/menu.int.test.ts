import { beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createRecipe } from "@/modules/recipes/recipes";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  addComboComponent,
  addMenuItemPrice,
  addModifierOption,
  attachModifierGroup,
  createMenuCategory,
  createMenuItem,
  createModifierGroup,
  getMenuItem,
  listMenu,
  menuForBranch,
  setItemAvailability,
  setMenuItemArchived,
  updateMenuItem,
} from "./service";

let ctx: TenantContext;
let today: string;
let city: string;
let airport: string;
let mains: string;
let dish: string;
let prep: string;
let cola: string;
let cheese: string;

beforeAll(async () => {
  ({ ctx } = await createTenant("menu"));
  today = businessDate(ctx.timeZone);
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  city = (await createBranch(ctx, { code: "CITY", name: "City", type: "RESTAURANT" })).id;
  airport = (await createBranch(ctx, { code: "AIR", name: "Airport", type: "RESTAURANT" })).id;
  dish = (await createRecipe(ctx, {
    code: "BURGER",
    name: "Burger",
    type: "DISH",
    yieldQuantity: "1",
    yieldUomId: units.each,
    portions: "1",
  }))!.id;
  prep = (await createRecipe(ctx, {
    code: "SAUCE",
    name: "Sauce",
    type: "PREPARATION",
    yieldQuantity: "1",
    yieldUomId: units.kg,
  }))!.id;
  cola = (
    await createProduct(ctx, {
      sku: "COLA",
      nameEn: "Cola can",
      type: "FINISHED_GOOD",
      baseUomId: units.each,
    })
  ).id;
  cheese = (
    await createProduct(ctx, {
      sku: "CHEESE",
      nameEn: "Cheese",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  mains = (await createMenuCategory(ctx, { name: "Mains", nameAr: "أطباق رئيسية" })).id;
});

describe("menu items (ADR-058)", () => {
  it("sells dishes and stock products, never preparations; codes are unique", async () => {
    const burger = await createMenuItem(ctx, {
      code: "burger",
      name: "Burger",
      categoryId: mains,
      kind: "ITEM",
      recipeId: dish,
    });
    expect(burger.code).toBe("BURGER");
    const can = await createMenuItem(ctx, {
      code: "COLA",
      name: "Cola",
      categoryId: mains,
      kind: "ITEM",
      productId: cola,
    });
    expect((await getMenuItem(ctx, can.id)).productQuantity?.toFixed()).toBe("1");
    await expectAppError(
      createMenuItem(ctx, {
        code: "SAUCE",
        name: "Sauce",
        categoryId: mains,
        kind: "ITEM",
        recipeId: prep,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      createMenuItem(ctx, {
        code: "BOTH",
        name: "x",
        categoryId: mains,
        kind: "ITEM",
        recipeId: dish,
        productId: cola,
      }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createMenuItem(ctx, { code: "NONE", name: "x", categoryId: mains, kind: "ITEM" }),
      "VALIDATION_FAILED",
    );
    await expectAppError(
      createMenuItem(ctx, {
        code: "Burger",
        name: "Again",
        categoryId: mains,
        kind: "ITEM",
        recipeId: dish,
      }),
      "CONFLICT",
    );
    await expectAppError(
      updateMenuItem(ctx, burger.id, {
        code: "BURGER",
        name: "Burger",
        categoryId: mains,
        kind: "COMBO",
      }),
      "BUSINESS_RULE_VIOLATION",
    );
    // The database holds the rule too.
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.menuItem.create({
          data: {
            organizationId: ctx.organizationId,
            code: "RAW",
            name: "Raw",
            categoryId: mains,
            kind: "ITEM",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("prices per channel, with branch prices and dated history that cannot be changed", async () => {
    const id = (
      await getDb().menuItem.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, code: "BURGER" },
      })
    ).id;
    await addMenuItemPrice(ctx, id, {
      channel: "DINE_IN",
      price: "100",
      effectiveFrom: addDays(today, -10),
    });
    await addMenuItemPrice(ctx, id, { channel: "DINE_IN", price: "110", effectiveFrom: today });
    await addMenuItemPrice(ctx, id, {
      channel: "DINE_IN",
      branchId: airport,
      price: "130",
      effectiveFrom: today,
    });
    await addMenuItemPrice(ctx, id, {
      channel: "TAKEAWAY",
      price: "95",
      effectiveFrom: addDays(today, -10),
    });
    await expectAppError(
      addMenuItemPrice(ctx, id, { channel: "DINE_IN", price: "120", effectiveFrom: today }),
      "CONFLICT",
    );
    await expectAppError(
      addMenuItemPrice(ctx, id, { channel: "DINE_IN", price: "-1", effectiveFrom: today }),
      "VALIDATION_FAILED",
    );
    const price = async (branchId: string, channel: "DINE_IN" | "TAKEAWAY" | "DELIVERY") =>
      (await menuForBranch(ctx, { branchId, channel }))
        .find((i) => i.id === id)
        ?.price.price.toFixed() ?? null;
    expect(await price(city, "DINE_IN")).toBe("110");
    expect(await price(airport, "DINE_IN")).toBe("130");
    expect(await price(city, "TAKEAWAY")).toBe("95");
    expect(await price(city, "DELIVERY")).toBeNull(); // no delivery price: not on the delivery menu
    const row = await getDb().menuItemPrice.findFirstOrThrow({ where: { itemId: id } });
    await expect(
      getDb().menuItemPrice.update({ where: { id: row.id }, data: { price: "1" } }),
    ).rejects.toThrow();
    const overview = await listMenu(ctx);
    expect(overview[0].items.find((i) => i.id === id)?.current.DINE_IN?.price.toFixed()).toBe(
      "110",
    );
  });

  it("has modifier groups with choice limits and options that use stock", async () => {
    const burger = (
      await getDb().menuItem.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, code: "BURGER" },
      })
    ).id;
    await expectAppError(
      createModifierGroup(ctx, { name: "Bad", minSelect: "2", maxSelect: "1" }),
      "VALIDATION_FAILED",
    );
    const extras = (
      await createModifierGroup(ctx, { name: "Extras", minSelect: "0", maxSelect: "2" })
    ).id;
    await addModifierOption(ctx, extras, {
      name: "Extra cheese",
      priceDelta: "10",
      productId: cheese,
      quantity: "0.03",
    });
    await addModifierOption(ctx, extras, { name: "No onion", priceDelta: "0" });
    await expectAppError(
      addModifierOption(ctx, extras, { name: "Bad", productId: cheese }),
      "VALIDATION_FAILED",
    ); // uses stock but no quantity
    await attachModifierGroup(ctx, burger, { groupId: extras });
    await expectAppError(attachModifierGroup(ctx, burger, { groupId: extras }), "CONFLICT");
    const item = await getMenuItem(ctx, burger);
    expect(item.modifierGroups[0].group.options.map((o) => o.name)).toEqual([
      "Extra cheese",
      "No onion",
    ]);
  });

  it("builds combos from items only, one level deep", async () => {
    const meal = await createMenuItem(ctx, {
      code: "MEAL",
      name: "Burger meal",
      categoryId: mains,
      kind: "COMBO",
    });
    const burger = (
      await getDb().menuItem.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, code: "BURGER" },
      })
    ).id;
    const can = (
      await getDb().menuItem.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, code: "COLA" },
      })
    ).id;
    await addComboComponent(ctx, meal.id, { componentId: burger });
    await addComboComponent(ctx, meal.id, { componentId: can, quantity: "1" });
    const other = await createMenuItem(ctx, {
      code: "MEAL2",
      name: "Other meal",
      categoryId: mains,
      kind: "COMBO",
    });
    await expectAppError(
      addComboComponent(ctx, meal.id, { componentId: other.id }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      addComboComponent(ctx, burger, { componentId: can }),
      "BUSINESS_RULE_VIOLATION",
    );
    expect((await getMenuItem(ctx, meal.id)).components).toHaveLength(2);
  });

  it("can be withdrawn at one branch or archived everywhere", async () => {
    const burger = (
      await getDb().menuItem.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, code: "BURGER" },
      })
    ).id;
    await setItemAvailability(ctx, burger, airport, false);
    const ids = async (branchId: string) =>
      (await menuForBranch(ctx, { branchId, channel: "DINE_IN" })).map((i) => i.id);
    expect(await ids(airport)).not.toContain(burger);
    expect(await ids(city)).toContain(burger);
    await setItemAvailability(ctx, burger, airport, true);
    expect(await ids(airport)).toContain(burger);
    await setMenuItemArchived(ctx, burger, true);
    expect(await ids(city)).not.toContain(burger);
    await setMenuItemArchived(ctx, burger, false);
  });

  it("is managed by menu managers and private to the organization", async () => {
    const manager = (
      await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: city })
    ).ctx;
    expect((await listMenu(manager)).length).toBeGreaterThan(0); // can see it
    await expectAppError(createMenuCategory(manager, { name: "Drinks" }), "FORBIDDEN");
    const warehouse = (await addMember(ctx, "warehouse")).ctx;
    await expectAppError(listMenu(warehouse), "FORBIDDEN");
    const other = (await createTenant("menu-other")).ctx;
    const burger = (
      await getDb().menuItem.findFirstOrThrow({
        where: { organizationId: ctx.organizationId, code: "BURGER" },
      })
    ).id;
    await expectAppError(getMenuItem(other, burger), "NOT_FOUND");
    expect(await listMenu(other)).toEqual([]);
    await expectAppError(
      createMenuItem(other, {
        code: "X",
        name: "X",
        categoryId: mains,
        kind: "ITEM",
        recipeId: dish,
      }),
      "NOT_FOUND",
    );
  });
});
