import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAuditEvents } from "@/modules/audit/service";
import {
  grantRole,
  listMembers,
  removeMember,
  revokeInvitation,
  createInvitation,
} from "@/modules/members/service";
import { getRole, updateRole } from "@/modules/access/roles";
import {
  createBranch,
  getBranch,
  listBranches,
  setBranchArchived,
  updateBranch,
} from "@/modules/sites/branches";
import {
  createLocation,
  createWarehouse,
  getWarehouse,
  listWarehouses,
  setLocationArchived,
  setWarehouseArchived,
  updateLocation,
  updateWarehouse,
} from "@/modules/sites/warehouses";
import { getDb } from "@/server/db/client";
import { withSystemTx, withTenantTx } from "@/server/db/transactions";
import {
  addMember,
  createTenant,
  createUser,
  expectAppError,
} from "../../../test/support/factories";
import { resolveTenantContext, type TenantContext } from "./context";

/**
 * AC1.3 — a member of organization A cannot read or modify organization B's
 * resources by ID, through any service, and RLS blocks unfiltered queries.
 */
let a: TenantContext;
let b: TenantContext;
let bOwnerId: string;
let bBranchId: string;
let bWarehouseId: string;
let bLocationId: string;
let bMembershipId: string;
let bInvitationId: string;
let bRoleId: string;

beforeAll(async () => {
  ({ ctx: a } = await createTenant("iso-a"));
  const tb = await createTenant("iso-b");
  b = tb.ctx;
  bOwnerId = tb.owner.id;
  bBranchId = (await createBranch(b, { code: "B-MAIN", name: "B main", type: "RESTAURANT" })).id;
  bWarehouseId = (
    await createWarehouse(b, { branchId: bBranchId, code: "B-WH", name: "B store", type: "MAIN" })
  ).id;
  bLocationId = (
    await createLocation(b, bWarehouseId, {
      code: "SHELF-1",
      name: "Shelf",
      temperatureZone: "AMBIENT",
    })
  ).id;
  bMembershipId = (await addMember(b, "analyst")).membership.id;
  bInvitationId = (
    await createInvitation(b, {
      email: "invitee-b@example.test",
      roleId: await roleId(b, "analyst"),
    })
  ).invitationId;
  bRoleId = await roleId(b, "warehouse");
  // Give A some data of its own with the same codes (codes are unique per org only).
  const aBranch = await createBranch(a, { code: "B-MAIN", name: "A main", type: "RESTAURANT" });
  await createWarehouse(a, { branchId: aBranch.id, code: "B-WH", name: "A store", type: "MAIN" });
});

afterAll(async () => {
  await getDb().$disconnect();
});

async function roleId(ctx: TenantContext, key: string) {
  const role = await getDb().role.findUniqueOrThrow({
    where: { organizationId_key: { organizationId: ctx.organizationId, key } },
  });
  return role.id;
}

describe("tenant context resolution", () => {
  it("returns null for users who are not members", async () => {
    const outsider = await createUser("outsider");
    expect(
      await withSystemTx((tx) => resolveTenantContext(tx, outsider.id, b.organizationSlug)),
    ).toBeNull();
  });

  it("returns null for another tenant's owner on this tenant's slug", async () => {
    expect(
      await withSystemTx((tx) => resolveTenantContext(tx, a.userId, b.organizationSlug)),
    ).toBeNull();
  });

  it("returns null for removed members, disabled users and suspended organizations", async () => {
    const t = await createTenant("iso-status");
    const member = await addMember(t.ctx, "analyst");
    await removeMember(t.ctx, member.membership.id);
    expect(
      await withSystemTx((tx) => resolveTenantContext(tx, member.user.id, t.org.slug)),
    ).toBeNull();

    const disabled = await addMember(t.ctx, "analyst");
    await getDb().user.update({ where: { id: disabled.user.id }, data: { status: "DISABLED" } });
    expect(
      await withSystemTx((tx) => resolveTenantContext(tx, disabled.user.id, t.org.slug)),
    ).toBeNull();

    await getDb().organization.update({ where: { id: t.org.id }, data: { status: "SUSPENDED" } });
    expect(await withSystemTx((tx) => resolveTenantContext(tx, t.owner.id, t.org.slug))).toBeNull();
  });
});

describe("cross-tenant access through services returns NOT_FOUND and changes nothing", () => {
  it("branches", async () => {
    await expectAppError(getBranch(a, bBranchId), "NOT_FOUND");
    await expectAppError(
      updateBranch(a, bBranchId, { code: "HACK", name: "x", type: "OTHER" }),
      "NOT_FOUND",
    );
    await expectAppError(setBranchArchived(a, bBranchId, true), "NOT_FOUND");
    const listed = await listBranches(a, { status: "all" });
    expect(listed.items.map((i) => i.id)).not.toContain(bBranchId);
    const stored = await getDb().branch.findUniqueOrThrow({ where: { id: bBranchId } });
    expect(stored).toMatchObject({ code: "B-MAIN", archivedAt: null });
  });

  it("warehouses and locations", async () => {
    await expectAppError(getWarehouse(a, bWarehouseId), "NOT_FOUND");
    await expectAppError(
      updateWarehouse(a, bWarehouseId, { code: "X", name: "x", type: "OTHER" }),
      "NOT_FOUND",
    );
    await expectAppError(setWarehouseArchived(a, bWarehouseId, true), "NOT_FOUND");
    await expectAppError(
      createWarehouse(a, { branchId: bBranchId, code: "SNEAK", name: "x", type: "MAIN" }),
      "NOT_FOUND",
    );
    await expectAppError(
      createLocation(a, bWarehouseId, { code: "SNEAK", name: "x", temperatureZone: "FROZEN" }),
      "NOT_FOUND",
    );
    await expectAppError(
      updateLocation(a, bLocationId, { code: "X", name: "x", temperatureZone: "FROZEN" }),
      "NOT_FOUND",
    );
    await expectAppError(setLocationArchived(a, bLocationId, true), "NOT_FOUND");
    const listed = await listWarehouses(a, { status: "all" });
    expect(listed.items.map((i) => i.id)).not.toContain(bWarehouseId);
    expect(await getDb().warehouse.count({ where: { code: "SNEAK" } })).toBe(0);
    expect(
      await getDb().storageLocation.findUniqueOrThrow({ where: { id: bLocationId } }),
    ).toMatchObject({ code: "SHELF-1", archivedAt: null });
  });

  it("memberships, invitations and roles", async () => {
    await expectAppError(
      grantRole(a, bMembershipId, { roleId: await roleId(a, "admin") }),
      "NOT_FOUND",
    );
    await expectAppError(
      grantRole(a, (await listMembers(a)).members[0].id, { roleId: bRoleId }),
      "NOT_FOUND",
    );
    await expectAppError(removeMember(a, bMembershipId), "NOT_FOUND");
    await expectAppError(revokeInvitation(a, bInvitationId), "NOT_FOUND");
    await expectAppError(getRole(a, bRoleId), "NOT_FOUND");
    await expectAppError(
      updateRole(a, bRoleId, { name: "pwned", permissions: ["members.manage"] }),
      "NOT_FOUND",
    );
    const members = await listMembers(a);
    expect(members.members.map((m) => m.id)).not.toContain(bMembershipId);
    expect(members.invitations.map((i) => i.id)).not.toContain(bInvitationId);
    expect(
      await getDb().organizationMembership.findUniqueOrThrow({ where: { id: bMembershipId } }),
    ).toMatchObject({ status: "ACTIVE" });
    expect(
      await getDb().invitation.findUniqueOrThrow({ where: { id: bInvitationId } }),
    ).toMatchObject({ status: "PENDING" });
  });

  it("audit events", async () => {
    const events = await listAuditEvents(a);
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.events.every((e) => e.organizationId === a.organizationId)).toBe(true);
  });

  it("does not grant B's owner anything in A", async () => {
    expect(
      await withSystemTx((tx) => resolveTenantContext(tx, bOwnerId, a.organizationSlug)),
    ).toBeNull();
  });
});

describe("row-level security (defence in depth)", () => {
  it("hides other tenants' rows from unfiltered queries", async () => {
    const rows = await withTenantTx(a.organizationId, (tx) =>
      tx.branch.findMany({ select: { organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === a.organizationId)).toBe(true);
    const orgs = await withTenantTx(a.organizationId, (tx) =>
      tx.organization.findMany({ select: { id: true } }),
    );
    expect(orgs).toEqual([{ id: a.organizationId }]);
  });

  it("rejects inserts into another tenant", async () => {
    await expect(
      withTenantTx(a.organizationId, (tx) =>
        tx.branch.create({
          data: {
            organizationId: b.organizationId,
            code: "RLS",
            name: "x",
            type: "OTHER",
            createdByUserId: a.userId,
            updatedByUserId: a.userId,
          },
        }),
      ),
    ).rejects.toThrow();
    expect(
      await getDb().branch.count({ where: { organizationId: b.organizationId, code: "RLS" } }),
    ).toBe(0);
  });

  it("silently matches zero rows when updating another tenant's data", async () => {
    const result = await withTenantTx(a.organizationId, (tx) =>
      tx.branch.updateMany({ where: { id: bBranchId }, data: { name: "pwned" } }),
    );
    expect(result.count).toBe(0);
    expect((await getDb().branch.findUniqueOrThrow({ where: { id: bBranchId } })).name).toBe(
      "B main",
    );
  });

  it("prevents moving a row into another tenant", async () => {
    const aBranch = await withTenantTx(a.organizationId, (tx) =>
      tx.branch.findFirstOrThrow({ select: { id: true } }),
    );
    await expect(
      withTenantTx(a.organizationId, (tx) =>
        tx.branch.update({ where: { id: aBranch.id }, data: { organizationId: b.organizationId } }),
      ),
    ).rejects.toThrow();
  });

  it("denies tenant transactions access to credentials and sessions", async () => {
    await expect(withTenantTx(a.organizationId, (tx) => tx.account.findMany())).rejects.toThrow(
      /permission denied/i,
    );
    await expect(withTenantTx(a.organizationId, (tx) => tx.session.findMany())).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("denies everything when no organization is set", async () => {
    const rows = await getDb().$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE fa_tenant");
      return tx.branch.findMany();
    });
    expect(rows).toEqual([]);
  });

  it("is enabled, with a policy, on every table that has an organization_id column", async () => {
    const rows = await getDb().$queryRaw<
      Array<{ table_name: string; rls: boolean; policies: bigint }>
    >`
      SELECT c.table_name, t.relrowsecurity AS rls,
             (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.table_name) AS policies
      FROM information_schema.columns c
      JOIN pg_class t ON t.relname = c.table_name AND t.relkind = 'r'
      WHERE c.table_schema = 'public' AND c.column_name = 'organization_id'`;
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      expect(row.rls, row.table_name).toBe(true);
      expect(Number(row.policies), row.table_name).toBeGreaterThan(0);
    }
    const orgs = await getDb().$queryRaw<
      Array<{ rls: boolean }>
    >`SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'organizations'`;
    expect(orgs[0].rls).toBe(true);
  });
});

describe("composite tenant foreign keys", () => {
  it("reject cross-tenant references even when RLS is bypassed", async () => {
    // System transaction = owner privileges, no RLS: only the composite FK protects us here.
    await expect(
      withSystemTx((tx) =>
        tx.warehouse.create({
          data: {
            organizationId: a.organizationId,
            branchId: bBranchId,
            code: "FK",
            name: "x",
            type: "MAIN",
            createdByUserId: a.userId,
            updatedByUserId: a.userId,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withSystemTx((tx) =>
        tx.membershipRole.create({
          data: { organizationId: a.organizationId, membershipId: a.membershipId, roleId: bRoleId },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});
