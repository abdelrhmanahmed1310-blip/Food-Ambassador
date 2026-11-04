import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Bell, ChevronDown, LogOut, Search, ShieldCheck, Store } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { DesktopNav, MobileNav, type NavSection } from "@/components/shell/nav-links";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { hasEmployeeRecord } from "@/modules/hr/attendance";
import { canViewValuation } from "@/modules/inventory/valuation-queries";
import { unreadCount } from "@/modules/notifications/service";
import { listUserOrganizations } from "@/modules/organizations/service";
import { canSeeSpend } from "@/modules/procurement/spend";
import { canSeeReports } from "@/modules/analytics/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getCurrentUser } from "@/server/auth/session";
import { signOutAction } from "../../(auth)/actions";

/**
 * Tenant shell. requireTenant() resolves membership server-side and 404s for
 * non-members; navigation only hides links the user cannot use — every page
 * and action re-checks permissions itself.
 */
export default async function TenantLayout({ children, params }: LayoutProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, tn, ts, user, orgs, isEmployee, unread] = await Promise.all([
    getTranslations("nav"),
    getTranslations("notifications"),
    getTranslations("search"),
    getCurrentUser(),
    listUserOrganizations(ctx.userId),
    hasEmployeeRecord(ctx),
    unreadCount(ctx),
  ]);
  const base = `/o/${ctx.organizationSlug}`;

  const main: NavSection = {
    items: [
      { href: base, label: t("overview"), exact: true, icon: "overview" },
      { href: `${base}/attention`, label: t("attention"), icon: "attention" },
      ...(isEmployee
        ? [
            { href: `${base}/my/attendance`, label: t("myAttendance"), icon: "clock" as const },
            { href: `${base}/my/leave`, label: t("myLeave"), icon: "leave" as const },
          ]
        : []),
    ],
  };
  if (holdsAnyGrant(ctx.grants, "branches.view"))
    main.items.push({ href: `${base}/branches`, label: t("branches"), icon: "branches" });
  if (holdsAnyGrant(ctx.grants, "warehouses.view"))
    main.items.push({ href: `${base}/warehouses`, label: t("warehouses"), icon: "warehouses" });
  const pos: NavSection = { title: t("posSection"), icon: "pos", items: [] };
  if (
    holdsAnyGrant(ctx.grants, "pos.sell") ||
    holdsAnyGrant(ctx.grants, "pos.view") ||
    hasPermission(ctx.grants, "pos.manage")
  )
    pos.items.push({ href: `${base}/pos`, label: t("pos") });
  if (
    holdsAnyGrant(ctx.grants, "pos.tables") ||
    holdsAnyGrant(ctx.grants, "pos.sell") ||
    holdsAnyGrant(ctx.grants, "pos.view") ||
    hasPermission(ctx.grants, "pos.manage")
  )
    pos.items.push({ href: `${base}/pos/floor`, label: t("posFloor") });
  if (holdsAnyGrant(ctx.grants, "pos.sell"))
    pos.items.push({ href: `${base}/pos/delivery`, label: t("posDelivery") });
  if (holdsAnyGrant(ctx.grants, "pos.tables"))
    pos.items.push({ href: `${base}/pos/online`, label: t("posOnline") });
  if (holdsAnyGrant(ctx.grants, "pos.kitchen") || hasPermission(ctx.grants, "pos.manage"))
    pos.items.push({ href: `${base}/pos/kitchen`, label: t("posKitchen") });
  if (hasPermission(ctx.grants, "menu.view"))
    pos.items.push({ href: `${base}/pos/promotions`, label: t("posPromotions") });
  if (hasPermission(ctx.grants, "customers.view"))
    pos.items.push({ href: `${base}/pos/customers`, label: t("posCustomers") });
  if (hasPermission(ctx.grants, "payments.manage"))
    pos.items.push({ href: `${base}/pos/gift-cards`, label: t("posGiftCards") });
  if (holdsAnyGrant(ctx.grants, "inventory.adjust"))
    pos.items.push({ href: `${base}/pos/shortfalls`, label: t("posShortfalls") });
  if (hasPermission(ctx.grants, "payments.manage"))
    pos.items.push({ href: `${base}/pos/settlements`, label: t("posSettlements") });
  const inventory: NavSection = { title: t("inventorySection"), icon: "inventory", items: [] };
  if (holdsAnyGrant(ctx.grants, "inventory.view")) {
    inventory.items.push(
      { href: `${base}/inventory`, label: t("inventoryOverview"), exact: true },
      { href: `${base}/inventory/stock`, label: t("stock") },
      { href: `${base}/inventory/movements`, label: t("movements") },
      { href: `${base}/inventory/documents`, label: t("documents") },
      { href: `${base}/inventory/shipments`, label: t("shipments") },
      { href: `${base}/inventory/counts`, label: t("counts") },
    );
  }
  if (holdsAnyGrant(ctx.grants, "inventory.quarantine.release"))
    inventory.items.push({ href: `${base}/inventory/inspections`, label: t("inspections") });
  if (canViewValuation(ctx))
    inventory.items.push({ href: `${base}/inventory/valuation`, label: t("valuation") });
  const purchasing: NavSection = { title: t("purchasingSection"), icon: "purchasing", items: [] };
  if (hasPermission(ctx.grants, "suppliers.view"))
    purchasing.items.push({ href: `${base}/suppliers`, label: t("suppliers") });
  if (
    holdsAnyGrant(ctx.grants, "purchasing.view") ||
    holdsAnyGrant(ctx.grants, "purchasing.request")
  )
    purchasing.items.push({ href: `${base}/purchasing/requisitions`, label: t("requisitions") });
  if (holdsAnyGrant(ctx.grants, "purchasing.view")) {
    purchasing.items.push(
      { href: `${base}/purchasing/rfqs`, label: t("rfqs") },
      { href: `${base}/purchasing/orders`, label: t("purchaseOrders") },
      { href: `${base}/purchasing/receipts`, label: t("receipts") },
      { href: `${base}/purchasing/returns`, label: t("supplierReturns") },
      { href: `${base}/purchasing/reorder`, label: t("reorder") },
    );
  }
  if (hasPermission(ctx.grants, "invoices.view"))
    purchasing.items.push(
      { href: `${base}/purchasing/invoices`, label: t("supplierInvoices") },
      { href: `${base}/purchasing/payables`, label: t("payables") },
    );
  if (hasPermission(ctx.grants, "fx.manage"))
    purchasing.items.push({ href: `${base}/purchasing/exchange-rates`, label: t("exchangeRates") });
  const kitchen: NavSection = { title: t("recipesSection"), icon: "kitchen", items: [] };
  if (hasPermission(ctx.grants, "recipes.view"))
    kitchen.items.push({ href: `${base}/recipes`, label: t("recipes") });
  if (hasPermission(ctx.grants, "menu.view"))
    kitchen.items.push({ href: `${base}/menu`, label: t("menu") });
  if (holdsAnyGrant(ctx.grants, "sales.view"))
    kitchen.items.push(
      { href: `${base}/sales`, label: t("sales"), exact: true },
      { href: `${base}/sales/vat`, label: t("vatSummary") },
    );
  if (hasPermission(ctx.grants, "recipes.costs.view"))
    kitchen.items.push(
      { href: `${base}/recipes/food-cost`, label: t("foodCost") },
      { href: `${base}/recipes/simulator`, label: t("priceSimulator") },
    );
  if (hasPermission(ctx.grants, "recipes.manage"))
    kitchen.items.push({ href: `${base}/recipes/replace`, label: t("replaceIngredient") });
  if (holdsAnyGrant(ctx.grants, "production.view"))
    kitchen.items.push({ href: `${base}/production`, label: t("production") });
  if (hasPermission(ctx.grants, "recipes.view") && hasPermission(ctx.grants, "nutrition.view"))
    kitchen.items.push({ href: `${base}/recipes/allergens`, label: t("allergenMatrix") });
  const safety: NavSection = { title: t("safetySection"), icon: "safety", items: [] };
  if (holdsAnyGrant(ctx.grants, "foodsafety.view"))
    safety.items.push(
      { href: `${base}/food-safety`, label: t("foodSafetyOverview"), exact: true },
      { href: `${base}/food-safety/haccp`, label: t("haccpPlans") },
      { href: `${base}/food-safety/documents`, label: t("fsDocuments") },
      { href: `${base}/food-safety/audits`, label: t("audits") },
      { href: `${base}/food-safety/complaints`, label: t("complaints") },
      { href: `${base}/food-safety/equipment`, label: t("equipment") },
      { href: `${base}/food-safety/compliance`, label: t("compliance") },
      { href: `${base}/food-safety/records`, label: t("safetyRecords") },
      { href: `${base}/food-safety/checklists`, label: t("checklists") },
      { href: `${base}/food-safety/non-conformances`, label: t("nonConformances") },
      { href: `${base}/food-safety/checkpoints`, label: t("checkpoints") },
    );
  if (hasPermission(ctx.grants, "traceability.view"))
    safety.items.push(
      { href: `${base}/traceability`, label: t("traceability") },
      { href: `${base}/recalls`, label: t("recalls") },
      { href: `${base}/traceability/mock-recalls`, label: t("mockRecalls") },
    );
  const catalog: NavSection = { title: t("catalogSection"), icon: "catalog", items: [] };
  if (hasPermission(ctx.grants, "catalog.view")) {
    catalog.items.push(
      { href: `${base}/catalog/products`, label: t("products") },
      { href: `${base}/catalog/units`, label: t("units") },
      { href: `${base}/catalog/categories`, label: t("categories") },
    );
  }
  if (hasPermission(ctx.grants, "nutrition.view"))
    catalog.items.push({ href: `${base}/catalog/library`, label: t("ingredientLibrary") });
  if (
    hasPermission(ctx.grants, "catalog.manage") ||
    holdsAnyGrant(ctx.grants, "inventory.adjust")
  ) {
    catalog.items.push({ href: `${base}/catalog/import`, label: t("import") });
  }
  const settings: NavSection = { title: t("settings"), icon: "settings", items: [] };
  if (hasPermission(ctx.grants, "org.settings.manage"))
    settings.items.push(
      { href: `${base}/settings/organization`, label: t("organization") },
      { href: `${base}/settings/companies`, label: t("companies") },
      { href: `${base}/settings/brands`, label: t("brands") },
    );
  if (hasPermission(ctx.grants, "org.settings.manage"))
    settings.items.push(
      { href: `${base}/settings/purchasing`, label: t("purchasingSettings") },
      { href: `${base}/settings/tax`, label: t("taxSettings") },
      { href: `${base}/settings/zatca`, label: t("zatca") },
      { href: `${base}/settings/payments`, label: t("onlinePayments") },
      { href: `${base}/settings/approvals`, label: t("approvalSettings") },
      { href: `${base}/settings/jobs`, label: t("jobs") },
    );
  if (hasPermission(ctx.grants, "members.view"))
    settings.items.push({ href: `${base}/settings/members`, label: t("members") });
  if (hasPermission(ctx.grants, "roles.manage"))
    settings.items.push({ href: `${base}/settings/roles`, label: t("roles") });
  if (hasPermission(ctx.grants, "audit.view"))
    settings.items.push({ href: `${base}/settings/audit`, label: t("audit") });
  if (hasPermission(ctx.grants, "integrations.manage"))
    settings.items.push(
      { href: `${base}/settings/integrations`, label: t("integrations") },
      { href: `${base}/settings/api`, label: t("apiKeys") },
    );
  const b2b: NavSection = { title: t("b2bSection"), icon: "b2b", items: [] };
  if (hasPermission(ctx.grants, "b2b.view"))
    b2b.items.push(
      { href: `${base}/b2b/orders`, label: t("salesOrders") },
      { href: `${base}/b2b/invoices`, label: t("salesInvoices") },
      { href: `${base}/b2b/balances`, label: t("customerBalances") },
      { href: `${base}/b2b/customers`, label: t("customers") },
    );
  const hr: NavSection = { title: t("hrSection"), icon: "hr", items: [] };
  if (holdsAnyGrant(ctx.grants, "hr.view") || holdsAnyGrant(ctx.grants, "hr.manage"))
    hr.items.push(
      { href: `${base}/hr`, label: t("hrOverview"), exact: true },
      { href: `${base}/hr/employees`, label: t("employees") },
      { href: `${base}/hr/attendance`, label: t("attendance") },
      { href: `${base}/hr/leave`, label: t("leave") },
      { href: `${base}/hr/departments`, label: t("departments") },
      { href: `${base}/hr/org-chart`, label: t("orgChart") },
    );
  const reports: NavSection = { title: t("reportsSection"), icon: "reports", items: [] };
  const visible = canSeeReports(ctx);
  if (visible.foodCost)
    reports.items.push({ href: `${base}/reports/food-cost`, label: t("foodCostReport") });
  if (visible.waste) reports.items.push({ href: `${base}/reports/waste`, label: t("wasteReport") });
  // Purchasing reports (ADR-095).
  if (canSeeSpend(ctx))
    reports.items.push(
      { href: `${base}/reports/spend`, label: t("spendReport") },
      { href: `${base}/reports/price-variance`, label: t("priceVarianceReport") },
    );
  const sections = [
    main,
    pos,
    inventory,
    purchasing,
    kitchen,
    b2b,
    hr,
    safety,
    reports,
    catalog,
    settings,
  ].filter((section) => section.items.length > 0);

  return (
    <div className="flex min-h-full flex-1">
      <DesktopNav sections={sections} label={t("main")} homeHref={base} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border bg-surface/95 sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b px-4 backdrop-blur sm:px-6 print:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <MobileNav
              sections={sections}
              label={t("main")}
              openLabel={t("openMenu")}
              closeLabel={t("closeMenu")}
            />
            <Link href={base} className="shrink-0 lg:hidden">
              <Logo className="h-7 w-auto" />
            </Link>
            <details className="relative min-w-0">
              <summary className="hover:bg-surface-muted flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 font-semibold">
                <Store aria-hidden="true" className="text-primary size-4 shrink-0" />
                <span className="truncate">{ctx.organizationName}</span>
                <span className="sr-only">{t("switchOrganization")}</span>
                <ChevronDown aria-hidden="true" className="text-muted size-4 shrink-0" />
              </summary>
              <div className="border-border bg-surface absolute start-0 z-30 mt-1 w-64 rounded-lg border p-1 shadow-lg">
                <ul>
                  {orgs.map((org) => (
                    <li key={org.id}>
                      <Link
                        href={`/o/${org.slug}`}
                        aria-current={org.id === ctx.organizationId ? "true" : undefined}
                        className={`hover:bg-surface-muted block truncate rounded px-3 py-2 text-sm ${org.id === ctx.organizationId ? "text-primary font-medium" : ""}`}
                      >
                        {org.name}
                      </Link>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/organizations/new"
                  className="border-border text-primary hover:bg-surface-muted mt-1 block border-t px-3 py-2 text-sm"
                >
                  {t("newOrganization")}
                </Link>
              </div>
            </details>
          </div>
          <div className="flex items-center gap-1">
            <form method="get" action={`${base}/search`} role="search" className="hidden md:block">
              <label htmlFor="global-search" className="sr-only">
                {ts("label")}
              </label>
              <input
                id="global-search"
                name="q"
                type="search"
                minLength={2}
                maxLength={80}
                placeholder={ts("placeholder")}
                className="border-border bg-surface w-56 rounded-md border px-3 py-1.5 text-sm"
              />
            </form>
            <Link
              href={`${base}/search`}
              className="hover:bg-surface-muted rounded-md p-2 md:hidden"
              aria-label={ts("title")}
            >
              <Search aria-hidden="true" className="size-5" />
            </Link>
            <Link
              href={`${base}/notifications`}
              className="hover:bg-surface-muted relative rounded-md p-2"
              aria-label={tn("bell", { count: unread })}
              data-testid="notification-bell"
            >
              <Bell aria-hidden="true" className="size-5" />
              {unread > 0 ? (
                <span className="bg-primary absolute -end-0.5 -top-0.5 min-w-5 rounded-full px-1 text-center text-[11px] leading-5 font-semibold text-white">
                  {unread > 99 ? "99+" : unread}
                </span>
              ) : null}
            </Link>
            <LocaleSwitcher />
            <span
              className="text-muted hidden max-w-40 items-center gap-2 truncate px-2 text-sm sm:flex"
              title={user?.email}
            >
              <span
                aria-hidden="true"
                className="bg-foreground text-surface flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              >
                {(user?.name ?? "?").trim().charAt(0).toUpperCase()}
              </span>
              <span className="truncate">{user?.name}</span>
            </span>
            <Link
              href="/account/security"
              className="hover:bg-surface-muted flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap"
            >
              <ShieldCheck aria-hidden="true" className="size-4" />
              <span className="sr-only sm:not-sr-only">{t("security")}</span>
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                className="hover:bg-surface-muted flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap"
              >
                <LogOut aria-hidden="true" className="size-4" />
                <span className="sr-only sm:not-sr-only">{t("signOut")}</span>
              </button>
            </form>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
