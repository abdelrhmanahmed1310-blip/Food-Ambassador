import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { postOpeningBalance, postStatusChange } from "@/modules/inventory/operations";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { addOrderLine, approveOrder, createOrder, submitOrder } from "@/modules/procurement/orders";
import { saveReorderRule } from "@/modules/procurement/reorder";
import { updateProcurementSettings } from "@/modules/procurement/settings";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant } from "../../../test/support/factories";
import { attentionItems, type AttentionKey } from "./attention";

let ctx: TenantContext;
let buyer: TenantContext;
let units: Record<string, string>;
let kitchen: string;
let branchId: string;
let otherBranch: string;

const keys = async (c: TenantContext) =>
  Object.fromEntries((await attentionItems(c)).map((i) => [i.key, i.count])) as Partial<
    Record<AttentionKey, number>
  >;

beforeAll(async () => {
  ({ ctx } = await createTenant("attention"));
  buyer = (await addMember(ctx, "procurement")).ctx;
  units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  const branch = (await createBranch(ctx, { code: "ZAM", name: "Zamalek", type: "RESTAURANT" })).id;
  branchId = branch;
  otherBranch = (await createBranch(ctx, { code: "MAA", name: "Maadi", type: "RESTAURANT" })).id;
  kitchen = (
    await createWarehouse(ctx, {
      branchId: branch,
      code: "KIT",
      name: "Kitchen",
      type: "KITCHEN_STORE",
    })
  ).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("needs attention", () => {
  it("is empty for a new organization", async () => {
    expect(await attentionItems(ctx)).toEqual([]);
  });

  it("lists expiring, quarantined and below-minimum stock, and approvals by others", async () => {
    const today = businessDate(ctx.timeZone);
    const milk = (
      await createProduct(ctx, {
        sku: "MILK",
        nameEn: "Milk",
        type: "RAW_MATERIAL",
        baseUomId: units.l,
        lotTracking: "LOT_AND_EXPIRY",
      })
    ).id;
    const rice = (
      await createProduct(ctx, {
        sku: "RICE",
        nameEn: "Rice",
        type: "RAW_MATERIAL",
        baseUomId: units.kg,
      })
    ).id;
    await postOpeningBalance(ctx, {
      warehouseId: kitchen,
      productId: milk,
      lotCode: "M-SOON",
      expiresOn: addDays(today, 3),
      quantity: "10",
      uomId: units.l,
      unitCost: "2",
    });
    await postOpeningBalance(ctx, {
      warehouseId: kitchen,
      productId: milk,
      lotCode: "M-LATER",
      expiresOn: addDays(today, 60),
      quantity: "10",
      uomId: units.l,
      unitCost: "2",
    });
    await postOpeningBalance(ctx, {
      warehouseId: kitchen,
      productId: rice,
      quantity: "5",
      uomId: units.kg,
      unitCost: "1",
    });
    await postStatusChange(ctx, {
      warehouseId: kitchen,
      productId: rice,
      fromStatus: "AVAILABLE",
      toStatus: "QUARANTINE",
      quantity: "2",
      uomId: units.kg,
      reasonCode: "QUALITY_CHECK",
    });
    // 3 kg of rice usable; minimum 10 → below. Milk: 20 l, minimum 5 → fine.
    await saveReorderRule(ctx, {
      warehouseId: kitchen,
      productId: rice,
      uomId: units.kg,
      minQuantity: "10",
      maxQuantity: "20",
    });
    await saveReorderRule(ctx, {
      warehouseId: kitchen,
      productId: milk,
      uomId: units.l,
      minQuantity: "5",
      maxQuantity: "30",
    });

    await updateProcurementSettings(ctx, {
      approvalThreshold: "10",
      overReceiptTolerancePercent: "0",
    });
    const supplierId = (await createSupplier(ctx, { code: "MILL", name: "Mill" })).id;
    const po = await createOrder(buyer, { supplierId, warehouseId: kitchen });
    await addOrderLine(buyer, po.id, {
      productId: rice,
      quantity: "20",
      uomId: units.kg,
      unitPrice: "2",
    });
    await submitOrder(buyer, po.id);

    // Default chain (ADR-049): two branch steps first, so the branch's
    // approver sees it and head office (the owner) does not yet.
    const owner = await keys(ctx);
    expect(owner).toMatchObject({ EXPIRING_STOCK: 1, QUARANTINE: 1, BELOW_MINIMUM: 1 });
    expect(owner.ORDERS_TO_APPROVE).toBeUndefined();
    const local = (await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId })).ctx;
    expect((await keys(local)).ORDERS_TO_APPROVE).toBe(1);
    await approveOrder(local, po.id);
    expect((await keys(local)).ORDERS_TO_APPROVE).toBeUndefined(); // already signed
    const local2 = (await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId })).ctx;
    await approveOrder(local2, po.id);
    expect((await keys(ctx)).ORDERS_TO_APPROVE).toBe(1); // now head office
    expect(owner.EXPIRED_STOCK).toBeUndefined();
    // Danger before warning before info.
    const order = (await attentionItems(ctx)).map((i) => i.tone);
    expect(order).toEqual(
      [...order].sort(
        (a, b) =>
          ["danger", "warning", "info"].indexOf(a) - ["danger", "warning", "info"].indexOf(b),
      ),
    );

    // The buyer may not approve their own order and cannot release quarantine.
    const b = await keys(buyer);
    expect(b.ORDERS_TO_APPROVE).toBeUndefined();
    expect(b.QUARANTINE).toBeUndefined();
    expect(b.BELOW_MINIMUM).toBe(1);

    // A manager of another branch sees none of this branch's stock.
    const manager = (
      await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: otherBranch })
    ).ctx;
    expect(await keys(manager)).toEqual({});
  });
});
