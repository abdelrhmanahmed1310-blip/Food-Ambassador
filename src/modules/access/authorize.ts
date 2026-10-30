import { forbidden } from "@/server/errors";
import {
  ORGANIZATION_READ_PERMISSIONS,
  OWNER_ROLE_KEY,
  PERMISSIONS,
  type Permission,
} from "./permissions";

export type GrantScope =
  | { type: "ORGANIZATION" }
  | { type: "BRANCH"; branchId: string }
  | { type: "WAREHOUSE"; warehouseId: string };

/** One permission held through one role assignment at one scope. */
export interface Grant {
  permission: Permission;
  scope: GrantScope;
  roleKey: string;
}

/** The resource an action targets. A warehouse target carries its branch too. */
export interface ResourceTarget {
  branchId?: string;
  warehouseId?: string;
}

export interface RoleAssignment {
  roleKey: string;
  permissions: readonly string[];
  scope: GrantScope;
}

/** Expand role assignments into grants. Owner always holds every permission organization-wide. */
export function buildGrants(assignments: readonly RoleAssignment[]): Grant[] {
  const grants: Grant[] = [];
  for (const a of assignments) {
    if (a.roleKey === OWNER_ROLE_KEY) {
      for (const permission of PERMISSIONS)
        grants.push({ permission, scope: { type: "ORGANIZATION" }, roleKey: a.roleKey });
      continue;
    }
    for (const p of a.permissions) {
      if (!(PERMISSIONS as readonly string[]).includes(p)) continue;
      const permission = p as Permission;
      // Master-data read access is organization-wide whatever the role's scope (ADR-027).
      const scope = ORGANIZATION_READ_PERMISSIONS.has(permission)
        ? ({ type: "ORGANIZATION" } as const)
        : a.scope;
      grants.push({ permission, scope, roleKey: a.roleKey });
    }
  }
  return grants;
}

function covers(scope: GrantScope, target: ResourceTarget | undefined): boolean {
  switch (scope.type) {
    case "ORGANIZATION":
      return true;
    case "BRANCH":
      return target?.branchId !== undefined && target.branchId === scope.branchId;
    case "WAREHOUSE":
      return target?.warehouseId !== undefined && target.warehouseId === scope.warehouseId;
  }
}

/**
 * True if some grant gives `permission` over `target`. Without a target the
 * action is organization-wide and only organization-scope grants count.
 */
export function hasPermission(
  grants: readonly Grant[],
  permission: Permission,
  target?: ResourceTarget,
): boolean {
  return grants.some((g) => g.permission === permission && covers(g.scope, target));
}

export function assertPermission(
  grants: readonly Grant[],
  permission: Permission,
  target?: ResourceTarget,
): void {
  if (!hasPermission(grants, permission, target)) throw forbidden();
}

/** Which branches/warehouses a permission reaches, for filtering list queries. */
export type AccessibleScope =
  { all: true } | { all: false; branchIds: string[]; warehouseIds: string[] };

export function accessibleScope(grants: readonly Grant[], permission: Permission): AccessibleScope {
  const branchIds = new Set<string>();
  const warehouseIds = new Set<string>();
  for (const g of grants) {
    if (g.permission !== permission) continue;
    if (g.scope.type === "ORGANIZATION") return { all: true };
    if (g.scope.type === "BRANCH") branchIds.add(g.scope.branchId);
    else warehouseIds.add(g.scope.warehouseId);
  }
  return { all: false, branchIds: [...branchIds], warehouseIds: [...warehouseIds] };
}

export function holdsAnyGrant(grants: readonly Grant[], permission: Permission): boolean {
  return grants.some((g) => g.permission === permission);
}

export function isOwner(grants: readonly Grant[]): boolean {
  return grants.some((g) => g.roleKey === OWNER_ROLE_KEY);
}
