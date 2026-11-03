import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { updateApprovalMatrix } from "@/modules/approvals/service";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { enqueueJobInTx, listJobs, runDueJobs } from "@/modules/jobs/service";
import { addOrderLine, approveOrder, createOrder, submitOrder } from "@/modules/procurement/orders";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { withSystemTx } from "@/server/db/transactions";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  saveNotificationPreferences,
  unreadCount,
} from "./service";

/** Notifications and background jobs (ADR-087). */

let ctx: TenantContext;
let buyer: TenantContext;
let approver: TenantContext;
let elsewhere: TenantContext;
let other: TenantContext;
let warehouseId: string;
let supplierId: string;
let flour: string;
let kg: string;

const kinds = async (c: TenantContext) => (await listNotifications(c)).items.map((n) => n.kind);

async function order() {
  const { id } = await createOrder(buyer, { supplierId, warehouseId });
  await addOrderLine(buyer, id, { productId: flour, quantity: "10", unitPrice: "5", uomId: kg });
  await submitOrder(buyer, id);
  return id;
}

beforeAll(async () => {
  ({ ctx } = await createTenant("notify"));
  ({ ctx: other } = await createTenant("notify-other"));
  kg = (await listUnits(ctx)).find((u) => u.code === "kg")!.id;
  const ruh = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" })).id;
  const jed = (await createBranch(ctx, { code: "JED", name: "Jeddah", type: "RESTAURANT" })).id;
  warehouseId = (await createWarehouse(ctx, { branchId: ruh, code: "K", name: "K", type: "MAIN" }))
    .id;
  flour = (
    await createProduct(ctx, { sku: "FLOUR", nameEn: "Flour", type: "RAW_MATERIAL", baseUomId: kg })
  ).id;
  supplierId = (await createSupplier(ctx, { code: "MILL", name: "Mill" })).id;
  buyer = (await addMember(ctx, "procurement", {}, "buyer")).ctx;
  approver = (
    await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: ruh }, "ruh-mgr")
  ).ctx;
  elsewhere = (
    await addMember(ctx, "branch_manager", { scopeType: "BRANCH", branchId: jed }, "jed-mgr")
  ).ctx;
  // Every order needs the branch's approval.
  await updateApprovalMatrix(ctx, "PURCHASE_ORDER", { layer1: "0" });
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("notifications (ADR-087)", () => {
  it("tells the people who may approve, at the order's branch only, never the submitter", async () => {
    const id = await order();
    expect(await kinds(approver)).toEqual(["PO_APPROVAL_NEEDED"]);
    expect(await kinds(elsewhere)).toEqual([]); // another branch
    expect(await kinds(buyer)).toEqual([]); // the submitter
    const n = (await listNotifications(approver)).items[0];
    expect(n).toMatchObject({ link: `/purchasing/orders/${id}`, readAt: null });
    expect((n.params as { number: string }).number).toMatch(/^PO-/);

    // The decision goes back to the submitter.
    await approveOrder(approver, id);
    expect(await kinds(buyer)).toEqual(["PO_APPROVED"]);
  });

  it("opens and marks read only the user's own notifications", async () => {
    const [n] = (await listNotifications(approver)).items;
    await expectAppError(markNotificationRead(buyer, n.id), "NOT_FOUND");
    await expectAppError(markNotificationRead(other, n.id), "NOT_FOUND");
    expect(await unreadCount(approver)).toBe(1);
    expect((await markNotificationRead(approver, n.id)).link).toBe(n.link);
    expect(await unreadCount(approver)).toBe(0);
    // Another organization sees none of them.
    expect((await listNotifications(other)).items).toEqual([]);
    await markAllNotificationsRead(buyer);
    expect(await unreadCount(buyer)).toBe(0);
  });

  it("respects each user's choice of what to be told", async () => {
    await saveNotificationPreferences(buyer, { on: [] }); // everything off
    const id = await order();
    await approveOrder(approver, id);
    expect((await listNotifications(buyer, { unreadOnly: true })).items).toEqual([]);
    await saveNotificationPreferences(buyer, { on: ["PO_APPROVED"] });
    const again = await order();
    await approveOrder(approver, again);
    expect((await listNotifications(buyer, { unreadOnly: true })).items.map((n) => n.kind)).toEqual(
      ["PO_APPROVED"],
    );
  });
});

describe("background jobs (ADR-087)", () => {
  it("sends the daily attention summary once per day", async () => {
    await order(); // one order waiting for the Riyadh manager
    const job = {
      organizationId: ctx.organizationId,
      kind: "attention.digest" as const,
      payload: { organizationId: ctx.organizationId, date: "2026-11-03" },
    };
    await withSystemTx((tx) =>
      enqueueJobInTx(tx, { ...job, dedupeKey: `t1:${ctx.organizationId}` }),
    );
    // The same key again is ignored.
    expect(
      await withSystemTx((tx) =>
        enqueueJobInTx(tx, { ...job, dedupeKey: `t1:${ctx.organizationId}` }),
      ),
    ).toBe(0);
    await runDueJobs({ limit: 5 });
    const digest = (await listNotifications(approver)).items.filter(
      (n) => n.kind === "ATTENTION_DIGEST",
    );
    expect(digest).toHaveLength(1);
    expect(digest[0].link).toBe("/attention");
    // A second run for the same day writes no second summary.
    await withSystemTx((tx) =>
      enqueueJobInTx(tx, { ...job, dedupeKey: `t2:${ctx.organizationId}` }),
    );
    await runDueJobs({ limit: 5 });
    expect(
      (await listNotifications(approver)).items.filter((n) => n.kind === "ATTENTION_DIGEST"),
    ).toHaveLength(1);
    expect((await listJobs(ctx)).filter((j) => j.status === "DONE")).toHaveLength(2);
  });

  it("retries a failing job with backoff, then gives up and tells the administrators", async () => {
    await withSystemTx((tx) =>
      enqueueJobInTx(tx, {
        organizationId: ctx.organizationId,
        kind: "attention.digest",
        payload: { broken: true },
        dedupeKey: `fail:${ctx.organizationId}`,
        maxAttempts: 2,
      }),
    );
    const failing = {
      "attention.digest": async () => {
        throw new Error("Simulated failure");
      },
    };
    const first = await runDueJobs({ limit: 5, handlers: failing });
    expect(first.map((r) => r.status)).toEqual(["QUEUED"]); // retry later
    const queued = await getDb().job.findFirstOrThrow({
      where: { dedupeKey: `fail:${ctx.organizationId}` },
    });
    expect(queued.runAt.getTime()).toBeGreaterThan(Date.now() + 50_000); // about a minute later
    expect(queued.lastError).toBe("Simulated failure");
    // Nothing is due yet; an hour later it is, and the second failure is final.
    expect(await runDueJobs({ limit: 5, handlers: failing })).toEqual([]);
    const later = () => new Date(Date.now() + 3_600_000);
    expect(
      (await runDueJobs({ limit: 5, handlers: failing, now: later })).map((r) => r.status),
    ).toEqual(["FAILED"]);
    expect(await kinds(ctx)).toContain("JOB_FAILED"); // the owner administers the organization
    expect(await kinds(buyer)).not.toContain("JOB_FAILED");
    // Jobs are the organization's own: another organization does not see them.
    expect(await listJobs(other)).toEqual([]);
    await expectAppError(listJobs(buyer), "FORBIDDEN");
  });
});
