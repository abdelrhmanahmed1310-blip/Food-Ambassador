/**
 * Modules and their functions, which an organization can switch on or off
 * (DECISIONS.md ADR-137). Pure data and rules: shared by the navigation, page
 * and action guards, the REST API, public pages and the Settings screen.
 *
 * - `paths` are route prefixes under /o/{org}/ (whole segments). The longest
 *   matching prefix decides which function a page belongs to; a page no
 *   function claims (the dashboard, notifications, search…) is always on.
 * - `core` functions cannot be switched off: the app needs them to work, and
 *   Settings → Modules must stay reachable to switch things back on.
 * - `requires` lists functions that must stay on while this one is on.
 */

export interface FeatureDef {
  key: string;
  paths: string[];
  /** REST API v1 resources (first path segment after /api/v1/). */
  api?: string[];
  core?: boolean;
  requires?: string[];
}

export interface ModuleDef {
  key: string;
  features: FeatureDef[];
  /** Functions every function of this module needs. */
  requires?: string[];
}

export const MODULES: ModuleDef[] = [
  {
    key: "general",
    features: [
      {
        key: "general.sites",
        paths: ["branches", "warehouses"],
        api: ["branches", "warehouses", "companies"],
        core: true,
      },
      { key: "general.attention", paths: ["attention"] },
      { key: "general.consultant", paths: ["consultant"] },
      { key: "general.approvals", paths: ["settings/approvals"] },
    ],
  },
  {
    key: "agents",
    features: [{ key: "agents.center", paths: ["agents"] }],
  },
  {
    key: "pos",
    requires: ["kitchen.menu"],
    features: [
      { key: "pos.till", paths: ["pos"], api: ["pos-orders"] },
      {
        key: "pos.floor",
        paths: ["pos/floor", "pos/floors", "pos/tables"],
        requires: ["pos.till"],
      },
      { key: "pos.simulator", paths: ["pos/simulator"] },
      { key: "pos.delivery", paths: ["pos/delivery"], requires: ["pos.till"] },
      { key: "pos.dispatch", paths: ["pos/dispatch", "pos/rider"], requires: ["pos.till"] },
      { key: "pos.online", paths: ["pos/online"], requires: ["pos.till"] },
      { key: "pos.kitchen", paths: ["pos/kitchen"], requires: ["pos.till"] },
      { key: "pos.promotions", paths: ["pos/promotions"] },
      { key: "pos.customers", paths: ["pos/customers"] },
      {
        key: "pos.crm",
        paths: ["pos/customers/segments", "pos/customers/feedback", "pos/customers/campaigns"],
        requires: ["pos.customers"],
      },
      { key: "pos.giftCards", paths: ["pos/gift-cards"] },
      { key: "pos.shortfalls", paths: ["pos/shortfalls"] },
      { key: "pos.settlements", paths: ["pos/settlements"] },
    ],
  },
  {
    key: "inventory",
    features: [
      {
        key: "inventory.stock",
        paths: [
          "inventory",
          "inventory/stock",
          "inventory/movements",
          "inventory/documents",
          "inventory/adjustments",
          "inventory/opening",
        ],
        api: ["stock"],
      },
      { key: "inventory.shipments", paths: ["inventory/shipments"], requires: ["inventory.stock"] },
      { key: "inventory.counts", paths: ["inventory/counts"], requires: ["inventory.stock"] },
      { key: "inventory.picking", paths: ["inventory/picking"], requires: ["inventory.stock"] },
      { key: "inventory.loads", paths: ["inventory/loads"], requires: ["inventory.picking"] },
      { key: "inventory.scanner", paths: ["scan"], requires: ["inventory.stock"] },
      {
        key: "inventory.inspections",
        paths: ["inventory/inspections"],
        requires: ["inventory.stock"],
      },
      { key: "inventory.valuation", paths: ["inventory/valuation"], requires: ["inventory.stock"] },
      { key: "inventory.fleet", paths: ["logistics"] },
    ],
  },
  {
    key: "purchasing",
    features: [
      { key: "purchasing.suppliers", paths: ["suppliers"], api: ["suppliers"] },
      {
        key: "purchasing.requisitions",
        paths: ["purchasing/requisitions"],
        requires: ["purchasing.orders"],
      },
      { key: "purchasing.rfqs", paths: ["purchasing/rfqs"], requires: ["purchasing.suppliers"] },
      {
        key: "purchasing.orders",
        paths: ["purchasing", "purchasing/orders", "purchasing/receipts", "settings/purchasing"],
        api: ["purchase-orders"],
        requires: ["purchasing.suppliers"],
      },
      { key: "purchasing.returns", paths: ["purchasing/returns"], requires: ["purchasing.orders"] },
      { key: "purchasing.reorder", paths: ["purchasing/reorder"], requires: ["purchasing.orders"] },
      { key: "purchasing.forecast", paths: ["purchasing/forecast"] },
      {
        key: "purchasing.payables",
        paths: ["purchasing/invoices", "purchasing/payables"],
        api: ["supplier-invoices"],
        requires: ["purchasing.suppliers"],
      },
      { key: "purchasing.trade", paths: ["trade"] },
      { key: "purchasing.exchangeRates", paths: ["purchasing/exchange-rates"] },
    ],
  },
  {
    key: "finance",
    features: [
      { key: "finance.expenses", paths: ["finance/expenses"] },
      { key: "finance.budgets", paths: ["finance/budgets"] },
      { key: "finance.pnl", paths: ["finance", "finance/pnl"] },
      { key: "finance.consolidated", paths: ["finance/consolidated"], requires: ["finance.pnl"] },
    ],
  },
  {
    key: "kitchen",
    features: [
      { key: "kitchen.recipes", paths: ["recipes"] },
      { key: "kitchen.menu", paths: ["menu"] },
      { key: "kitchen.sales", paths: ["sales"] },
      {
        key: "kitchen.foodCost",
        paths: ["recipes/food-cost", "recipes/simulator"],
        requires: ["kitchen.recipes"],
      },
      { key: "kitchen.replace", paths: ["recipes/replace"], requires: ["kitchen.recipes"] },
      { key: "kitchen.production", paths: ["production"], requires: ["kitchen.recipes"] },
      {
        key: "kitchen.allergens",
        paths: ["recipes/allergens", "recipes/labels"],
        requires: ["kitchen.recipes"],
      },
    ],
  },
  {
    key: "b2b",
    features: [
      { key: "b2b.customers", paths: ["b2b", "b2b/customers"] },
      { key: "b2b.orders", paths: ["b2b/orders"], requires: ["b2b.customers"] },
      {
        key: "b2b.invoices",
        paths: ["b2b/invoices"],
        api: ["sales-invoices"],
        requires: ["b2b.customers"],
      },
      { key: "b2b.balances", paths: ["b2b/balances"], requires: ["b2b.invoices"] },
    ],
  },
  {
    key: "hr",
    features: [
      {
        key: "hr.employees",
        paths: ["hr", "hr/employees", "hr/departments", "hr/org-chart", "my"],
      },
      {
        key: "hr.attendance",
        paths: ["hr/attendance", "my/attendance"],
        requires: ["hr.employees"],
      },
      { key: "hr.rosters", paths: ["hr/rosters", "my/roster"], requires: ["hr.employees"] },
      { key: "hr.leave", paths: ["hr/leave", "my/leave"], requires: ["hr.employees"] },
      {
        key: "hr.onboarding",
        paths: ["hr/onboarding", "my/onboarding"],
        requires: ["hr.employees"],
      },
      { key: "hr.workforce", paths: ["hr/workforce"], requires: ["hr.employees"] },
      {
        key: "hr.recruitment",
        paths: ["hr/recruitment", "my/interviews"],
        requires: ["hr.employees"],
      },
      {
        key: "hr.engagement",
        paths: ["hr/engagement", "my/surveys", "recognition"],
        requires: ["hr.employees"],
      },
      {
        key: "hr.performance",
        paths: ["hr/performance", "my/performance"],
        requires: ["hr.employees"],
      },
      { key: "hr.learning", paths: ["hr/learning", "my/training"], requires: ["hr.employees"] },
      { key: "hr.payroll", paths: ["hr/payroll", "my/payslips"], requires: ["hr.employees"] },
      { key: "hr.analytics", paths: ["hr/analytics"], requires: ["hr.employees"] },
    ],
  },
  {
    key: "safety",
    features: [
      { key: "safety.records", paths: ["food-safety", "food-safety/records", "food-safety/runs"] },
      { key: "safety.haccp", paths: ["food-safety/haccp"] },
      { key: "safety.documents", paths: ["food-safety/documents"] },
      { key: "safety.audits", paths: ["food-safety/audits", "food-safety/complaints"] },
      { key: "safety.equipment", paths: ["food-safety/equipment"] },
      { key: "safety.compliance", paths: ["food-safety/compliance"] },
      { key: "safety.checklists", paths: ["food-safety/checklists", "food-safety/checkpoints"] },
      { key: "safety.nonConformances", paths: ["food-safety/non-conformances"] },
      { key: "safety.traceability", paths: ["traceability", "recalls"] },
      {
        key: "safety.mockRecalls",
        paths: ["traceability/mock-recalls"],
        requires: ["safety.traceability"],
      },
    ],
  },
  {
    key: "reports",
    features: [
      { key: "reports.assistant", paths: ["assistant", "settings/assistant"] },
      { key: "reports.sales", paths: ["reports/sales"] },
      { key: "reports.kitchen", paths: ["reports/kitchen"], requires: ["pos.kitchen"] },
      {
        key: "reports.menuEngineering",
        paths: ["reports/menu-engineering"],
        requires: ["kitchen.recipes"],
      },
      { key: "reports.stock", paths: ["reports/stock"], requires: ["inventory.stock"] },
      { key: "reports.foodCost", paths: ["reports/food-cost"], requires: ["kitchen.recipes"] },
      { key: "reports.waste", paths: ["reports/waste"], requires: ["inventory.stock"] },
      {
        key: "reports.purchasing",
        paths: ["reports/spend", "reports/price-variance"],
        requires: ["purchasing.orders"],
      },
    ],
  },
  {
    key: "catalog",
    features: [
      {
        key: "catalog.products",
        paths: [
          "catalog",
          "catalog/products",
          "catalog/units",
          "catalog/categories",
          "catalog/import",
        ],
        api: ["products"],
        core: true,
      },
      { key: "catalog.nutrition", paths: ["nutrition", "catalog/library"], api: ["nutrition"] },
    ],
  },
  {
    key: "settings",
    features: [
      {
        key: "settings.organization",
        paths: [
          "settings",
          "settings/organization",
          "settings/companies",
          "settings/brands",
          "settings/members",
          "settings/roles",
          "settings/audit",
          "settings/jobs",
          "settings/tax",
          "settings/modules",
          "settings/usage",
        ],
        core: true,
      },
      { key: "settings.zatca", paths: ["settings/zatca"] },
      { key: "settings.payments", paths: ["settings/payments"] },
      { key: "settings.integrations", paths: ["settings/integrations"] },
      // Switching the API off refuses every /api/v1 request (resolved separately).
      { key: "settings.api", paths: ["settings/api"] },
    ],
  },
];

export const FEATURES: FeatureDef[] = MODULES.flatMap((m) => m.features);
const MODULE_OF = new Map(MODULES.flatMap((m) => m.features.map((f) => [f.key, m] as const)));
export const FEATURE_KEYS = new Set(FEATURES.map((f) => f.key));
export const MODULE_KEYS = new Set(MODULES.map((m) => m.key));

/** Stored entries: "module:<key>" switches a whole module off; "<feature key>" one function. */
export const moduleEntry = (key: string) => `module:${key}`;

export const moduleOf = (featureKey: string) => MODULE_OF.get(featureKey);

/** A module counts as switchable when at least one of its functions is not core. */
export const isSwitchableModule = (m: ModuleDef) => m.features.some((f) => !f.core);

/** Whether a function is on, given the stored disabled entries. Core functions are always on. */
export function isFeatureOn(featureKey: string, disabled: ReadonlySet<string>): boolean {
  const f = FEATURES.find((x) => x.key === featureKey);
  if (!f) return true;
  if (f.core) return true;
  const m = MODULE_OF.get(featureKey)!;
  return !disabled.has(featureKey) && !disabled.has(moduleEntry(m.key));
}

// Longest prefixes first, so "pos/kitchen" wins over "pos".
const BY_PATH = FEATURES.flatMap((f) => f.paths.map((p) => ({ prefix: p, key: f.key }))).sort(
  (a, b) => b.prefix.length - a.prefix.length,
);

/** The function a page under /o/{org}/ belongs to (rest = the path after the org slug), if any. */
export function featureForPath(rest: string): string | null {
  const path = rest.replace(/^\/+|\/+$/g, "");
  for (const { prefix, key } of BY_PATH)
    if (path === prefix || path.startsWith(`${prefix}/`)) return key;
  return null;
}

/** The function a REST API v1 resource belongs to, if any (the API switch is checked separately). */
export function featureForApi(resource: string): string | null {
  return FEATURES.find((f) => f.api?.includes(resource))?.key ?? null;
}

/**
 * Check a set of disabled entries before saving: unknown keys and core
 * functions are refused; a function that stays on must have what it needs on.
 * Problems are [function, required function] pairs.
 */
export function dependencyProblems(disabled: ReadonlySet<string>): Array<[string, string]> {
  const problems: Array<[string, string]> = [];
  for (const m of MODULES)
    for (const f of m.features) {
      if (!isFeatureOn(f.key, disabled)) continue;
      for (const r of [...(m.requires ?? []), ...(f.requires ?? [])])
        if (r !== f.key && !isFeatureOn(r, disabled)) problems.push([f.key, r]);
    }
  return problems;
}

/** Normalize stored entries: only known modules and switchable functions are kept. */
export function cleanEntries(entries: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.startsWith("module:")) {
      const m = MODULES.find((x) => moduleEntry(x.key) === e);
      if (m && isSwitchableModule(m)) out.add(e);
    } else if (FEATURE_KEYS.has(e) && !FEATURES.find((f) => f.key === e)!.core) out.add(e);
  }
  return [...out].sort();
}
