import type { Permission } from "@/modules/access/permissions";

/**
 * REST API v1 scopes (DECISIONS.md ADR-090, ADR-132). Each scope maps to the
 * permissions of the pages that show or change the same data. Only
 * nutrition:write allows changes (importing and maintaining library foods).
 */
export const API_SCOPES = {
  "sites:read": ["branches.view", "warehouses.view"],
  "products:read": ["catalog.view"],
  "suppliers:read": ["suppliers.view"],
  "stock:read": ["inventory.view"],
  "purchasing:read": ["purchasing.view"],
  "invoices:read": ["invoices.view"],
  "sales:read": ["b2b.view", "pos.view"],
  "nutrition:read": ["nutrition.view"],
  "nutrition:write": ["nutrition.view", "nutrition.manage"],
} as const satisfies Record<string, readonly Permission[]>;

export type ApiScope = keyof typeof API_SCOPES;
export const API_SCOPE_NAMES = Object.keys(API_SCOPES) as ApiScope[];

/** The permissions a key's scopes grant (organization-wide; a company limit filters the data). */
export function permissionsOf(scopes: readonly string[]): Permission[] {
  return [
    ...new Set(scopes.flatMap((s) => (s in API_SCOPES ? [...API_SCOPES[s as ApiScope]] : []))),
  ];
}

/** Key format: fa_<prefix>_<secret>. Returns null when it does not look like one. */
export function parseApiKey(header: string | null): { prefix: string; secret: string } | null {
  const m = /^Bearer (fa_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{32,64}))$/.exec(header?.trim() ?? "");
  return m ? { prefix: m[2], secret: m[3] } : null;
}

/** Page size: 1–200, default 50. */
export function pageLimit(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 200) : 50;
}
