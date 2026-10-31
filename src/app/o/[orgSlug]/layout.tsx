import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { DesktopNav, MobileNav, type NavSection } from "@/components/shell/nav-links";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { canViewValuation } from "@/modules/inventory/valuation-queries";
import { listUserOrganizations } from "@/modules/organizations/service";
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
  const [t, user, orgs] = await Promise.all([
    getTranslations("nav"),
    getCurrentUser(),
    listUserOrganizations(ctx.userId),
  ]);
  const base = `/o/${ctx.organizationSlug}`;

  const main: NavSection = {
    items: [
      { href: base, label: t("overview"), exact: true },
      { href: `${base}/attention`, label: t("attention") },
    ],
  };
  if (holdsAnyGrant(ctx.grants, "branches.view"))
    main.items.push({ href: `${base}/branches`, label: t("branches") });
  if (holdsAnyGrant(ctx.grants, "warehouses.view"))
    main.items.push({ href: `${base}/warehouses`, label: t("warehouses") });
  const inventory: NavSection = { title: t("inventorySection"), items: [] };
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
  if (canViewValuation(ctx))
    inventory.items.push({ href: `${base}/inventory/valuation`, label: t("valuation") });
  const purchasing: NavSection = { title: t("purchasingSection"), items: [] };
  if (hasPermission(ctx.grants, "suppliers.view"))
    purchasing.items.push({ href: `${base}/suppliers`, label: t("suppliers") });
  if (
    holdsAnyGrant(ctx.grants, "purchasing.view") ||
    holdsAnyGrant(ctx.grants, "purchasing.request")
  )
    purchasing.items.push({ href: `${base}/purchasing/requisitions`, label: t("requisitions") });
  if (holdsAnyGrant(ctx.grants, "purchasing.view")) {
    purchasing.items.push(
      { href: `${base}/purchasing/orders`, label: t("purchaseOrders") },
      { href: `${base}/purchasing/receipts`, label: t("receipts") },
      { href: `${base}/purchasing/reorder`, label: t("reorder") },
    );
  }
  if (hasPermission(ctx.grants, "invoices.view"))
    purchasing.items.push(
      { href: `${base}/purchasing/invoices`, label: t("supplierInvoices") },
      { href: `${base}/purchasing/payables`, label: t("payables") },
    );
  const kitchen: NavSection = { title: t("recipesSection"), items: [] };
  if (hasPermission(ctx.grants, "recipes.view"))
    kitchen.items.push({ href: `${base}/recipes`, label: t("recipes") });
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
  const safety: NavSection = { title: t("safetySection"), items: [] };
  if (holdsAnyGrant(ctx.grants, "foodsafety.view"))
    safety.items.push(
      { href: `${base}/food-safety`, label: t("foodSafetyOverview"), exact: true },
      { href: `${base}/food-safety/records`, label: t("safetyRecords") },
      { href: `${base}/food-safety/checklists`, label: t("checklists") },
      { href: `${base}/food-safety/non-conformances`, label: t("nonConformances") },
      { href: `${base}/food-safety/checkpoints`, label: t("checkpoints") },
    );
  if (hasPermission(ctx.grants, "traceability.view"))
    safety.items.push(
      { href: `${base}/traceability`, label: t("traceability") },
      { href: `${base}/recalls`, label: t("recalls") },
    );
  const catalog: NavSection = { title: t("catalogSection"), items: [] };
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
  const settings: NavSection = { title: t("settings"), items: [] };
  if (hasPermission(ctx.grants, "org.settings.manage"))
    settings.items.push({ href: `${base}/settings/organization`, label: t("organization") });
  if (hasPermission(ctx.grants, "org.settings.manage"))
    settings.items.push(
      { href: `${base}/settings/purchasing`, label: t("purchasingSettings") },
      { href: `${base}/settings/tax`, label: t("taxSettings") },
    );
  if (hasPermission(ctx.grants, "members.view"))
    settings.items.push({ href: `${base}/settings/members`, label: t("members") });
  if (hasPermission(ctx.grants, "roles.manage"))
    settings.items.push({ href: `${base}/settings/roles`, label: t("roles") });
  if (hasPermission(ctx.grants, "audit.view"))
    settings.items.push({ href: `${base}/settings/audit`, label: t("audit") });
  const b2b: NavSection = { title: t("b2bSection"), items: [] };
  if (hasPermission(ctx.grants, "b2b.view"))
    b2b.items.push(
      { href: `${base}/b2b/orders`, label: t("salesOrders") },
      { href: `${base}/b2b/invoices`, label: t("salesInvoices") },
      { href: `${base}/b2b/balances`, label: t("customerBalances") },
      { href: `${base}/b2b/customers`, label: t("customers") },
    );
  const reports: NavSection = { title: t("reportsSection"), items: [] };
  const visible = canSeeReports(ctx);
  if (visible.foodCost)
    reports.items.push({ href: `${base}/reports/food-cost`, label: t("foodCostReport") });
  if (visible.waste) reports.items.push({ href: `${base}/reports/waste`, label: t("wasteReport") });
  const sections = [
    main,
    inventory,
    purchasing,
    kitchen,
    b2b,
    safety,
    reports,
    catalog,
    settings,
  ].filter((section) => section.items.length > 0);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-border bg-surface relative flex h-14 items-center justify-between gap-3 border-b px-4 print:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <MobileNav
            sections={sections}
            label={t("main")}
            openLabel={t("openMenu")}
            closeLabel={t("closeMenu")}
          />
          <details className="relative min-w-0">
            <summary className="hover:bg-surface-muted flex cursor-pointer list-none items-center gap-1 rounded-md px-2 py-1.5 font-semibold">
              <span className="truncate">{ctx.organizationName}</span>
              <span className="sr-only">{t("switchOrganization")}</span>
              <span aria-hidden="true" className="text-muted text-xs">
                ▾
              </span>
            </summary>
            <div className="border-border bg-surface absolute start-0 z-30 mt-1 w-64 rounded-md border p-1 shadow-md">
              <ul>
                {orgs.map((org) => (
                  <li key={org.id}>
                    <Link
                      href={`/o/${org.slug}`}
                      aria-current={org.id === ctx.organizationId ? "true" : undefined}
                      className={`hover:bg-surface-muted block truncate rounded px-3 py-2 text-sm ${org.id === ctx.organizationId ? "font-medium" : ""}`}
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
          <LocaleSwitcher />
          <span
            className="text-muted hidden max-w-40 truncate px-2 text-sm sm:inline"
            title={user?.email}
          >
            {user?.name}
          </span>
          <form action={signOutAction}>
            <button
              type="submit"
              className="hover:bg-surface-muted rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap"
            >
              {t("signOut")}
            </button>
          </form>
        </div>
      </header>
      <div className="flex flex-1">
        <DesktopNav sections={sections} label={t("main")} />
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-5xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
