import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AttentionList } from "@/components/reports/attention-list";
import { Card, PageHeader } from "@/components/ui/primitives";
import { attentionItems } from "@/modules/analytics/attention";
import { hasPermission } from "@/modules/access/authorize";
import { getOverview } from "@/modules/organizations/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { getCurrentUser } from "@/server/auth/session";

export default async function OverviewPage({ params }: PageProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  const [t, ta, user, counts, attention] = await Promise.all([
    getTranslations("overview"),
    getTranslations("attention"),
    getCurrentUser(),
    getOverview(ctx),
    attentionItems(ctx),
  ]);
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
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="border-border bg-surface hover:bg-surface-muted rounded-lg border p-4"
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
      <p className="text-muted mt-6 text-sm">{t("modulesNote")}</p>
    </>
  );
}
