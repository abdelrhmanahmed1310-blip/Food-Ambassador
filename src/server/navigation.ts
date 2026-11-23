import "server-only";
import { getTranslations } from "next-intl/server";
import type { NavItem, NavSection } from "@/components/shell/nav-links";
import { canSeeKitchenPerformance } from "@/modules/analytics/kitchen-performance";
import { canSeeMenuEngineering } from "@/modules/analytics/menu-engineering";
import { canSeeReports } from "@/modules/analytics/service";
import { canSeeStockHealth } from "@/modules/analytics/stock";
import { hasPermission, holdsAnyGrant } from "@/modules/access/authorize";
import { pathEnabled } from "@/modules/features/access";
import { hasEmployeeRecord } from "@/modules/hr/attendance";
import { canViewValuation } from "@/modules/inventory/valuation-queries";
import { canSeeSpend } from "@/modules/procurement/spend";
import { showsMyInterviews } from "@/modules/recruitment/service";
import type { TenantContext } from "@/modules/tenancy/context";

/**
 * Every page link this person may use in the organization (ADR-139): their
 * permissions and the organization's module switches (ADR-137) decide. The
 * menu groups these by process (nav-groups.ts); Settings lists its own share.
 */
export async function navLinks(ctx: TenantContext): Promise<NavItem[]> {
  const [t, isEmployee] = await Promise.all([getTranslations("nav"), hasEmployeeRecord(ctx)]);
  const base = `/o/${ctx.organizationSlug}`;
  const main: NavSection = {
    items: [
      { href: base, label: t("overview"), exact: true, icon: "overview" },
      { href: `${base}/attention`, label: t("attention"), icon: "attention" },
      ...(isEmployee
        ? [
            { href: `${base}/my/attendance`, label: t("myAttendance"), icon: "clock" as const },
            { href: `${base}/my/roster`, label: t("myRoster"), icon: "roster" as const },
            { href: `${base}/my/leave`, label: t("myLeave"), icon: "leave" as const },
            { href: `${base}/my/payslips`, label: t("myPayslips"), icon: "payslip" as const },
            { href: `${base}/my/training`, label: t("myTraining"), icon: "training" as const },
            { href: `${base}/my/performance`, label: t("myPerformance"), icon: "goals" as const },
            { href: `${base}/my/surveys`, label: t("mySurveys"), icon: "survey" as const },
            { href: `${base}/recognition`, label: t("recognition"), icon: "recognition" as const },
            {
              href: `${base}/my/onboarding`,
              label: t("myOnboarding"),
              icon: "onboarding" as const,
            },
          ]
        : []),
    ],
  };
  // The food consultant (ADR-131).
  if (holdsAnyGrant(ctx.grants, "consultant.use"))
    main.items.push({ href: `${base}/consultant`, label: t("consultant"), icon: "consultant" });
  // Interviews to run and score (ADR-129).
  if (await showsMyInterviews(ctx))
    main.items.push({
      href: `${base}/my/interviews`,
      label: t("myInterviews"),
      icon: "interviews",
    });
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
  // POS simulator (ADR-135): practice sales and board previews, nothing recorded.
  if (holdsAnyGrant(ctx.grants, "pos.sell") || holdsAnyGrant(ctx.grants, "pos.manage"))
    pos.items.push({ href: `${base}/pos/simulator`, label: t("posSimulator") });
  if (holdsAnyGrant(ctx.grants, "pos.sell"))
    pos.items.push({ href: `${base}/pos/delivery`, label: t("posDelivery") });
  // Own riders (ADR-117).
  if (holdsAnyGrant(ctx.grants, "pos.dispatch"))
    pos.items.push({ href: `${base}/pos/dispatch`, label: t("posDispatch") });
  if (holdsAnyGrant(ctx.grants, "logistics.deliver"))
    pos.items.push({ href: `${base}/pos/rider`, label: t("myDeliveries") });
  if (holdsAnyGrant(ctx.grants, "pos.tables"))
    pos.items.push({ href: `${base}/pos/online`, label: t("posOnline") });
  if (holdsAnyGrant(ctx.grants, "pos.kitchen") || hasPermission(ctx.grants, "pos.manage"))
    pos.items.push({ href: `${base}/pos/kitchen`, label: t("posKitchen") });
  if (hasPermission(ctx.grants, "menu.view"))
    pos.items.push({ href: `${base}/pos/promotions`, label: t("posPromotions") });
  if (hasPermission(ctx.grants, "customers.view"))
    pos.items.push({ href: `${base}/pos/customers`, label: t("posCustomers") });
  // Segments and guest feedback (ADR-118).
  if (hasPermission(ctx.grants, "customers.view"))
    pos.items.push(
      { href: `${base}/pos/customers/segments`, label: t("segments") },
      { href: `${base}/pos/customers/feedback`, label: t("guestFeedback") },
      { href: `${base}/pos/customers/campaigns`, label: t("campaigns") },
    );
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
      { href: `${base}/inventory/picking`, label: t("picking") },
      { href: `${base}/inventory/loads`, label: t("loads") },
      { href: `${base}/scan`, label: t("scanner") },
    );
  }
  // Own fleet (ADR-116).
  if (holdsAnyGrant(ctx.grants, "logistics.view"))
    inventory.items.push(
      { href: `${base}/logistics/trips`, label: t("trips") },
      { href: `${base}/logistics/vehicles`, label: t("vehicles") },
    );
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
      { href: `${base}/purchasing/forecast`, label: t("demandForecast") },
    );
  }
  if (hasPermission(ctx.grants, "invoices.view"))
    purchasing.items.push(
      { href: `${base}/purchasing/invoices`, label: t("supplierInvoices") },
      { href: `${base}/purchasing/payables`, label: t("payables") },
    );
  // Import shipments (ADR-113).
  if (holdsAnyGrant(ctx.grants, "trade.view"))
    purchasing.items.push(
      { href: `${base}/trade/shipments`, label: t("importShipments") },
      { href: `${base}/trade/documents`, label: t("tradeDocuments") },
    );
  // Operating expenses (ADR-109).
  if (holdsAnyGrant(ctx.grants, "expenses.view"))
    purchasing.items.push({ href: `${base}/finance/expenses`, label: t("expenses") });
  // Branch budgets (ADR-110).
  if (holdsAnyGrant(ctx.grants, "budgets.view"))
    purchasing.items.push({ href: `${base}/finance/budgets`, label: t("budgets") });
  // Branch P&L (ADR-111).
  if (holdsAnyGrant(ctx.grants, "pnl.view"))
    purchasing.items.push({ href: `${base}/finance/pnl`, label: t("branchPnl") });
  // Consolidated P&L (ADR-112).
  if (hasPermission(ctx.grants, "pnl.consolidated.view"))
    purchasing.items.push({ href: `${base}/finance/consolidated`, label: t("consolidatedPnl") });
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
    catalog.items.push(
      { href: `${base}/nutrition`, label: t("nutritionEngine"), exact: true },
      { href: `${base}/nutrition/foods`, label: t("nutritionFoods") },
      { href: `${base}/nutrition/match`, label: t("nutritionMatch") },
      { href: `${base}/catalog/library`, label: t("ingredientLibrary") },
    );
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
      { href: `${base}/settings/modules`, label: t("modules") },
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
  if (hasPermission(ctx.grants, "assistant.manage"))
    settings.items.push({ href: `${base}/settings/assistant`, label: t("assistantSettings") });
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
      { href: `${base}/hr/rosters`, label: t("rosters") },
      { href: `${base}/hr/leave`, label: t("leave") },
      { href: `${base}/hr/onboarding`, label: t("onboarding") },
      { href: `${base}/hr/workforce`, label: t("workforce") },
      { href: `${base}/hr/analytics`, label: t("hrAnalytics") },
      { href: `${base}/hr/departments`, label: t("departments") },
      { href: `${base}/hr/org-chart`, label: t("orgChart") },
    );
  // Recruitment (ADR-129).
  if (
    holdsAnyGrant(ctx.grants, "recruitment.view") ||
    holdsAnyGrant(ctx.grants, "recruitment.manage") ||
    holdsAnyGrant(ctx.grants, "hr.manage")
  )
    hr.items.push({ href: `${base}/hr/recruitment`, label: t("recruitment") });
  // Staff surveys (ADR-127).
  if (
    holdsAnyGrant(ctx.grants, "engagement.view") ||
    holdsAnyGrant(ctx.grants, "engagement.manage")
  )
    hr.items.push({ href: `${base}/hr/engagement`, label: t("engagement") });
  // Review cycles (ADR-126).
  if (
    holdsAnyGrant(ctx.grants, "performance.view") ||
    holdsAnyGrant(ctx.grants, "performance.manage")
  )
    hr.items.push({ href: `${base}/hr/performance`, label: t("performance") });
  // Training and certificates (ADR-125).
  if (holdsAnyGrant(ctx.grants, "training.view") || holdsAnyGrant(ctx.grants, "training.manage"))
    hr.items.push({ href: `${base}/hr/learning`, label: t("training") });
  // Payroll (ADR-123): organization-level pay data.
  if (hasPermission(ctx.grants, "payroll.view"))
    hr.items.push({ href: `${base}/hr/payroll`, label: t("payroll") });
  const reports: NavSection = { title: t("reportsSection"), icon: "reports", items: [] };
  // AI assistant over the reports the person may see (ADR-122).
  if (holdsAnyGrant(ctx.grants, "assistant.use"))
    reports.items.push({ href: `${base}/assistant`, label: t("assistant") });
  // Sales analytics and targets (ADR-105).
  if (holdsAnyGrant(ctx.grants, "sales.view"))
    reports.items.push({ href: `${base}/reports/sales`, label: t("salesReport") });
  // Kitchen display performance (ADR-108).
  if (canSeeKitchenPerformance(ctx))
    reports.items.push({ href: `${base}/reports/kitchen`, label: t("kitchenReport") });
  // Menu engineering (ADR-107).
  if (canSeeMenuEngineering(ctx))
    reports.items.push({ href: `${base}/reports/menu-engineering`, label: t("menuEngineering") });
  // Stock ageing and turnover (ADR-106).
  if (canSeeStockHealth(ctx))
    reports.items.push({ href: `${base}/reports/stock`, label: t("stockHealth") });
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
  ]
    // Modules and functions the organization switched off are not offered (ADR-137).
    .map((section) => ({
      ...section,
      items: section.items.filter((i) => pathEnabled(ctx, ctx.organizationSlug, i.href)),
    }))
    .filter((section) => section.items.length > 0);
  return sections.flatMap((s) => s.items);
}
