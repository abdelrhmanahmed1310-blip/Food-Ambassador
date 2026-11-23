import type { NavIcon, NavItem, NavSection } from "./nav-links";

/**
 * The menu grouped by end-to-end process (DECISIONS.md ADR-139). Each group
 * is one menu link; the pages of a group show as tabs at the top of the page.
 * Pure data and rules, shared by the server layout and the client tabs. Pages
 * keep their addresses; permissions and module switches decide, as before,
 * which links a person has — a group appears when it holds at least one.
 *
 * `paths` are page links under /o/{org}/ ("" is the overview). Every link the
 * app offers must belong to exactly one group (a unit test checks).
 */

export interface NavGroupDef {
  key: string;
  icon?: NavIcon;
  paths: string[];
  /** A hub page lists the group's links in cards instead of tabs (Settings). */
  hub?: string;
  /** The pages draw their own tabs (the nutrition engine); none added. */
  ownTabs?: boolean;
}

export interface NavSectionDef {
  /** No key: the top block without a heading. */
  key?: string;
  icon?: NavIcon;
  groups: NavGroupDef[];
}

export const NAV_SECTIONS: NavSectionDef[] = [
  {
    groups: [
      { key: "overview", icon: "overview", paths: [""] },
      { key: "attention", icon: "attention", paths: ["attention"] },
      {
        key: "myWork",
        icon: "clock",
        paths: [
          "my/attendance",
          "my/roster",
          "my/leave",
          "my/payslips",
          "my/training",
          "my/performance",
          "my/surveys",
          "recognition",
          "my/onboarding",
          "my/interviews",
          "pos/rider",
        ],
      },
      // Agents (ADR-140): what they propose, their runs, their settings.
      { key: "agents", icon: "agents", paths: ["agents/inbox", "agents/runs", "agents"] },
      // Kept in view for every member (ADR-131).
      { key: "consultant", icon: "consultant", paths: ["consultant"] },
    ],
  },
  {
    key: "sell",
    icon: "pos",
    groups: [
      {
        key: "pointOfSale",
        paths: ["pos", "pos/floor", "pos/kitchen", "pos/simulator", "pos/shortfalls"],
      },
      { key: "onlineDelivery", paths: ["pos/online", "pos/delivery", "pos/dispatch"] },
      {
        key: "customersMarketing",
        paths: [
          "pos/customers",
          "pos/promotions",
          "pos/gift-cards",
          "pos/customers/segments",
          "pos/customers/feedback",
          "pos/customers/campaigns",
        ],
      },
    ],
  },
  {
    key: "kitchen",
    icon: "kitchen",
    groups: [
      { key: "menu", paths: ["menu"] },
      {
        key: "recipes",
        paths: [
          "recipes",
          "recipes/food-cost",
          "recipes/simulator",
          "recipes/replace",
          "recipes/allergens",
        ],
      },
      { key: "production", paths: ["production"] },
    ],
  },
  {
    key: "procureToPay",
    icon: "purchasing",
    groups: [
      { key: "suppliers", paths: ["suppliers"] },
      {
        key: "buying",
        paths: [
          "purchasing/requisitions",
          "purchasing/rfqs",
          "purchasing/orders",
          "purchasing/reorder",
          "purchasing/forecast",
        ],
      },
      {
        key: "receiving",
        paths: ["purchasing/receipts", "inventory/inspections", "purchasing/returns"],
      },
      { key: "payables", paths: ["purchasing/invoices", "purchasing/payables"] },
      { key: "imports", paths: ["trade/shipments", "trade/documents"] },
    ],
  },
  {
    key: "stock",
    icon: "inventory",
    groups: [
      {
        key: "stockLevels",
        paths: [
          "inventory",
          "inventory/stock",
          "inventory/movements",
          "inventory/documents",
          "inventory/valuation",
        ],
      },
      { key: "transfersCounts", paths: ["inventory/shipments", "inventory/counts"] },
      { key: "warehouseWork", paths: ["inventory/picking", "inventory/loads", "scan"] },
      { key: "fleet", paths: ["logistics/trips", "logistics/vehicles"] },
    ],
  },
  {
    key: "b2b",
    icon: "b2b",
    groups: [
      { key: "b2bOrders", paths: ["b2b/orders"] },
      { key: "b2bInvoices", paths: ["b2b/invoices", "b2b/balances"] },
      { key: "b2bCustomers", paths: ["b2b/customers"] },
    ],
  },
  {
    key: "finance",
    icon: "finance",
    groups: [
      { key: "expensesBudgets", paths: ["finance/expenses", "finance/budgets"] },
      { key: "profitLoss", paths: ["finance/pnl", "finance/consolidated"] },
      {
        key: "taxSettlements",
        paths: ["sales", "sales/vat", "pos/settlements", "purchasing/exchange-rates"],
      },
    ],
  },
  {
    key: "safety",
    icon: "safety",
    groups: [
      { key: "safetyOverview", paths: ["food-safety", "food-safety/compliance"] },
      {
        key: "dailyRecords",
        paths: ["food-safety/records", "food-safety/checklists", "food-safety/checkpoints"],
      },
      {
        key: "plansDocuments",
        paths: ["food-safety/haccp", "food-safety/documents", "food-safety/equipment"],
      },
      {
        key: "safetyIssues",
        paths: ["food-safety/non-conformances", "food-safety/audits", "food-safety/complaints"],
      },
      { key: "traceability", paths: ["traceability", "recalls", "traceability/mock-recalls"] },
    ],
  },
  {
    key: "people",
    icon: "hr",
    groups: [
      { key: "employees", paths: ["hr", "hr/employees", "hr/departments", "hr/org-chart"] },
      { key: "time", paths: ["hr/attendance", "hr/rosters", "hr/leave"] },
      { key: "hiring", paths: ["hr/workforce", "hr/recruitment", "hr/onboarding"] },
      { key: "growth", paths: ["hr/performance", "hr/learning", "hr/engagement"] },
      { key: "payroll", paths: ["hr/payroll"] },
      { key: "hrAnalytics", paths: ["hr/analytics"] },
    ],
  },
  {
    key: "insights",
    icon: "reports",
    groups: [
      {
        key: "reports",
        paths: [
          "reports/sales",
          "reports/kitchen",
          "reports/menu-engineering",
          "reports/stock",
          "reports/food-cost",
          "reports/waste",
          "reports/spend",
          "reports/price-variance",
        ],
      },
      { key: "assistant", paths: ["assistant"] },
    ],
  },
  {
    key: "catalog",
    icon: "catalog",
    groups: [
      {
        key: "products",
        paths: ["catalog/products", "catalog/categories", "catalog/units", "catalog/import"],
      },
      {
        key: "nutrition",
        paths: ["nutrition", "nutrition/foods", "nutrition/match", "catalog/library"],
        ownTabs: true,
      },
    ],
  },
  {
    key: "settingsSection",
    icon: "settings",
    groups: [
      {
        key: "settings",
        icon: "settings",
        hub: "settings",
        paths: [
          "settings/organization",
          "settings/modules",
          "settings/companies",
          "settings/brands",
          "branches",
          "warehouses",
          "settings/members",
          "settings/roles",
          "settings/audit",
          "settings/tax",
          "settings/zatca",
          "settings/payments",
          "settings/purchasing",
          "settings/approvals",
          "settings/integrations",
          "settings/api",
          "settings/assistant",
          "settings/jobs",
        ],
      },
    ],
  },
];

/** Cards on the Settings page (ADR-139): the settings group's links, by subject. */
export const SETTINGS_CARDS: Array<{ key: string; paths: string[] }> = [
  {
    key: "organization",
    paths: [
      "settings/organization",
      "settings/modules",
      "settings/companies",
      "settings/brands",
      "branches",
      "warehouses",
    ],
  },
  { key: "access", paths: ["settings/members", "settings/roles", "settings/audit"] },
  {
    key: "salesTax",
    paths: [
      "settings/tax",
      "settings/zatca",
      "settings/payments",
      "settings/purchasing",
      "settings/approvals",
    ],
  },
  {
    key: "connections",
    paths: ["settings/integrations", "settings/api", "settings/assistant", "settings/jobs"],
  },
];

export interface TabLink {
  href: string;
  label: string;
  exact?: boolean;
}
export interface TabGroup {
  key: string;
  label: string;
  /** Address of the hub page, for groups shown as a hub. */
  hub?: string;
  ownTabs?: boolean;
  links: TabLink[];
}

const relative = (href: string, base: string) =>
  href === base ? "" : href.startsWith(`${base}/`) ? href.slice(base.length + 1) : href;

/**
 * Group a person's links into menu sections and page tabs. Each group links to
 * its first available page (or its hub) and counts every page of the group as
 * its own, so the menu marks it on any of them.
 */
export function groupNav(
  links: readonly NavItem[],
  base: string,
  label: (key: string) => string,
): { sections: NavSection[]; tabs: TabGroup[]; ungrouped: NavItem[] } {
  const byPath = new Map(links.map((l) => [relative(l.href, base), l]));
  const used = new Set<string>();
  const sections: NavSection[] = [];
  const tabs: TabGroup[] = [];
  for (const s of NAV_SECTIONS) {
    const items: NavItem[] = [];
    for (const g of s.groups) {
      const own = g.paths.flatMap((p) => (byPath.has(p) ? [byPath.get(p)!] : []));
      if (own.length === 0) continue;
      own.forEach((l) => used.add(l.href));
      const hubHref = g.hub ? `${base}/${g.hub}` : null;
      items.push({
        href: hubHref ?? own[0].href,
        label: label(g.key),
        icon: g.icon,
        exact: own[0].exact && own.length === 1 && !hubHref,
        match: [...(hubHref ? [hubHref] : []), ...own.map((l) => l.href)],
        matchExact: own.filter((l) => l.exact).map((l) => l.href),
      });
      tabs.push({
        key: g.key,
        label: label(g.key),
        hub: hubHref ?? undefined,
        ownTabs: g.ownTabs,
        links: own.map((l) => ({ href: l.href, label: l.label, exact: l.exact })),
      });
    }
    if (items.length > 0)
      sections.push({ title: s.key ? label(s.key) : undefined, icon: s.icon, items });
  }
  return { sections, tabs, ungrouped: links.filter((l) => !used.has(l.href)) };
}

/** The group and tab for a page: the longest link address that holds it. */
export function activeTab(pathname: string, groups: readonly TabGroup[]) {
  let best: { group: TabGroup; link: TabLink } | null = null;
  for (const group of groups)
    for (const link of group.links) {
      const hit = link.exact
        ? pathname === link.href
        : pathname === link.href || pathname.startsWith(`${link.href}/`);
      if (hit && (!best || link.href.length > best.link.href.length)) best = { group, link };
    }
  if (best) return best;
  // The hub page itself.
  const hub = groups.find((g) => g.hub && pathname === g.hub);
  return hub ? { group: hub, link: null } : null;
}
