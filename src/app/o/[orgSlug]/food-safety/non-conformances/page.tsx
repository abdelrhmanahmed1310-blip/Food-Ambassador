import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { NcStatusBadge, SeverityBadge } from "@/components/foodsafety/badges";
import { NcForm } from "@/components/foodsafety/forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listNonConformances } from "@/modules/foodsafety/nonconformances";
import { branchOptions } from "@/modules/foodsafety/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { raiseNonConformanceAction } from "../actions";

export default async function NonConformancesPage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/food-safety/non-conformances">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) notFound();
  const all = sp.all === "1";
  const canRaise = holdsAnyGrant(ctx.grants, "foodsafety.record");
  const [t, format, rows, branches] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listNonConformances(ctx, { open: !all }),
    canRaise ? branchOptions(ctx, "foodsafety.record") : Promise.resolve([]),
  ]);
  const base = `/o/${orgSlug}/food-safety/non-conformances`;
  return (
    <>
      <PageHeader title={t("foodSafety.ncTitlePlural")} description={t("foodSafety.ncHint")} />
      <div className="space-y-6">
        <nav className="flex gap-3 text-sm">
          <Link href={base} className={!all ? "font-semibold" : "text-primary hover:underline"}>
            {t("foodSafety.openOnly")}
          </Link>
          <Link
            href={`${base}?all=1`}
            className={all ? "font-semibold" : "text-primary hover:underline"}
          >
            {t("common.all")}
          </Link>
        </nav>
        {rows.length === 0 ? (
          <EmptyState title={t("foodSafety.noNcs")} />
        ) : (
          <Table label={t("foodSafety.ncTitlePlural")}>
            <thead>
              <tr>
                <Th>{t("purchasing.number")}</Th>
                <Th>{t("foodSafety.ncTitle")}</Th>
                <Th>{t("foodSafety.branch")}</Th>
                <Th>{t("foodSafety.severity")}</Th>
                <Th>{t("foodSafety.actions")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Link
                      href={`${base}/${r.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {r.number}
                    </Link>
                    <span className="text-muted block text-xs">
                      {format.dateTime(r.raisedAt, { dateStyle: "medium", timeZone: ctx.timeZone })}{" "}
                      · {t(`foodSafety.sources.${r.source}`)}
                    </span>
                  </Td>
                  <Td>{r.title}</Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{r.branch.code}</span>
                  </Td>
                  <Td>
                    <SeverityBadge severity={r.severity} />
                  </Td>
                  <Td>
                    {t("foodSafety.openActions", { count: r.openActions })}
                    {r.overdue > 0 ? (
                      <span className="mt-1 block">
                        <Badge tone="danger">
                          {t("foodSafety.overdueCount", { count: r.overdue })}
                        </Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <NcStatusBadge status={r.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {canRaise ? (
          <Card title={t("foodSafety.raiseTitle")}>
            <NcForm
              action={raiseNonConformanceAction.bind(null, orgSlug)}
              branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
