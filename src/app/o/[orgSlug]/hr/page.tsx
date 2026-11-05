import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { CircleCheck, CircleDashed, CircleDot } from "lucide-react";
import { Badge, Card, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { canViewHr, hrOverview } from "@/modules/hr/service";
import { requireTenant } from "@/modules/tenancy/require-tenant";

/** HR capabilities and what each one has today (ADR-079). Phases are in PROJECT_PLAN.md. */
const CAPABILITIES = [
  ["hris", "AVAILABLE", "HR1"],
  ["onboarding", "PARTIAL", "HR2"],
  ["attendance", "PARTIAL", "HR2"],
  ["automation", "PARTIAL", "HR2"],
  ["recruitment", "PLANNED", "HR3"],
  ["workforce", "PLANNED", "HR3"],
  ["payroll", "PARTIAL", "HR4"],
  ["performance", "AVAILABLE", "HR5"],
  ["engagement", "AVAILABLE", "HR5"],
  ["learning", "AVAILABLE", "HR5"],
  ["analytics", "PARTIAL", "HR6"],
] as const;

const STATE = {
  AVAILABLE: { icon: CircleCheck, tone: "success" },
  PARTIAL: { icon: CircleDot, tone: "warning" },
  PLANNED: { icon: CircleDashed, tone: "muted" },
} as const;

export default async function HrPage({ params }: PageProps<"/o/[orgSlug]/hr">) {
  const { orgSlug } = await params;
  const ctx = await requireTenant(orgSlug);
  if (!canViewHr(ctx)) notFound();
  const [t, format, o] = await Promise.all([getTranslations(), getFormatter(), hrOverview(ctx)]);
  const base = `/o/${orgSlug}/hr`;
  const manage = holdsAnyGrant(ctx.grants, "hr.manage");
  const kpis = [
    { label: t("hr.kpiActive"), value: o.active, href: `${base}/employees` },
    { label: t("hr.kpiOnLeave"), value: o.onLeave, href: `${base}/employees?status=ON_LEAVE` },
    { label: t("hr.kpiNewHires"), value: o.newHires, href: `${base}/employees` },
    {
      label: t("hr.kpiDocuments"),
      value: o.documents.length,
      href: "#documents",
      alert: o.documents.some((d) => d.state === "EXPIRED"),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("hr.title")}
        description={t("hr.intro")}
        actions={
          manage ? (
            <LinkButton href={`${base}/employees/new`}>{t("hr.newEmployee")}</LinkButton>
          ) : null
        }
      />
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="hr-kpis">
          {kpis.map((k) => (
            <Link
              key={k.label}
              href={k.href}
              className={`rounded-xl border p-4 shadow-sm ${k.alert ? "border-danger/40 bg-danger-surface" : "border-border bg-surface hover:bg-surface-muted"}`}
            >
              <p className="text-muted text-xs font-medium">{k.label}</p>
              <p className="mt-2 text-2xl font-bold tabular-nums">{format.number(k.value)}</p>
            </Link>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t("hr.byBranch")}>
            {o.byBranch.length === 0 ? (
              <p className="text-muted text-sm">{t("hr.noEmployees")}</p>
            ) : (
              <ul className="divide-border divide-y text-sm">
                {o.byBranch.map((b) => (
                  <li key={b.item?.id ?? "-"} className="flex justify-between py-2">
                    <span>
                      <span className="ltr-value font-mono text-xs">{b.item?.code}</span>{" "}
                      {b.item?.name}
                    </span>
                    <span className="font-semibold tabular-nums">{b.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t("hr.byDepartment")}>
            {o.byDepartment.length === 0 ? (
              <p className="text-muted text-sm">{t("hr.noEmployees")}</p>
            ) : (
              <ul className="divide-border divide-y text-sm">
                {o.byDepartment.map((d) => (
                  <li key={d.item?.id ?? "-"} className="flex justify-between py-2">
                    <span>{d.item ? d.item.name : t("hr.noDepartment")}</span>
                    <span className="font-semibold tabular-nums">{d.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div id="documents">
          <Card title={t("hr.expiringDocuments", { days: 30 })}>
            {o.documents.length === 0 ? (
              <p className="text-muted text-sm">{t("hr.noExpiring")}</p>
            ) : (
              <Table label={t("hr.expiringDocuments", { days: 30 })}>
                <thead>
                  <tr>
                    <Th>{t("hr.employee")}</Th>
                    <Th>{t("hr.documentType")}</Th>
                    <Th>{t("hr.expiresOn")}</Th>
                    <Th>{t("hr.state")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {o.documents.map((d) => (
                    <tr key={d.id} data-testid="expiring-document">
                      <Td>
                        <Link
                          href={`${base}/employees/${d.employee.id}`}
                          className="text-primary hover:underline"
                        >
                          {d.employee.firstName} {d.employee.lastName}
                        </Link>{" "}
                        <span className="ltr-value text-muted font-mono text-xs">
                          {d.employee.number}
                        </span>
                      </Td>
                      <Td>{t(`hr.documentTypes.${d.type}`)}</Td>
                      <Td className="ltr-value">{d.expiresOn}</Td>
                      <Td>
                        <Badge tone={d.state === "EXPIRED" ? "danger" : "warning"}>
                          {t(`hr.documentStates.${d.state}`)}
                        </Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <Card title={t("hr.capabilities")}>
          <p className="text-muted mb-4 text-sm">{t("hr.capabilitiesIntro")}</p>
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="hr-capabilities">
            {CAPABILITIES.map(([key, state, phase]) => {
              const s = STATE[state];
              return (
                <li key={key} className="border-border flex gap-3 rounded-lg border p-3">
                  <s.icon
                    aria-hidden="true"
                    className={`mt-0.5 size-5 shrink-0 ${state === "AVAILABLE" ? "text-success" : state === "PARTIAL" ? "text-primary" : "text-muted"}`}
                  />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {t(`hr.capability.${key}.title`)}
                      <Badge tone={s.tone}>{t(`hr.capabilityStates.${state}`, { phase })}</Badge>
                    </p>
                    <p className="text-muted mt-0.5 text-sm">{t(`hr.capability.${key}.text`)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
