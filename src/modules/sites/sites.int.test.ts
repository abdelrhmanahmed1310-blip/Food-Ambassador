import { afterAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@/lib/uuid";
import { getDb } from "@/server/db/client";
import { createTenant, expectAppError } from "../../../test/support/factories";
import { createBranch, getBranch, listBranches, setBranchArchived, updateBranch } from "./branches";
import {
  createLocation,
  createWarehouse,
  getWarehouse,
  setLocationArchived,
  setWarehouseArchived,
} from "./warehouses";

afterAll(async () => {
  await getDb().$disconnect();
});

describe("branches, warehouses and locations", () => {
  it("normalizes codes and enforces per-organization uniqueness", async () => {
    const { ctx } = await createTenant("codes");
    const { ctx: other } = await createTenant("codes-other");
    const branch = await createBranch(ctx, {
      code: " cai-01 ",
      name: "Cairo",
      type: "RESTAURANT",
      country: "eg",
    });
    expect(await getBranch(ctx, branch.id)).toMatchObject({ code: "CAI-01", country: "EG" });
    await expectAppError(
      createBranch(ctx, { code: "CAI-01", name: "dup", type: "OTHER" }),
      "CONFLICT",
    );
    await createBranch(other, { code: "CAI-01", name: "Same code, other org", type: "OTHER" });
  });

  it("validates input server-side", async () => {
    const { ctx } = await createTenant("validate");
    await expectAppError(
      createBranch(ctx, { code: "bad code!", name: "", type: "PALACE" }),
      "VALIDATION_FAILED",
    );
    try {
      await createBranch(ctx, {
        code: "",
        name: "x".repeat(200),
        type: "RESTAURANT",
        timeZone: "Mars/Olympus",
      });
    } catch (e) {
      const issues = (e as { details: { issues: Array<{ path: string; message: string }> } })
        .details.issues;
      expect(issues).toEqual(
        expect.arrayContaining([
          { path: "code", message: "required" },
          { path: "name", message: "tooLong" },
          { path: "timeZone", message: "invalidTimeZone" },
        ]),
      );
    }
  });

  it("clears optional fields on update", async () => {
    const { ctx } = await createTenant("clear");
    const b = await createBranch(ctx, { code: "A", name: "A", type: "OFFICE", city: "Giza" });
    await updateBranch(ctx, b.id, { code: "A", name: "A", type: "OFFICE", city: "" });
    expect((await getBranch(ctx, b.id)).city).toBeNull();
  });

  it("enforces archive rules", async () => {
    const { ctx } = await createTenant("archive");
    const branch = await createBranch(ctx, { code: "BR", name: "Branch", type: "RESTAURANT" });
    const wh = await createWarehouse(ctx, {
      branchId: branch.id,
      code: "WH",
      name: "Store",
      type: "MAIN",
    });
    const loc = await createLocation(ctx, wh.id, {
      code: "L1",
      name: "Chiller",
      temperatureZone: "CHILLED",
    });

    await expectAppError(setBranchArchived(ctx, branch.id, true), "BUSINESS_RULE_VIOLATION");
    await setLocationArchived(ctx, loc.id, true);
    await setWarehouseArchived(ctx, wh.id, true);
    await expectAppError(
      createLocation(ctx, wh.id, { code: "L2", name: "x", temperatureZone: "AMBIENT" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(setLocationArchived(ctx, loc.id, false), "BUSINESS_RULE_VIOLATION");
    await setBranchArchived(ctx, branch.id, true);
    await expectAppError(
      createWarehouse(ctx, { branchId: branch.id, code: "WH2", name: "x", type: "MAIN" }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(setWarehouseArchived(ctx, wh.id, false), "BUSINESS_RULE_VIOLATION");

    expect((await listBranches(ctx)).total).toBe(0);
    expect((await listBranches(ctx, { status: "archived" })).total).toBe(1);
    await setBranchArchived(ctx, branch.id, false);
    await setWarehouseArchived(ctx, wh.id, false);
    expect((await getWarehouse(ctx, wh.id)).archivedAt).toBeNull();
  });

  it("writes audit events in the same transaction", async () => {
    const { ctx } = await createTenant("audit");
    const b = await createBranch(ctx, { code: "AUD", name: "Audited", type: "RESTAURANT" });
    await updateBranch(ctx, b.id, { code: "AUD", name: "Audited 2", type: "RESTAURANT" });
    await setBranchArchived(ctx, b.id, true);
    const events = await getDb().auditEvent.findMany({
      where: { organizationId: ctx.organizationId, entityId: b.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(events.map((e) => e.action)).toEqual([
      "branch.created",
      "branch.updated",
      "branch.archived",
    ]);
    expect(events.every((e) => e.actorUserId === ctx.userId)).toBe(true);
    expect(events[1].changes).toEqual({ name: { from: "Audited", to: "Audited 2" } });

    // A failed mutation leaves no audit event.
    await expectAppError(
      createBranch(ctx, { code: "AUD", name: "dup", type: "OTHER" }),
      "CONFLICT",
    );
    expect(
      await getDb().auditEvent.count({
        where: { organizationId: ctx.organizationId, action: "branch.created" },
      }),
    ).toBe(1);
  });
});

describe("AC1.6 audit events are immutable", () => {
  it("rejects UPDATE, DELETE and TRUNCATE at the database level", async () => {
    const { ctx } = await createTenant("immutable");
    const event = await getDb().auditEvent.findFirstOrThrow({
      where: { organizationId: ctx.organizationId },
    });
    await expect(
      getDb().auditEvent.update({ where: { id: event.id }, data: { action: "tampered" } }),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(getDb().$executeRawUnsafe('TRUNCATE "audit_events" CASCADE')).rejects.toThrow(
      /append-only/,
    );
    expect((await getDb().auditEvent.findUniqueOrThrow({ where: { id: event.id } })).action).toBe(
      event.action,
    );
  });
});

describe("AC1.9 idempotent creation", () => {
  it("returns the same warehouse for a repeated submission", async () => {
    const { ctx } = await createTenant("idem");
    const branch = await createBranch(ctx, { code: "BR", name: "Branch", type: "RESTAURANT" });
    const key = uuidv7();
    const input = {
      branchId: branch.id,
      code: "WH-1",
      name: "Store",
      type: "MAIN",
      idempotencyKey: key,
    };
    const first = await createWarehouse(ctx, input);
    const second = await createWarehouse(ctx, input);
    expect(second.id).toBe(first.id);
    expect(await getDb().warehouse.count({ where: { organizationId: ctx.organizationId } })).toBe(
      1,
    );
  });

  it("creates one warehouse when duplicates race", async () => {
    const { ctx } = await createTenant("idem-race");
    const branch = await createBranch(ctx, { code: "BR", name: "Branch", type: "RESTAURANT" });
    const input = {
      branchId: branch.id,
      code: "WH-R",
      name: "Store",
      type: "MAIN",
      idempotencyKey: uuidv7(),
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => createWarehouse(ctx, input)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await getDb().warehouse.count({ where: { organizationId: ctx.organizationId } })).toBe(
      1,
    );
    expect(
      await getDb().auditEvent.count({
        where: { organizationId: ctx.organizationId, action: "warehouse.created" },
      }),
    ).toBe(1);
  });

  it("rejects reuse of a key for a different request", async () => {
    const { ctx } = await createTenant("idem-reuse");
    const branch = await createBranch(ctx, { code: "BR", name: "Branch", type: "RESTAURANT" });
    const key = uuidv7();
    await createWarehouse(ctx, {
      branchId: branch.id,
      code: "WH-A",
      name: "A",
      type: "MAIN",
      idempotencyKey: key,
    });
    await expectAppError(
      createWarehouse(ctx, {
        branchId: branch.id,
        code: "WH-B",
        name: "B",
        type: "MAIN",
        idempotencyKey: key,
      }),
      "CONFLICT",
    );
  });
});
