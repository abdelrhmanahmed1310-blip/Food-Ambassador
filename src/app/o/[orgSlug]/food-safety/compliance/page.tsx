import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui/primitives";
import { holdsAnyGrant } from "@/modules/access/authorize";
import { branchCompliance } from "@/modules/foodsafety/compliance";
import {
  COMPLIANCE_COMPONENTS,
  COMPLIANCE_PERIODS,
  scoreBand,
} from "@/modules/foodsafety/compliance-rules";
import { requireTenant } from "@/modules/tenancy/require-tenant";

const TONES = { GOOD: "success", FAIR: "warning", POOR: "danger", NONE: "muted" } as const;

/** Compliance score per branch from recorded facts (ADR-100). */
export default async function CompliancePage({
  params,
  searchParams,
}: PageProps<"/o/[orgSlug]/food-safety/compliance">) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const ctx = await requireTenant(orgSlug);
  if (!holdsAnyGrant(ctx.grants, "foodsafety.view")) notFound();
  const requested = Number(typeof sp.days === "string" ? sp.days : 30);
  const [t, report] = await Promise.all([
    getTranslations("compliance"),
    branchCompliance(ctx, { days: requested }),
  ]);
  return (
    <>
      <PageHeader title={t("title")} description={t("hint")} />
      <div className="space-y-4">
        <nav className="flex flex-wrap gap-3 text-sm" aria-label={t("title")}>
          {COMPLIANCE_PERIODS.map((days) =>
            days === report.days ? (
              <span key={days} className="font-medium" aria-current="page">
                {t("period", { days })}
              </span>
            ) : (
              <Link
                key={days}
                href={`/o/${orgSlug}/food-safety/compliance?days=${days}`}
                className="text-primary hover:underline"
              >
                {t("period", { days })}
              </Link>
            ),
          )}
        </nav>
        {report.branches.length === 0 ? (
          <EmptyState title={t("empty")} />
        ) : (
          <Table label={t("title")}>
            <thead>
              <tr>
                <Th>{t("branch")}</Th>
                <Th>{t("score")}</Th>
                {COMPLIANCE_COMPONENTS.map((c) => (
                  <Th key={c}>{t(`components.${c}`)}</Th>
                ))}
                <Th>{t("openSerious")}</Th>
              </tr>
            </thead>
            <tbody>
              {report.branches.map((b) => {
                const band = scoreBand(b.overall);
                return (
                  <tr key={b.branch.id}>
                    <Td>
                      <span className="ltr-value font-mono text-xs">{b.branch.code}</span>
                      <span className="block">{b.branch.name}</span>
                    </Td>
                    <Td>
                      <span className="ltr-value text-lg font-semibold tabular-nums">
                        {b.overall === null ? "—" : `${b.overall} %`}
                      </span>
                      <span className="block">
                        <Badge tone={TONES[band]}>{t(`bands.${band}`)}</Badge>
                      </span>
                    </Td>
                    {b.components.map((c) => (
                      <Td key={c.key}>
                        {c.percent === null ? (
                          <span className="text-muted">{t("noData")}</span>
                        ) : (
                          <>
                            <span className="ltr-value tabular-nums">{c.percent} %</span>
                            <span className="text-muted block text-xs">
                              {t("ratio", { passed: c.passed, counted: c.counted })}
                            </span>
                          </>
                        )}
                      </Td>
                    ))}
                    <Td className="ltr-value tabular-nums">{b.openSeriousNcs}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <p className="text-muted text-xs">{t("bandsNote")}</p>
      </div>
    </>
  );
}
