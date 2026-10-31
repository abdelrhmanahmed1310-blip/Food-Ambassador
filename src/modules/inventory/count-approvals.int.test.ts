import { beforeAll, describe, expect, it } from "vitest";
import { updateApprovalMatrix } from "@/modules/approvals/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withTenantTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  createCount,
  getCount,
  postCount,
  recordCountedQuantity,
  rejectCount,
  submitCount,
} from "./counts";
import { postOpeningBalance } from "./operations";

let ctx: TenantContext;
let branchId: string;
let wh: string;
let rice: string;
let salt: string; // stock without a known cost
let counter: TenantContext;
let local: Awaited<ReturnType<typeof addMember>>;
let headOffice: Awaited<ReturnType<typeof addMember>>;

async function onHand(productId: string) {
  const rows = await getDb().stockBalance.findMany({
    where: { organizationId: ctx.organizationId, productId, warehouseId: wh },
  });
  return rows.reduce((a, r) => a + Number(r.onHandQuantity), 0);
}

/** A submitted count where `productId` is counted as `counted`, everything else as expected. */
async function countWith(productId: string, counted: string) {
  const { id } = await createCount(counter, { warehouseId: wh });
  for (const l of (await getCount(counter, id)).lines)
    await recordCountedQuantity(counter, id, l.id, {
      countedQuantity: l.product.id === productId ? counted : l.expectedQuantity.toString(),
    });
  await submitCount(counter, id);
  return id;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("count-approvals"));
  const units = Object.fromEntries((await listUnits(ctx)).map((u) => [u.code, u.id]));
  branchId = (await createBranch(ctx, { code: "HEL", name: "Heliopolis", type: "RESTAURANT" })).id;
  wh = (await createWarehouse(ctx, { branchId, code: "ST", name: "Store", type: "MAIN" })).id;
  rice = (
    await createProduct(ctx, {
      sku: "RICE",
      nameEn: "Rice",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  salt = (
    await createProduct(ctx, {
      sku: "SALT",
      nameEn: "Salt",
      type: "RAW_MATERIAL",
      baseUomId: units.kg,
    })
  ).id;
  await postOpeningBalance(ctx, {
    warehouseId: wh,
    productId: rice,
    quantity: "10",
    uomId: units.kg,
    unitCost: "5",
  });
  await postOpeningBalance(ctx, {
    warehouseId: wh,
    productId: salt,
    quantity: "4",
    uomId: units.kg,
  });
  counter = (await addMember(ctx, "warehouse", { scopeType: "WAREHOUSE", warehouseId: wh })).ctx;
  local = await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId });
  headOffice = await addMember(ctx, "operations_manager");
  // Branch layer always, second branch layer above 50, head office above 5 (value of differences).
  await updateApprovalMatrix(ctx, "STOCK_COUNT", { layer1: "0", layer2: "50", layer4: "5" });
});

describe("stock count approval matrix (ADR-049, Q-12)", () => {
  it("values the differences and runs only the layers above their limits", async () => {
    const id = await countWith(rice, "8"); // −2 kg × 5 = 10
    let count = await getCount(ctx, id);
    expect(count.varianceValue?.toFixed()).toBe("10");
    expect(count.approvalSteps.map((s) => s.level)).toEqual(["BRANCH", "HEAD_OFFICE"]);

    // The counter never approves; head office cannot sign the branch step.
    await expectAppError(postCount(counter, id), "FORBIDDEN");
    await expectAppError(postCount(headOffice.ctx, id), "BUSINESS_RULE_VIOLATION");
    expect((await getCount(headOffice.ctx, id)).approvalBlocked).toBe("LEVEL");
    await expectAppError(postCount(ctx, id), "BUSINESS_RULE_VIOLATION"); // owner = head office

    expect(await postCount(local.ctx, id)).toEqual({ documentNumber: null, status: "SUBMITTED" });
    expect(await onHand(rice)).toBe(10); // nothing posted before the last step
    await expectAppError(postCount(local.ctx, id), "BUSINESS_RULE_VIOLATION"); // HO step now

    // Head office sends it back: recount, resubmit, new round.
    await rejectCount(headOffice.ctx, id, { reason: "Recount the top shelf" });
    count = await getCount(counter, id);
    expect(count).toMatchObject({ status: "OPEN", rejectionNote: "Recount the top shelf" });
    const riceLine = count.lines.find((l) => l.product.id === rice)!;
    await recordCountedQuantity(counter, id, riceLine.id, { countedQuantity: "9" }); // −1 × 5 = 5
    await submitCount(counter, id);
    count = await getCount(ctx, id);
    expect(count.approvalSteps.map((s) => s.level)).toEqual(["BRANCH"]); // 5 is not above 5
    const posted = await postCount(local.ctx, id);
    expect(posted.status).toBe("POSTED");
    expect(posted.documentNumber).toMatch(/^CNT-/);
    expect(await onHand(rice)).toBe(9);
    const rounds = await getDb().stockCountApproval.findMany({ where: { countId: id } });
    expect(rounds.map((r) => r.round).sort()).toEqual([1, 2]);
  });

  it("applies every layer when a differing item has no cost, and none without differences", async () => {
    const unknown = await countWith(salt, "3");
    const c = await getCount(ctx, unknown);
    expect(c.varianceValue).toBeNull();
    expect(c.approvalSteps.map((s) => s.level)).toEqual(["BRANCH", "BRANCH", "HEAD_OFFICE"]);
    const second = await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId });
    await postCount(local.ctx, unknown);
    await expectAppError(postCount(local.ctx, unknown), "BUSINESS_RULE_VIOLATION"); // same person
    await postCount(second.ctx, unknown);
    expect((await postCount(headOffice.ctx, unknown)).status).toBe("POSTED");

    const clean = await countWith(rice, "9"); // no difference
    expect((await getCount(ctx, clean)).approvalSteps).toEqual([]);
    expect((await postCount(local.ctx, clean)).status).toBe("POSTED");
  });

  it("the database refuses an approval by the counter", async () => {
    const id = await countWith(rice, "7");
    const counterId = (await getDb().stockCount.findUniqueOrThrow({ where: { id } }))
      .submittedByUserId!;
    await expect(
      withTenantTx(ctx.organizationId, (tx) =>
        tx.stockCountApproval.create({
          data: {
            organizationId: ctx.organizationId,
            countId: id,
            round: 1,
            step: 1,
            level: "BRANCH",
            approvedByUserId: counterId,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
