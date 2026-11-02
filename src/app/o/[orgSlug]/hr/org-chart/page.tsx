import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { canViewHr, orgChart } from "@/modules/hr/service";
import type { OrgNode } from "@/modules/hr/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";

type Person = Awaited<ReturnType<typeof orgChart>>[number]["person"];

function Branch({
  nodes,
  base,
  onLeave,
}: {
  nodes: OrgNode<Person>[];
  base: string;
  onLeave: string;
}) {
  return (
    <ul className="border-border space-y-2 border-s ps-4">
      {nodes.map((n) => (
        <li key={n.person.id}>
          <Link
            href={`${base}/employees/${n.person.id}`}
            className="border-border bg-surface hover:border-primary inline-flex flex-col rounded-lg border px-3 py-2 shadow-sm"
            data-testid="org-node"
          >
            <span className="font-medium">
              {n.person.firstName} {n.person.lastName}
            </span>
            <span className="text-muted text-xs">
              {n.person.jobTitle} · <span className="ltr-value">{n.person.branch.code}</span>
              {n.person.status === "ON_LEAVE" ? ` · ${onLeave}` : ""}
            </span>
          </Link>
          {n.reports.length > 0 ? (
            <div className="mt-2">
              <Branch nodes={n.reports} base={base} onLeave={onLeave} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default async function OrgChartPage({ params }: PageProps<"/o/[orgSlug]/hr/org-chart">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewHr(ctx)) notFound();
  const [t, tree] = await Promise.all([getTranslations(), orgChart(ctx)]);
  return (
    <>
      <PageHeader title={t("hr.orgChart")} description={t("hr.orgChartIntro")} />
      {tree.length === 0 ? (
        <EmptyState title={t("hr.noEmployees")} />
      ) : (
        <Card>
          <Branch nodes={tree} base={`/o/${orgSlug}/hr`} onLeave={t("hr.statuses.ON_LEAVE")} />
        </Card>
      )}
    </>
  );
}
