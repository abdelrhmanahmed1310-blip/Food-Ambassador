import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { createEmployee } from "@/modules/hr/service";
import { createMenuCategory, createMenuItem } from "@/modules/menu/service";
import { createCustomer } from "@/modules/pos/customers";
import { createOrder } from "@/modules/procurement/orders";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant } from "../../../test/support/factories";
import { globalSearch, type SearchGroup } from "./service";

/** Global search within the user's permissions (ADR-088). */

let ctx: TenantContext;
let other: TenantContext;
let ruhManager: TenantContext;
let waiter: TenantContext;
let kitchen: TenantContext;
let poNumber: string;

const groups = async (c: TenantContext, q: string) =>
  Object.fromEntries((await globalSearch(c, q)).groups.map((g) => [g.group, g.hits])) as Partial<
    Record<SearchGroup, Array<{ code: string; title: string; href: string }>>
  >;

beforeAll(async () => {
  ({ ctx } = await createTenant("search", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  ({ ctx: other } = await createTenant("search-other"));
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  const ruh = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" })).id;
  const jed = (await createBranch(ctx, { code: "JED", name: "Jeddah", type: "RESTAURANT" })).id;
  const kitchenWh = (
    await createWarehouse(ctx, { branchId: ruh, code: "K", name: "K", type: "MAIN" })
  ).id;
  const oil = await createProduct(ctx, {
    sku: "OIL-OLIVE",
    nameEn: "Olive oil",
    nameAr: "زيت زيتون",
    type: "RAW_MATERIAL",
    baseUomId: each,
  });
  const supplierId = (await createSupplier(ctx, { code: "OLIVA", name: "Oliva Trading" })).id;
  poNumber = (await createOrder(ctx, { supplierId, warehouseId: kitchenWh })).number;
  for (const [number, firstName, branchId] of [
    ["E-100", "Olivia", ruh],
    ["E-200", "Oliver", jed],
  ] as const)
    await createEmployee(ctx, {
      number,
      firstName,
      lastName: "Stone",
      jobTitle: "Cook",
      branchId,
      employmentType: "FULL_TIME",
      hireDate: "2026-01-01",
    });
  const cat = (await createMenuCategory(ctx, { name: "Salads" })).id;
  await createMenuItem(ctx, {
    code: "OLIVE-SALAD",
    name: "Olive salad",
    categoryId: cat,
    kind: "ITEM",
    productId: oil.id,
  });
  await createCustomer(ctx, { name: "Guest Noura", phone: "0507771234" });
  ruhManager = (
    await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: ruh }, "ruh")
  ).ctx;
  waiter = (await addMember(ctx, "waiter", { scopeType: "BRANCH", branchId: ruh }, "waiter")).ctx;
  kitchen = (await addMember(ctx, "kitchen", { scopeType: "BRANCH", branchId: ruh }, "kitchen"))
    .ctx;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("global search (ADR-088)", () => {
  it("finds master data by code or name, in English or Arabic", async () => {
    const r = await groups(ctx, "oliv");
    expect(r.products?.map((h) => h.code)).toEqual(["OIL-OLIVE"]);
    expect(r.suppliers?.map((h) => h.code)).toEqual(["OLIVA"]);
    expect(r.menuItems?.map((h) => h.code)).toEqual(["OLIVE-SALAD"]);
    expect(r.employees?.map((h) => h.code).sort()).toEqual(["E-100", "E-200"]);
    expect(r.products?.[0].href).toMatch(/^\/catalog\/products\//);
    expect((await groups(ctx, "زيتون")).products?.map((h) => h.code)).toEqual(["OIL-OLIVE"]);
  });

  it("finds documents by number and guests by phone, however it is written", async () => {
    expect((await groups(ctx, poNumber)).purchaseOrders?.map((h) => h.code)).toEqual([poNumber]);
    expect((await groups(ctx, "050 777 1234")).guests?.map((h) => h.title)).toEqual([
      "Guest Noura",
    ]);
  });

  it("shows only what the user may open, where they may", async () => {
    // The Riyadh manager sees Riyadh's people only.
    expect((await groups(ruhManager, "oliv")).employees?.map((h) => h.code)).toEqual(["E-100"]);
    // A waiter sees menu items, not suppliers, people or prices.
    expect(Object.keys(await groups(waiter, "oliv"))).toEqual(["menuItems"]);
    // The kitchen screen role sees nothing searchable.
    expect(await groups(kitchen, "oliv")).toEqual({});
    // Another organization finds none of it.
    expect(await groups(other, "oliv")).toEqual({});
  });

  it("ignores queries that are too short", async () => {
    expect((await globalSearch(ctx, "o")).query).toBeNull();
    expect((await globalSearch(ctx, "   ")).groups).toEqual([]);
  });
});
