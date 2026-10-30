/**
 * Permission catalogue. Permissions are defined here, in code, so a check can
 * never reference a permission that does not exist; role_permissions rows are
 * validated against this list before being stored. Later milestones add
 * permissions here and grant them to system roles with a data migration.
 */
export const PERMISSIONS = [
  "org.settings.manage",
  "members.view",
  "members.manage",
  "roles.manage",
  "branches.view",
  "branches.manage",
  "warehouses.view",
  "warehouses.manage",
  "audit.view",
  "catalog.view",
  "catalog.manage",
  "inventory.view",
  "inventory.adjust",
  "inventory.transfer",
  "inventory.count",
  "inventory.count.approve",
  "inventory.quarantine",
  "inventory.quarantine.release",
  "inventory.reverse",
  "inventory.valuation.view",
  "inventory.valuation.revalue",
  "suppliers.view",
  "suppliers.manage",
  "purchasing.view",
  "purchasing.manage",
  "purchasing.approve",
  "purchasing.receive",
  "purchasing.request",
  "recipes.view",
  "recipes.manage",
  "recipes.costs.view",
  "traceability.view",
  "recalls.manage",
  "foodsafety.view",
  "foodsafety.record",
  "foodsafety.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Permissions that may be granted at branch or warehouse scope. All others are organization-wide only. */
export const SCOPABLE_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "branches.view",
  "branches.manage",
  "warehouses.view",
  "warehouses.manage",
  "inventory.view",
  "inventory.adjust",
  "inventory.transfer",
  "inventory.count",
  "inventory.count.approve",
  "inventory.quarantine",
  "inventory.quarantine.release",
  "inventory.reverse",
  "inventory.valuation.view",
  "inventory.valuation.revalue",
  "purchasing.view",
  "purchasing.manage",
  "purchasing.approve",
  "purchasing.receive",
  "purchasing.request",
  "foodsafety.view",
  "foodsafety.record",
  "foodsafety.manage",
]);

/**
 * Read access to organization-wide master data. Scoped staff (a branch
 * manager, a warehouse clerk) must see the product catalogue and supplier
 * list to work in their own sites, so these apply organization-wide even
 * when granted through a branch- or warehouse-scoped role (ADR-027).
 */
export const ORGANIZATION_READ_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "catalog.view",
  "suppliers.view",
  "recipes.view",
]);

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export const OWNER_ROLE_KEY = "owner";

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  permissions: readonly Permission[];
  /** Organization-only roles cannot be granted at branch/warehouse scope. */
  organizationScopeOnly: boolean;
}

const VIEW_SITES: Permission[] = ["branches.view", "warehouses.view"];
const VIEW_STOCK: Permission[] = ["catalog.view", "inventory.view"];
const ALL_INVENTORY: Permission[] = [
  "catalog.view",
  "catalog.manage",
  "inventory.view",
  "inventory.adjust",
  "inventory.transfer",
  "inventory.count",
  "inventory.count.approve",
  "inventory.quarantine",
  "inventory.quarantine.release",
  "inventory.reverse",
];

/**
 * System roles created for every organization (DECISIONS.md A-10). Their
 * permission sets can be customized per organization, except Owner, which
 * always holds every permission.
 */
export const SYSTEM_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: OWNER_ROLE_KEY,
    name: "Organization Owner",
    description: "Full control, including ownership transfer.",
    permissions: PERMISSIONS,
    organizationScopeOnly: true,
  },
  {
    key: "admin",
    name: "Administrator",
    description: "Manages settings, members, roles and sites.",
    permissions: PERMISSIONS,
    organizationScopeOnly: true,
  },
  {
    key: "operations_manager",
    name: "Operations Manager",
    description: "Oversees branches and warehouses.",
    permissions: [
      ...VIEW_SITES,
      "warehouses.manage",
      "members.view",
      "audit.view",
      ...ALL_INVENTORY,
      "inventory.valuation.view",
      "inventory.valuation.revalue",
      "suppliers.view",
      "purchasing.view",
      "purchasing.approve",
      "purchasing.receive",
      "purchasing.request",
      "recipes.view",
      "recipes.manage",
      "recipes.costs.view",
      "traceability.view",
      "recalls.manage",
      "foodsafety.view",
      "foodsafety.record",
      "foodsafety.manage",
    ],
    organizationScopeOnly: false,
  },
  {
    key: "procurement",
    name: "Procurement",
    description: "Purchasing and supplier management.",
    permissions: [
      ...VIEW_SITES,
      ...VIEW_STOCK,
      "catalog.manage",
      "inventory.valuation.view",
      "suppliers.view",
      "suppliers.manage",
      "purchasing.view",
      "purchasing.manage",
      "purchasing.receive",
      "purchasing.request",
      "recipes.view",
      "recipes.costs.view",
      "traceability.view",
    ],
    organizationScopeOnly: false,
  },
  {
    key: "warehouse",
    name: "Warehouse",
    description: "Receiving, storage and stock movements.",
    permissions: [
      ...VIEW_SITES,
      ...VIEW_STOCK,
      "inventory.transfer",
      "inventory.count",
      "inventory.quarantine",
      "suppliers.view",
      "purchasing.view",
      "purchasing.receive",
      "purchasing.request",
      "recipes.view",
      "traceability.view",
      "foodsafety.view",
      "foodsafety.record",
    ],
    organizationScopeOnly: false,
  },
  {
    key: "food_safety",
    name: "Food Safety / Quality",
    description: "Quality control, food safety records and traceability.",
    permissions: [
      ...VIEW_SITES,
      ...VIEW_STOCK,
      "inventory.quarantine",
      "inventory.quarantine.release",
      "suppliers.view",
      "purchasing.view",
      "recipes.view",
      "traceability.view",
      "recalls.manage",
      "foodsafety.view",
      "foodsafety.record",
      "foodsafety.manage",
    ],
    organizationScopeOnly: false,
  },
  {
    key: "finance",
    name: "Finance",
    description: "Invoices, settlements and cost reporting.",
    permissions: [
      ...VIEW_SITES,
      "audit.view",
      ...VIEW_STOCK,
      "inventory.valuation.view",
      "inventory.valuation.revalue",
      "suppliers.view",
      "purchasing.view",
      "purchasing.approve",
      "recipes.view",
      "recipes.costs.view",
    ],
    organizationScopeOnly: false,
  },
  {
    key: "branch_manager",
    name: "Branch Manager",
    description: "Manages a branch and its warehouses (usually granted at branch scope).",
    permissions: [
      ...VIEW_SITES,
      "branches.manage",
      "warehouses.manage",
      "members.view",
      ...VIEW_STOCK,
      "inventory.adjust",
      "inventory.transfer",
      "inventory.count",
      "inventory.count.approve",
      "inventory.quarantine",
      "inventory.reverse",
      "inventory.valuation.view",
      "suppliers.view",
      "purchasing.view",
      "purchasing.manage",
      "purchasing.receive",
      "purchasing.request",
      "recipes.view",
      "traceability.view",
      "foodsafety.view",
      "foodsafety.record",
      "foodsafety.manage",
    ],
    organizationScopeOnly: false,
  },
  {
    key: "analyst",
    name: "Read-only Analyst",
    description: "Read-only access to operational data.",
    permissions: [
      ...VIEW_SITES,
      ...VIEW_STOCK,
      "inventory.valuation.view",
      "suppliers.view",
      "purchasing.view",
      "recipes.view",
      "recipes.costs.view",
      "traceability.view",
      "foodsafety.view",
    ],
    organizationScopeOnly: false,
  },
];

const TEMPLATE_BY_KEY = new Map(SYSTEM_ROLE_TEMPLATES.map((t) => [t.key, t]));

export function isOrganizationScopeOnlyRole(roleKey: string): boolean {
  return TEMPLATE_BY_KEY.get(roleKey)?.organizationScopeOnly ?? false;
}
