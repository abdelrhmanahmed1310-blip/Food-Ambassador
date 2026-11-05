import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CycleForm } from "@/components/performance/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { canViewPerformance, listCycles } from "@/modules/performance/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { createCycleAction } from "./actions";
import { CYCLE_TONE } from "./status";

/** Review cycles (ADR-126). */
export default async function PerformancePage({
  params,
}: PageProps<"/o/[orgSlug]/hr/performance">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewPerformance(ctx)) notFound();
  const [t, data] = await Promise.all([getTranslations("performance"), listCycles(ctx)]);
  const branch = new Map(data.branches.map((b) => [b.id, b.code]));
  return (
    <>
      <PageHeader title={t("title")} description={t("hint")} />
      <div className="space-y-6">
        {data.cycles.length === 0 ? (
          <EmptyState title={t("noCycles")} />
        ) : (
          <Table label={t("title")}>
            <thead>
              <tr>
                <Th>{t("cycleName")}</Th>
                <Th>{t("period")}</Th>
                <Th>{t("branch")}</Th>
                <Th>{t("reviews")}</Th>
                <Th>{t("status")}</Th>
              </tr>
            </thead>
            <tbody>
              {data.cycles.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/hr/performance/${c.id}`}
                      className="text-primary hover:underline"
                    >
                      {c.name}
                    </Link>
                  </Td>
                  <Td className="ltr-value whitespace-nowrap">
                    {c.periodStart.toISOString().slice(0, 10)} →{" "}
                    {c.periodEnd.toISOString().slice(0, 10)}
                  </Td>
                  <Td>{c.branchId ? (branch.get(c.branchId) ?? "—") : t("allBranches")}</Td>
                  <Td className="tabular-nums">{c._count.reviews}</Td>
                  <Td>
                    <Badge tone={CYCLE_TONE[c.status]}>{t(`cycleStatuses.${c.status}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data.canManage ? (
          <Card title={t("createCycle")}>
            <CycleForm
              action={createCycleAction.bind(null, orgSlug)}
              branches={data.branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
