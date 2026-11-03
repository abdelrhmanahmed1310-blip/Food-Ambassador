import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { PlanAuditForm } from "@/components/foodsafety/quality-forms";
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { listAudits } from "@/modules/foodsafety/quality";
import { branchOptions } from "@/modules/foodsafety/service";
import { businessDate } from "@/modules/inventory/rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";
import { planAuditAction } from "../quality-actions";

const TONE = { PLANNED: "warning", COMPLETED: "success", CANCELLED: "muted" } as const;

export default async function AuditsPage({ params }: PageProps<"/o/[orgSlug]/food-safety/audits">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) notFound();
  const manage = holdsAnyGrant(ctx.grants, "foodsafety.manage");
  const [t, format, audits, branches] = await Promise.all([
    getTranslations(),
    getFormatter(),
    listAudits(ctx),
    manage ? branchOptions(ctx, "foodsafety.manage") : Promise.resolve([]),
  ]);
  const day = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: "medium", timeZone: "UTC" }) : "—";
  return (
    <>
      <PageHeader title={t("audits.title")} description={t("audits.hint")} />
      <div className="space-y-6">
        {audits.length === 0 ? (
          <EmptyState title={t("audits.empty")} />
        ) : (
          <Table label={t("audits.title")}>
            <thead>
              <tr>
                <Th>{t("audits.number")}</Th>
                <Th>{t("audits.branch")}</Th>
                <Th>{t("audits.type")}</Th>
                <Th>{t("audits.plannedOn")}</Th>
                <Th>{t("audits.findings")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {audits.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <Link
                      href={`/o/${orgSlug}/food-safety/audits/${a.id}`}
                      className="ltr-value text-primary font-mono text-xs hover:underline"
                    >
                      {a.number}
                    </Link>
                    <span className="text-muted block text-xs">{a.auditor}</span>
                  </Td>
                  <Td>
                    <span className="ltr-value font-mono text-xs">{a.branch.code}</span>
                  </Td>
                  <Td>{t(`audits.types.${a.type}`)}</Td>
                  <Td className={a.overdue ? "text-danger whitespace-nowrap" : "whitespace-nowrap"}>
                    {day(a.plannedOn)}
                  </Td>
                  <Td className="text-xs">
                    {a.counts
                      .filter((c) => c.count > 0)
                      .map((c) => `${c.count} ${t(`audits.severities.${c.severity}`)}`)
                      .join(" · ") || "—"}
                  </Td>
                  <Td>
                    <Badge tone={TONE[a.status]}>{t(`audits.statuses.${a.status}`)}</Badge>
                    {a.result ? <span className="text-muted block text-xs">{a.result}</span> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {manage && branches.length > 0 ? (
          <Card title={t("audits.planTitle")}>
            <PlanAuditForm
              action={planAuditAction.bind(null, orgSlug)}
              branches={branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))}
              today={businessDate(ctx.timeZone)}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
