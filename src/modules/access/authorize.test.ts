import { describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import {
  accessibleScope,
  assertPermission,
  buildGrants,
  hasPermission,
  isOwner,
} from "./authorize";
import { PERMISSIONS, SYSTEM_ROLE_TEMPLATES, isPermission } from "./permissions";

const B1 = "0190f0c0-0000-7000-8000-000000000001";
const B2 = "0190f0c0-0000-7000-8000-000000000002";
const W1 = "0190f0c0-0000-7000-8000-0000000000a1";
const W2 = "0190f0c0-0000-7000-8000-0000000000a2";

describe("buildGrants", () => {
  it("gives the owner every permission at organization scope, regardless of stored rows", () => {
    const grants = buildGrants([
      { roleKey: "owner", permissions: [], scope: { type: "ORGANIZATION" } },
    ]);
    expect(grants).toHaveLength(PERMISSIONS.length);
    expect(isOwner(grants)).toBe(true);
    for (const p of PERMISSIONS) expect(hasPermission(grants, p)).toBe(true);
  });

  it("ignores unknown permission codes", () => {
    const grants = buildGrants([
      {
        roleKey: "custom",
        permissions: ["branches.view", "inventory.teleport"],
        scope: { type: "ORGANIZATION" },
      },
    ]);
    expect(grants.map((g) => g.permission)).toEqual(["branches.view"]);
  });
});

describe("hasPermission scope coverage", () => {
  const branchManager = buildGrants([
    {
      roleKey: "branch_manager",
      permissions: ["branches.manage", "warehouses.manage"],
      scope: { type: "BRANCH", branchId: B1 },
    },
  ]);
  const warehouseClerk = buildGrants([
    {
      roleKey: "warehouse",
      permissions: ["warehouses.view"],
      scope: { type: "WAREHOUSE", warehouseId: W1 },
    },
  ]);

  it("organization scope covers any target and organization-wide actions", () => {
    const admin = buildGrants([
      { roleKey: "admin", permissions: ["branches.manage"], scope: { type: "ORGANIZATION" } },
    ]);
    expect(hasPermission(admin, "branches.manage")).toBe(true);
    expect(hasPermission(admin, "branches.manage", { branchId: B2 })).toBe(true);
  });

  it("branch scope covers that branch and its warehouses only", () => {
    expect(hasPermission(branchManager, "branches.manage", { branchId: B1 })).toBe(true);
    expect(
      hasPermission(branchManager, "warehouses.manage", { branchId: B1, warehouseId: W1 }),
    ).toBe(true);
    expect(hasPermission(branchManager, "branches.manage", { branchId: B2 })).toBe(false);
    expect(
      hasPermission(branchManager, "warehouses.manage", { branchId: B2, warehouseId: W2 }),
    ).toBe(false);
  });

  it("scoped grants never satisfy organization-wide actions", () => {
    expect(hasPermission(branchManager, "branches.manage")).toBe(false);
  });

  it("applies master-data read access organization-wide even from a scoped role", () => {
    const clerk = buildGrants([
      {
        roleKey: "warehouse",
        permissions: ["catalog.view", "suppliers.view", "catalog.manage", "inventory.view"],
        scope: { type: "WAREHOUSE", warehouseId: W1 },
      },
    ]);
    expect(hasPermission(clerk, "catalog.view")).toBe(true);
    expect(hasPermission(clerk, "suppliers.view")).toBe(true);
    // Managing master data and seeing other warehouses' stock stay out of reach.
    expect(hasPermission(clerk, "catalog.manage")).toBe(false);
    expect(hasPermission(clerk, "inventory.view", { branchId: B2, warehouseId: W2 })).toBe(false);
  });

  it("warehouse scope covers only that warehouse, not its branch", () => {
    expect(
      hasPermission(warehouseClerk, "warehouses.view", { branchId: B1, warehouseId: W1 }),
    ).toBe(true);
    expect(
      hasPermission(warehouseClerk, "warehouses.view", { branchId: B1, warehouseId: W2 }),
    ).toBe(false);
    expect(hasPermission(warehouseClerk, "warehouses.view", { branchId: B1 })).toBe(false);
  });

  it("does not grant permissions the role lacks", () => {
    expect(hasPermission(warehouseClerk, "warehouses.manage", { warehouseId: W1 })).toBe(false);
  });

  it("assertPermission throws FORBIDDEN", () => {
    expect(() => assertPermission(warehouseClerk, "members.manage")).toThrow(AppError);
    try {
      assertPermission(warehouseClerk, "members.manage");
    } catch (e) {
      expect((e as AppError).code).toBe("FORBIDDEN");
    }
  });
});

describe("accessibleScope", () => {
  it("returns all for organization grants", () => {
    const g = buildGrants([
      { roleKey: "analyst", permissions: ["branches.view"], scope: { type: "ORGANIZATION" } },
    ]);
    expect(accessibleScope(g, "branches.view")).toEqual({ all: true });
  });

  it("collects scoped branches and warehouses", () => {
    const g = buildGrants([
      {
        roleKey: "branch_manager",
        permissions: ["warehouses.view"],
        scope: { type: "BRANCH", branchId: B1 },
      },
      {
        roleKey: "warehouse",
        permissions: ["warehouses.view"],
        scope: { type: "WAREHOUSE", warehouseId: W2 },
      },
    ]);
    expect(accessibleScope(g, "warehouses.view")).toEqual({
      all: false,
      branchIds: [B1],
      warehouseIds: [W2],
    });
    expect(accessibleScope(g, "branches.view")).toEqual({
      all: false,
      branchIds: [],
      warehouseIds: [],
    });
  });
});

describe("system role templates", () => {
  it("only reference catalogued permissions", () => {
    for (const t of SYSTEM_ROLE_TEMPLATES)
      for (const p of t.permissions) expect(isPermission(p), `${t.key}:${p}`).toBe(true);
  });

  it("has unique keys including the suggested roles", () => {
    const keys = SYSTEM_ROLE_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        "owner",
        "admin",
        "operations_manager",
        "procurement",
        "warehouse",
        "food_safety",
        "finance",
        "branch_manager",
        "analyst",
      ]),
    );
  });

  it("keeps the read-only analyst read-only", () => {
    const analyst = SYSTEM_ROLE_TEMPLATES.find((t) => t.key === "analyst")!;
    expect(analyst.permissions.every((p) => p.endsWith(".view"))).toBe(true);
  });
});
