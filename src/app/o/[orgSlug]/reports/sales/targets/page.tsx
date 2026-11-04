import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { businessDate } from "@/modules/inventory/rules";
import { canSeeSales, listTargets } from "@/modules/analytics/sales";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { setTargetsAction } from "./actions";
import { TargetsForm } from "./targets-form";

/** Monthly net sales targets per branch, set by you (ADR-105). */
export default async function SalesTargetsPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/reports/sales/targets">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!canSeeSales(ctx)) notFound();
  const current = Number(businessDate(ctx.timeZone).slice(0, 4));
  const year = typeof sp.year === "string" && /^\d{4}$/.test(sp.year) ? Number(sp.year) : current;
  const [t, grid] = await Promise.all([getTranslations("salesReport"), listTargets(ctx, year)]);
  const base = `/o/${orgSlug}/reports/sales/targets`;
  return (
    <>
      <PageHeader title={t("targetsTitle", { year })} description={t("targetsHint")} />
      <div className="space-y-6">
        <nav className="flex gap-4 text-sm" aria-label={t("year")}>
          <Link href={`${base}?year=${year - 1}`} className="text-primary hover:underline">
            {year - 1}
          </Link>
          <span className="font-medium" aria-current="page">
            {year}
          </span>
          <Link href={`${base}?year=${year + 1}`} className="text-primary hover:underline">
            {year + 1}
          </Link>
        </nav>
        {grid.branches.length === 0 ? (
          <EmptyState title={t("empty")} />
        ) : (
          grid.branches.map((b) => (
            <Card key={b.id} title={`${b.code} — ${b.name}`}>
              <TargetsForm
                action={setTargetsAction.bind(null, orgSlug, b.id, year)}
                currency={b.currency}
                disabled={!grid.canManage}
                values={Object.fromEntries(
                  Object.entries(b.months).map(([mm, v]) => [mm, v.amount.toFixed(2)]),
                )}
              />
            </Card>
          ))
        )}
      </div>
    </>
  );
}
