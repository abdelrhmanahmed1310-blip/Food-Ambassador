import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantRole, listMembers, removeMember, revokeRole } from "@/modules/members/service";
import { createBranch, listBranches, updateBranch } from "@/modules/sites/branches";
import { createWarehouse, listWarehouses, updateWarehouse } from "@/modules/sites/warehouses";
import { createRole, listRoles, updateRole } from "@/modules/access/roles";
import { getDb } from "@/server/db/client";
import {
  addMember,
  contextFor,
  createTenant,
  expectAppError,
} from "../../../test/support/factories";
import type { TenantContext } from "@/modules/tenancy/context";

afterAll(async () => {
  await getDb().$disconnect();
});

async function roleIdOf(ctx: TenantContext, key: string) {
  return (
    await getDb().role.findUniqueOrThrow({
      where: { organizationId_key: { organizationId: ctx.organizationId, key } },
    })
  ).id;
}

describe("AC1.4 permissions are enforced in services", () => {
  let owner: TenantContext;
  let branchX: string;
  let branchY: string;
  let whY: string;

  beforeAll(async () => {
    ({ ctx: owner } = await createTenant("acl"));
    branchX = (await createBranch(owner, { code: "X", name: "Branch X", type: "RESTAURANT" })).id;
    branchY = (await createBranch(owner, { code: "Y", name: "Branch Y", type: "RESTAURANT" })).id;
    whY = (
      await createWarehouse(owner, {
        branchId: branchY,
        code: "WH-Y",
        name: "Y store",
        type: "MAIN",
      })
    ).id;
  });

  it("a read-only analyst cannot create a warehouse (and nothing is written)", async () => {
    const { ctx } = await addMember(owner, "analyst");
    await expectAppError(
      createWarehouse(ctx, { branchId: branchX, code: "WH-NEW", name: "x", type: "MAIN" }),
      "FORBIDDEN",
    );
    await expectAppError(createBranch(ctx, { code: "NEW", name: "x", type: "OTHER" }), "FORBIDDEN");
    expect(
      await getDb().warehouse.count({
        where: { organizationId: owner.organizationId, code: "WH-NEW" },
      }),
    ).toBe(0);
    // ...but can view everything organization-wide.
    expect((await listBranches(ctx)).total).toBe(2);
  });

  it("a branch manager scoped to X manages X only", async () => {
    const { ctx } = await addMember(owner, "branch_manager", {
      scopeType: "BRANCH",
      branchId: branchX,
    });
    await updateBranch(ctx, branchX, { code: "X", name: "Branch X renamed", type: "RESTAURANT" });
    const created = await createWarehouse(ctx, {
      branchId: branchX,
      code: "WH-X",
      name: "X store",
      type: "MAIN",
    });
    expect(created.id).toBeTruthy();

    // Branch Y is invisible to them → NOT_FOUND; creating there → FORBIDDEN.
    await expectAppError(
      updateBranch(ctx, branchY, { code: "Y", name: "hijack", type: "RESTAURANT" }),
      "NOT_FOUND",
    );
    await expectAppError(
      updateWarehouse(ctx, whY, { code: "WH-Y", name: "hijack", type: "MAIN" }),
      "NOT_FOUND",
    );
    await expectAppError(
      createWarehouse(ctx, { branchId: branchY, code: "WH-Y2", name: "x", type: "MAIN" }),
      "FORBIDDEN",
    );
    await expectAppError(createBranch(ctx, { code: "Z", name: "x", type: "OTHER" }), "FORBIDDEN");

    const branches = await listBranches(ctx);
    expect(branches.items.map((b) => b.id)).toEqual([branchX]);
    const warehouses = await listWarehouses(ctx);
    expect(warehouses.items.map((w) => w.code)).toEqual(["WH-X"]);
    expect((await getDb().branch.findUniqueOrThrow({ where: { id: branchY } })).name).toBe(
      "Branch Y",
    );
  });

  it("a warehouse-scoped user sees only that warehouse", async () => {
    const { ctx } = await addMember(owner, "warehouse", {
      scopeType: "WAREHOUSE",
      warehouseId: whY,
    });
    expect((await listWarehouses(ctx)).items.map((w) => w.id)).toEqual([whY]);
    await expectAppError(
      updateWarehouse(ctx, whY, { code: "WH-Y", name: "x", type: "MAIN" }),
      "FORBIDDEN",
    );
  });

  it("members.manage and roles.manage are required for administration", async () => {
    const { ctx } = await addMember(owner, "operations_manager");
    await expectAppError(createRole(ctx, { name: "Custom", permissions: [] }), "FORBIDDEN");
    await expectAppError(
      grantRole(ctx, ctx.membershipId, { roleId: await roleIdOf(owner, "admin") }),
      "FORBIDDEN",
    );
    expect((await listMembers(ctx)).members.length).toBeGreaterThan(0); // has members.view
  });

  it("organization-only roles cannot be granted at branch scope", async () => {
    const { membership } = await addMember(owner, "analyst");
    await expectAppError(
      grantRole(owner, membership.id, {
        roleId: await roleIdOf(owner, "admin"),
        scopeType: "BRANCH",
        branchId: branchX,
      }),
      "BUSINESS_RULE_VIOLATION",
    );
  });
});

describe("roles", () => {
  it("custom roles grant exactly their permissions; owner role is immutable", async () => {
    const { ctx: owner } = await createTenant("roles");
    const role = await createRole(owner, {
      name: "Site viewer",
      permissions: ["branches.view", "branches.view"],
    });
    const { membership, user } = await addMember(owner, "analyst");
    await grantRole(owner, membership.id, { roleId: role.id });
    const ctx = await contextFor(user.id, owner.organizationSlug);
    expect(
      ctx.grants.filter((g) => g.roleKey.startsWith("custom_")).map((g) => g.permission),
    ).toEqual(["branches.view"]);

    await updateRole(owner, role.id, {
      name: "Site manager",
      permissions: ["branches.view", "branches.manage"],
    });
    const after = await contextFor(user.id, owner.organizationSlug);
    expect(after.grants.some((g) => g.permission === "branches.manage")).toBe(true);

    await expectAppError(
      updateRole(owner, await roleIdOf(owner, "owner"), { name: "x", permissions: [] }),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(
      createRole(owner, { name: "Bad", permissions: ["inventory.teleport"] }),
      "VALIDATION_FAILED",
    );
    const roles = await listRoles(owner);
    expect(roles.find((r) => r.key === "owner")?.editable).toBe(false);
  });
});

describe("AC1.5 last-owner protection", () => {
  it("cannot remove or demote the only owner", async () => {
    const { ctx: owner } = await createTenant("last-owner");
    const { ctx: admin } = await addMember(owner, "admin");
    const ownerGrant = await getDb().membershipRole.findFirstOrThrow({
      where: { membershipId: owner.membershipId },
    });
    // Admins cannot touch owners at all; owners cannot remove the last owner.
    await expectAppError(removeMember(admin, owner.membershipId), "FORBIDDEN");
    await expectAppError(revokeRole(admin, owner.membershipId, ownerGrant.id), "FORBIDDEN");
    await expectAppError(
      revokeRole(owner, owner.membershipId, ownerGrant.id),
      "BUSINESS_RULE_VIOLATION",
    );
    await expectAppError(removeMember(owner, owner.membershipId), "BUSINESS_RULE_VIOLATION");
  });

  it("only owners can grant the Owner role", async () => {
    const { ctx: owner } = await createTenant("grant-owner");
    const { ctx: admin, membership } = await addMember(owner, "admin");
    await expectAppError(
      grantRole(admin, membership.id, { roleId: await roleIdOf(owner, "owner") }),
      "FORBIDDEN",
    );
    await grantRole(owner, membership.id, { roleId: await roleIdOf(owner, "owner") });
  });

  it("two owners revoking each other's ownership concurrently leaves exactly one owner", async () => {
    for (let round = 0; round < 3; round++) {
      const { ctx: first } = await createTenant(`race-${round}`);
      const second = await addMember(first, "owner");
      const firstGrant = await getDb().membershipRole.findFirstOrThrow({
        where: { membershipId: first.membershipId },
      });
      const secondGrant = await getDb().membershipRole.findFirstOrThrow({
        where: { membershipId: second.membership.id },
      });

      const results = await Promise.allSettled([
        revokeRole(first, second.membership.id, secondGrant.id),
        revokeRole(second.ctx, first.membershipId, firstGrant.id),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason.code).toBe("BUSINESS_RULE_VIOLATION");
      const owners = await getDb().membershipRole.count({
        where: { organizationId: first.organizationId, role: { key: "owner" } },
      });
      expect(owners).toBe(1);
    }
  });
});
