import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { Banknote, ChefHat, Receipt, ShoppingBag, Tag, Trash2 } from "lucide-react";
import { SalesChart } from "@/components/dashboard/sales-chart";
import { AttentionList } from "@/components/reports/attention-list";
import { Card, PageHeader } from "@/components/ui/primitives";
import { attentionItems } from "@/modules/analytics/attention";
import { DASHBOARD_DAYS, salesDashboard } from "@/modules/analytics/service";
import { moneyFormatter } from "@/server/inventory-view";
import { hasPermission } from "@/modules/access/authorize";
import { getOverview } from "@/modules/organizations/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getCurrentUser } from "@/server/auth/session";

export default async function OverviewPage({ params }: PageProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, ta, td, format, money, user, counts, attention, sales] = await Promise.all([
    getTranslations("overview"),
    getTranslations("attention"),
    getTranslations("dashboard"),
    getFormatter(),
    moneyFormatter(ctx.baseCurrency).then((f) => f.money),
    getCurrentUser(),
    getOverview(ctx),
    attentionItems(ctx),
    salesDashboard(ctx),
  ]);
  const percent = (v: { toString(): string } | null) =>
    v === null
      ? "—"
      : format.number(Number(v.toString()), { style: "percent", maximumFractionDigits: 1 });
  const kpis = sales
    ? [
        { icon: Banknote, label: td("netToday"), value: money(sales.today.net), accent: true },
        { icon: Receipt, label: td("ordersToday"), value: format.number(sales.today.orders) },
        {
          icon: ShoppingBag,
          label: td("averageTicket"),
          value: sales.today.averageTicket ? money(sales.today.averageTicket) : "—",
        },
        {
          icon: Banknote,
          label: td("netPeriod", { days: DASHBOARD_DAYS }),
          value: money(sales.period.net),
        },
        ...(sales.costs
          ? [
              {
                icon: ChefHat,
                label: td("foodCost", { days: DASHBOARD_DAYS }),
                value: percent(sales.costs.foodCost),
              },
              {
                icon: Trash2,
                label: td("waste", { days: DASHBOARD_DAYS }),
                value: money(sales.costs.waste),
              },
              {
                icon: Tag,
                label: td("discounts", { days: DASHBOARD_DAYS }),
                value: money(sales.costs.discounts),
              },
            ]
          : []),
      ]
    : [];
  const topMax = sales ? Math.max(...sales.top.map((x) => Number(x.net)), 0) : 0;
  const base = `/o/${orgSlug}`;

  const stats = [
    { label: t("branches"), value: counts.branches, href: `${base}/branches` },
    { label: t("warehouses"), value: counts.warehouses, href: `${base}/warehouses` },
    { label: t("locations"), value: counts.locations, href: `${base}/warehouses` },
    ...(counts.members !== null
      ? [{ label: t("members"), value: counts.members, href: `${base}/settings/members` }]
      : []),
  ];
  const steps = [
    {
      label: t("stepBranch"),
      done: counts.branches > 0,
      href: `${base}/branches/new`,
      allowed: hasPermission(ctx.grants, "branches.manage"),
    },
    {
      label: t("stepWarehouse"),
      done: counts.warehouses > 0,
      href: `${base}/warehouses/new`,
      allowed: ctx.grants.some((g) => g.permission === "warehouses.manage"),
    },
    {
      label: t("stepInvite"),
      done: (counts.members ?? 0) > 1,
      href: `${base}/settings/members`,
      allowed: hasPermission(ctx.grants, "members.manage"),
    },
  ].filter((s) => s.allowed);

  return (
    <>
      <PageHeader
        title={t("welcome", { name: user?.name ?? "" })}
        description={ctx.organizationName}
      />
      {sales ? (
        <section aria-label={td("title")} className="mb-6 space-y-4" data-testid="sales-dashboard">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {kpis.map((k) => (
              <div
                key={k.label}
                className={`rounded-xl border p-4 shadow-sm ${k.accent ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface"}`}
              >
                <p
                  className={`flex items-center gap-2 text-xs font-medium ${k.accent ? "text-primary-foreground/85" : "text-muted"}`}
                >
                  <k.icon aria-hidden="true" className="size-4" />
                  {k.label}
                </p>
                <p className="ltr-value mt-2 text-2xl font-bold tabular-nums">{k.value}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Card title={td("chartTitle", { days: DASHBOARD_DAYS })}>
                {sales.period.orders === 0 ? (
                  <p className="text-muted text-sm">{td("noSales")}</p>
                ) : (
                  <SalesChart
                    series={sales.series.map((d) => ({
                      day: d.day,
                      orders: d.orders,
                      net: d.net.toFixed(2),
                    }))}
                    label={td("chartTitle", { days: DASHBOARD_DAYS })}
                    dayLabel={td("day")}
                    netLabel={td("net")}
                    ordersLabel={td("orders")}
                    formatMoney={(v) => money(v)}
                    formatDay={(d) =>
                      format.dateTime(new Date(`${d}T00:00:00Z`), {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      })
                    }
                  />
                )}
              </Card>
            </div>
            <Card title={td("topSellers")}>
              {sales.top.length === 0 ? (
                <p className="text-muted text-sm">{td("noSales")}</p>
              ) : (
                <ol className="space-y-3" data-testid="top-sellers">
                  {sales.top.map((x) => (
                    <li key={x.name}>
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="truncate font-medium">{x.name}</span>
                        <span className="ltr-value text-muted shrink-0 tabular-nums">
                          {money(x.net)}
                        </span>
                      </div>
                      <div className="bg-surface-muted mt-1 h-2 rounded-full">
                        <div
                          className="bg-primary h-2 rounded-full"
                          style={{
                            width: `${topMax > 0 ? Math.max(4, (Number(x.net) / topMax) * 100) : 0}%`,
                          }}
                        />
                      </div>
                      <p className="text-muted mt-0.5 text-xs">
                        {td("sold", { count: Number(x.quantity.toFixed(0)) })}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </section>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="border-border bg-surface hover:bg-surface-muted rounded-xl border p-4 shadow-sm"
          >
            <p className="text-muted text-xs">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</p>
          </Link>
        ))}
      </div>
      <div className="mt-6">
        <Card title={ta("title")}>
          <AttentionList items={attention.slice(0, 6)} base={base} currency={ctx.baseCurrency} />
          {attention.length > 6 ? (
            <Link
              href={`${base}/attention`}
              className="text-primary mt-3 inline-block text-sm hover:underline"
            >
              {ta("seeAll", { count: attention.length })}
            </Link>
          ) : null}
        </Card>
      </div>
      {steps.length > 0 ? (
        <div className="mt-6">
          <Card title={t("gettingStarted")}>
            <ol className="space-y-2">
              {steps.map((step) => (
                <li key={step.label} className="flex items-center gap-3 text-sm">
                  <span
                    aria-hidden="true"
                    className={`flex h-5 w-5 items-center justify-center rounded-full border text-xs ${step.done ? "border-success bg-success-surface text-success" : "border-border"}`}
                  >
                    {step.done ? "✓" : ""}
                  </span>
                  {step.done ? (
                    <span className="text-muted line-through">
                      {step.label} <span className="sr-only">({t("done")})</span>
                    </span>
                  ) : (
                    <Link href={step.href} className="text-primary font-medium hover:underline">
                      {step.label}
                    </Link>
                  )}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      ) : null}
    </>
  );
}
